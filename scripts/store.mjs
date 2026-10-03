import { MODULE_ID } from "./config.mjs";

/* -------------------------------------------- */
/*  Shop records                                */
/* -------------------------------------------- */

/**
 * @typedef ShopWare      An item the shop sells.
 * @property {string} id
 * @property {string} name
 * @property {string} img
 * @property {string} type
 * @property {string} sourceUuid  The item it was copied from.
 * @property {number} price       In the smallest coin.
 * @property {number} quantity    Units in stock (ignored when infinite).
 * @property {boolean} infinite
 * @property {boolean} enabled     Disabled wares are hidden from customers.
 * @property {string} badge       Short label shown on the ware, e.g. "NEW".
 * @property {string} rank        Item grade shown on the ware, e.g. "S".
 * @property {object} data        Item source data used to create the purchased item.
 *
 * @typedef ShopWant      An item the shop is willing to buy (matched by name).
 * @property {string} id
 * @property {string} name
 * @property {string} img
 * @property {number} price       In the smallest coin.
 */

/** Default values for a new shop. */
export function defaultShop() {
  return {
    id: foundry.utils.randomID(),
    name: game.i18n.localize("DLSHOP.NewShop"),
    subtitle: "",
    slogan: "",
    description: "",
    actorId: "",
    background: "",
    music: "",
    greeting: "",
    volume: 0.5,
    range: 2,
    open: true,
    // Real-time opening hours ("HH:MM", the viewer's clock); off by default.
    hours: {enabled: false, from: "09:00", to: "18:00"},
    buyBack: true,
    // Show customers a phrase ("A few left") instead of the exact stock count.
    vagueStock: false,
    sellRatio: 0.5,
    wares: [],
    wants: []
  };
}

/** Fill in fields added in later versions. */
function normalize(stored) {
  const shop = foundry.utils.mergeObject(defaultShop(), stored);
  shop.wares = shop.wares.map(w => ({
    badge: "", rank: "", enabled: true, sourceUuid: "", ...w,
    infinite: w.infinite ?? (w.quantity < 0),
    quantity: Math.max(0, Number(w.quantity) || 0)
  }));
  return shop;
}

/* -------------------------------------------- */
/*  Opening hours                               */
/* -------------------------------------------- */

const toMinutes = time => {
  const [h, m] = String(time ?? "").split(":").map(Number);
  return ((h || 0) * 60) + (m || 0);
};

/** Are the shop's opening hours limited, and is `now` outside them? */
export function isOutsideHours(shop, now=new Date()) {
  const hours = shop.hours;
  if ( !hours?.enabled ) return false;
  const from = toMinutes(hours.from);
  const to = toMinutes(hours.to);
  if ( from === to ) return false;
  const current = (now.getHours() * 60) + now.getMinutes();
  // A range like 22:00–02:00 runs past midnight.
  const inside = from < to ? ((current >= from) && (current < to)) : ((current >= from) || (current < to));
  return !inside;
}

/** Can customers trade with the shop right now? */
export function isOpenNow(shop, now=new Date()) {
  return !!shop.open && !isOutsideHours(shop, now);
}

/* -------------------------------------------- */
/*  Stock wording                               */
/* -------------------------------------------- */

/** Smallest stock count for each phrase, largest first. */
const STOCK_WORDS = [[20, "Plenty"], [10, "Decent"], [5, "Some"], [2, "Few"], [1, "One"]];

/** The phrase key (under DLSHOP.StockWords) describing a stock count without giving the number. */
export function stockWordKey(quantity) {
  return STOCK_WORDS.find(([min]) => quantity >= min)?.[1] ?? "None";
}

/** @returns {Record<string, object>} All shops keyed by id. */
export function getShops() {
  const shops = foundry.utils.deepClone(game.settings.get(MODULE_ID, "shops") ?? {});
  for ( const [id, shop] of Object.entries(shops) ) shops[id] = normalize(shop);
  return shops;
}

export function getShop(id) {
  return getShops()[id] ?? null;
}

/** Find the shop run by a given (base) actor id. */
export function getShopForActor(actorId) {
  if ( !actorId ) return null;
  return Object.values(getShops()).find(s => s.actorId === actorId) ?? null;
}

let saving = Promise.resolve();

/**
 * Load a shop, change it and save it. Edits are queued so quick successive changes can't overwrite
 * each other. Return false from `fn` to skip saving.
 * @param {string} id
 * @param {(shop: object) => (boolean|void|Promise<boolean|void>)} fn
 * @returns {Promise<object|null>} The updated shop.
 */
export function updateShop(id, fn) {
  const run = saving.then(async () => {
    const shop = getShop(id);
    if ( !shop ) return null;
    if ( (await fn(shop)) !== false ) await saveShop(shop);
    return shop;
  });
  saving = run.catch(err => console.error(`${MODULE_ID} | Failed to save shop`, err));
  return run;
}

export async function saveShop(shop) {
  const shops = getShops();
  shops[shop.id] = shop;
  return game.settings.set(MODULE_ID, "shops", shops);
}

export async function deleteShop(id) {
  const shops = getShops();
  delete shops[id];
  return game.settings.set(MODULE_ID, "shops", shops);
}

/* -------------------------------------------- */
/*  Item quantities                             */
/* -------------------------------------------- */

const QUANTITY = "system.quantity";

/** Does this item (or item source) track a stack quantity? */
function hasQuantity(itemOrData) {
  return foundry.utils.getProperty(itemOrData, QUANTITY) !== undefined;
}

export function getQuantity(item) {
  if ( !hasQuantity(item) ) return 1;
  return Number(foundry.utils.getProperty(item, QUANTITY)) || 0;
}

/** Give an actor `qty` copies of an item, stacking onto an existing item with the same name when possible. */
export async function giveItem(actor, data, qty) {
  const path = QUANTITY;
  if ( hasQuantity(data) ) {
    const existing = actor.items.find(i => (i.name === data.name) && (i.type === data.type) && hasQuantity(i));
    if ( existing ) return existing.update({[path]: getQuantity(existing) + qty});
    const created = foundry.utils.deepClone(data);
    foundry.utils.setProperty(created, path, qty);
    return actor.createEmbeddedDocuments("Item", [created]);
  }
  return actor.createEmbeddedDocuments("Item", Array.from({length: qty}, () => foundry.utils.deepClone(data)));
}

/** Remove `qty` units of an owned item. */
export async function takeItem(item, qty) {
  const remaining = getQuantity(item) - qty;
  if ( hasQuantity(item) && (remaining > 0) ) return item.update({[QUANTITY]: remaining});
  return item.delete();
}

/** Item source data suitable for storing in a shop. */
export function itemSnapshot(item) {
  const data = item.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  foundry.utils.setProperty(data, "_stats.compendiumSource", item.uuid.startsWith("Compendium.") ? item.uuid : null);
  return data;
}

/* -------------------------------------------- */
/*  Pricing                                     */
/* -------------------------------------------- */

const norm = s => String(s ?? "").trim().toLowerCase();

/** What will this shop pay for one unit of the given owned item? Returns null if it won't buy it. */
export function sellPrice(shop, item) {
  const want = shop.wants.find(w => norm(w.name) === norm(item.name));
  if ( want ) return want.price;
  if ( shop.buyBack ) {
    const ware = shop.wares.find(w => norm(w.name) === norm(item.name));
    if ( ware ) return Math.floor(ware.price * shop.sellRatio);
  }
  return null;
}

export function findWareByName(shop, name) {
  return shop.wares.find(w => norm(w.name) === norm(name));
}
