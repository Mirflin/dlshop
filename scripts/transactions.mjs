import { MODULE_ID, SOCKET, t } from "./config.mjs";
import { addTo, coinsText, getPurse, payFrom, setPurse } from "./currency.mjs";
import {
  findWareByName, getShop, giveItem, getQuantity, isOutsideHours, sellPrice, takeItem, updateShop
} from "./store.mjs";
import { recordHistory } from "./history.mjs";
import { characterIdOf, linkOf, sendItemToInventory, sendProblem } from "./dogmaliter.mjs";
import { askSendApproval } from "./approvals.mjs";

/**
 * Buying and selling changes the shop's stock (a world setting) and actors the player may not own,
 * so every transaction is executed by the active GM. Players send requests over the module socket.
 *
 * Sending an item to the DogmaLiter web inventory also runs on the GM, but first waits for the GM to
 * approve it, so it is handled outside the transaction queue (shop trades must not wait on the GM).
 */

const pending = new Map();
let queue = Promise.resolve();

export function registerSocket() {
  game.socket.on(SOCKET, async msg => {
    if ( msg.type === "request" ) {
      if ( !game.users.activeGM?.isSelf ) return;
      const result = msg.op === "sendItem"
        ? await handleSendRequest(msg.data, msg.userId)
        : await enqueue(msg.op, msg.data, msg.userId);
      game.socket.emit(SOCKET, {type: "response", requestId: msg.requestId, userId: msg.userId, result});
    }
    else if ( (msg.type === "response") && (msg.userId === game.userId) ) {
      pending.get(msg.requestId)?.(msg.result);
      pending.delete(msg.requestId);
    }
  });
}

/** Buy `qty` units of a ware for the given actor. */
export function requestBuy(shopId, wareId, actorUuid, qty) {
  return request("buy", {shopId, wareId, actorUuid, qty});
}

/** Sell `qty` units of an owned item to the shop. */
export function requestSell(shopId, itemUuid, qty) {
  return request("sell", {shopId, itemUuid, qty});
}

/**
 * Send an owned item to the DogmaLiter web inventory. A player's request waits for the GM to approve
 * it; the GM's own sends go straight through.
 */
export function requestSendItem(itemUuid) {
  return request("sendItem", {itemUuid}, {timeout: 30 * 60 * 1000});
}

async function request(op, data, {timeout=15000}={}) {
  let result;
  if ( game.users.activeGM?.isSelf ) {
    result = op === "sendItem" ? await handleSendRequest(data, game.userId) : await enqueue(op, data, game.userId);
  }
  else if ( !game.users.activeGM ) result = {ok: false, message: t("Error.NoGM")};
  else {
    if ( op === "sendItem" ) ui.notifications.info(t("Approval.Waiting"));
    const requestId = foundry.utils.randomID();
    result = await new Promise(resolve => {
      pending.set(requestId, resolve);
      game.socket.emit(SOCKET, {type: "request", requestId, userId: game.userId, op, data});
      setTimeout(() => {
        if ( !pending.has(requestId) ) return;
        pending.delete(requestId);
        resolve({ok: false, message: t("Error.Timeout")});
      }, timeout);
    });
  }
  if ( result.ok ) ui.notifications.info(result.message);
  else ui.notifications.warn(result.message);
  return result;
}

/** Run transactions one at a time so concurrent purchases can't oversell stock. */
function enqueue(op, data, userId) {
  const run = queue.then(() => execute(op, data, userId)).catch(err => {
    console.error(`${MODULE_ID} | Transaction failed`, err);
    return {ok: false, message: t("Error.Generic")};
  });
  queue = run;
  return run;
}

async function execute(op, data, userId) {
  const user = game.users.get(userId);
  const shop = getShop(data.shopId);
  if ( !user || !shop ) return {ok: false, message: t("Error.NoShop")};
  if ( !shop.open && !user.isGM ) return {ok: false, message: t("Error.Closed", {shop: shop.name})};
  if ( isOutsideHours(shop) && !user.isGM ) {
    return {ok: false, message: t("Error.OutsideHours", {shop: shop.name, from: shop.hours.from, to: shop.hours.to})};
  }
  const qty = Math.floor(Number(data.qty));
  if ( !(qty > 0) ) return {ok: false, message: t("Error.Quantity")};
  if ( op === "buy" ) return buy(shop, data, qty, user);
  if ( op === "sell" ) return sell(shop, data, qty, user);
  return {ok: false, message: t("Error.Generic")};
}

/* -------------------------------------------- */
/*  Send to DogmaLiter (with GM approval)       */
/* -------------------------------------------- */

/** Items currently waiting for the GM's answer, so the same item can't be queued twice. */
const awaitingApproval = new Set();

async function handleSendRequest({itemUuid}, userId) {
  const user = game.users.get(userId);
  let item = await fromUuid(itemUuid);
  const actor = item?.parent;
  if ( !user || !(actor instanceof Actor) || !actor.testUserPermission(user, "OWNER") ) {
    return {ok: false, message: t("Error.NotOwner")};
  }
  const problem = sendProblem(item);
  if ( problem ) return {ok: false, message: problem};

  if ( !user.isGM ) {
    if ( awaitingApproval.has(itemUuid) ) return {ok: false, message: t("Approval.AlreadyWaiting", {item: item.name})};
    awaitingApproval.add(itemUuid);
    let approved;
    try {
      approved = await askSendApproval({
        user, actor, item,
        quantity: Math.clamp(getQuantity(item), 1, 9999),
        character: linkOf(actor)?.characterName || characterIdOf(actor)
      });
    }
    finally {
      awaitingApproval.delete(itemUuid);
    }
    if ( !approved ) return {ok: false, message: t("Approval.Declined", {item: item.name})};
    // The item may have changed or gone while the GM was deciding.
    item = await fromUuid(itemUuid);
    if ( !item ) return {ok: false, message: t("Approval.Gone")};
  }

  let result;
  try {
    result = await sendItemToInventory(item);
  }
  catch(err) {
    console.error(`${MODULE_ID} | DogmaLiter send failed`, err);
    result = {ok: false, message: t("DL.Error.Send", {item: item.name, error: err.message})};
  }
  // The GM also sees how an approved request ended.
  if ( !user.isGM ) ui.notifications[result.ok ? "info" : "warn"](result.message);
  return result;
}

async function buy(shop, {wareId, actorUuid}, qty, user) {
  const actor = await fromUuid(actorUuid);
  if ( !actor?.testUserPermission(user, "OWNER") ) return {ok: false, message: t("Error.NotOwner")};
  const ware = shop.wares.find(w => w.id === wareId);
  if ( !ware || (!ware.enabled && !user.isGM) ) return {ok: false, message: t("Error.NoWare")};
  if ( !ware.infinite && (ware.quantity < qty) ) return {ok: false, message: t("Error.OutOfStock", {item: ware.name})};

  const cost = ware.price * qty;
  const purse = payFrom(getPurse(actor), cost);
  if ( !purse ) return {ok: false, message: t("Error.TooPoor", {actor: actor.name, item: ware.name})};

  await setPurse(actor, purse);
  await giveItem(actor, ware.data, qty);
  if ( !ware.infinite ) {
    await updateShop(shop.id, s => {
      const w = s.wares.find(w => w.id === wareId);
      if ( !w ) return false;
      w.quantity = Math.max(0, w.quantity - qty);
    });
  }
  await recordHistory(shop.id, {
    type: "buy", userName: user.name, actorName: actor.name, itemName: ware.name, img: ware.img, qty, total: cost
  });
  return {ok: true, message: t("Bought", {actor: actor.name, qty, item: ware.name, cost: coinsText(cost)})};
}

async function sell(shop, {itemUuid}, qty, user) {
  const item = await fromUuid(itemUuid);
  const actor = item?.parent;
  if ( !(actor instanceof Actor) || !actor.testUserPermission(user, "OWNER") ) {
    return {ok: false, message: t("Error.NotOwner")};
  }
  const price = sellPrice(shop, item);
  if ( price === null ) return {ok: false, message: t("Error.WontBuy", {shop: shop.name, item: item.name})};
  if ( getQuantity(item) < qty ) return {ok: false, message: t("Error.Quantity")};

  const name = item.name;
  const img = item.img;
  const earned = price * qty;
  await takeItem(item, qty);
  await setPurse(actor, addTo(getPurse(actor), earned));

  // Items the shop also sells go back on the shelf.
  const ware = findWareByName(shop, name);
  if ( ware && !ware.infinite ) {
    await updateShop(shop.id, s => {
      const w = s.wares.find(w => w.id === ware.id);
      if ( !w ) return false;
      w.quantity += qty;
    });
  }
  await recordHistory(shop.id, {
    type: "sell", userName: user.name, actorName: actor.name, itemName: name, img, qty, total: earned
  });
  return {ok: true, message: t("Sold", {actor: actor.name, qty, item: name, earned: coinsText(earned)})};
}
