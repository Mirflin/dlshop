import { MODULE_ID, t } from "./config.mjs";
import {
  api, characterIdOf, compendiumItemFor, connection, gameIdOf, linkOf, uploadUrl
} from "./dogmaliter.mjs";

/**
 * Pulling items out of a DogmaLiter character's bag into the linked Foundry actor.
 *
 * The item MOVES: the GM's client checks the bag entry on DogmaLiter, creates the item on the actor
 * (from the DogmaLiter compendium, importing it there first if needed), and only then removes the
 * entry from the web bag. If the web removal fails, the new Foundry item is deleted again, so an item
 * is never lost.
 *
 * A pulled item is active for the "dlPullHours" setting (2 hours by default, real time). After that it
 * is inactive: greyed out on the sheet, can't be rolled or sold in a shop, until a GM reactivates it.
 * The timer lives in `flags.dlshop.pull` {entryId, characterId, gameId, pulledAt, expiresAt}.
 */

/* -------------------------------------------- */
/*  Timer state                                 */
/* -------------------------------------------- */

/** The pull record of an item, or null if it was not pulled from DogmaLiter. */
export function pullOf(item) {
  return item?.getFlag?.(MODULE_ID, "pull") ?? null;
}

/** Has a pulled item's time run out? Items that were not pulled are never inactive. */
export function isInactive(item, now=Date.now()) {
  const pull = pullOf(item);
  return !!pull && (now >= Number(pull.expiresAt));
}

/** How long a pulled item stays active, in milliseconds. */
export function activeDuration() {
  const hours = Number(game.settings.get(MODULE_ID, "dlPullHours")) || 2;
  return Math.max(0.25, hours) * 60 * 60 * 1000;
}

/** "1:05" (hours:minutes) left until `expiresAt`, rounded up to the minute. */
export function formatRemaining(expiresAt, now=Date.now()) {
  const minutes = Math.max(0, Math.ceil((Number(expiresAt) - now) / 60000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** GM: give a pulled item a fresh active period. */
export async function reactivate(item) {
  if ( !game.user.isGM ) return;
  await item.update({[`flags.${MODULE_ID}.pull.expiresAt`]: Date.now() + activeDuration()});
  ui.notifications.info(t("Pull.Reactivated", {item: item.name, time: formatRemaining(Date.now() + activeDuration())}));
}

/* -------------------------------------------- */
/*  The web bag                                 */
/* -------------------------------------------- */

/**
 * The linked character's bag as the current user can see it (their own character, or any for a GM).
 * Equipped items are left out: only what is in the bag can be pulled.
 * @returns {Promise<object[]>}  DogmaLiter inventory entries ({id, quantity, durability, ..., item}).
 */
export async function fetchBag(actor) {
  const characterId = characterIdOf(actor);
  const gameId = gameIdOf(actor);
  if ( !characterId || !gameId ) throw new Error(t("DL.Error.NoCharacterId", {actor: actor.name}));
  const {character} = await api("GET", `/games/${encodeURIComponent(gameId)}/characters/${encodeURIComponent(characterId)}`);
  const equipped = new Set((character?.equipment ?? []).map(e => e.inventory_item_id).filter(Boolean));
  return (character?.inventory ?? []).filter(e => !equipped.has(e.id));
}

/** Display data for a bag entry. */
export function bagEntryView(entry) {
  const item = entry.item ?? {};
  const durability = (entry.max_durability != null) ? `${entry.durability ?? entry.max_durability}/${entry.max_durability}` : "";
  return {
    id: entry.id,
    name: item.name ?? "?",
    img: item.image_id ? uploadUrl(item.image_id) : "icons/svg/item-bag.svg",
    quantity: entry.quantity ?? 1,
    rarity: item.rarity ?? "",
    category: item.category ?? "",
    durability,
    enchantment: entry.enchantment ? `${entry.enchantment > 0 ? "+" : ""}${entry.enchantment}` : ""
  };
}

/* -------------------------------------------- */
/*  Pulling (runs on the GM)                    */
/* -------------------------------------------- */

/**
 * Move a bag entry from DogmaLiter onto the actor. Called on the active GM's client, which holds a
 * DogmaLiter login that may read and edit any character of the game.
 * @param {Actor} actor
 * @param {string} entryId   The DogmaLiter inventory entry id.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function pullEntry(actor, entryId) {
  if ( !connection().loggedIn ) return {ok: false, message: t("Pull.Error.GMNotLoggedIn")};
  const characterId = characterIdOf(actor);
  const gameId = gameIdOf(actor);
  if ( !characterId || !gameId ) return {ok: false, message: t("DL.Error.NoCharacterId", {actor: actor.name})};

  // 1. The entry must really be in the bag (checked with the GM's login, not trusted from the player).
  const bag = await fetchBag(actor);
  const entry = bag.find(e => e.id === entryId);
  if ( !entry?.item ) return {ok: false, message: t("Pull.Error.NotInBag")};

  // 2. The compendium item (imported now if this item was never imported before).
  const source = await compendiumItemFor(entry.item);

  // 3. Create the Foundry item on the actor, with its timer.
  const data = source.toObject();
  for ( const key of ["_id", "folder", "sort", "ownership"] ) delete data[key];
  const quantity = Math.max(1, Number(entry.quantity) || 1);
  // Item types with a quantity field (template.json) get the stack size; others get one copy per unit.
  const stacks = (foundry.utils.getProperty(data, "system.quantity") !== undefined)
    || (foundry.utils.getProperty(game.model?.Item?.[data.type] ?? {}, "quantity") !== undefined);
  if ( stacks ) foundry.utils.setProperty(data, "system.quantity", quantity);
  const now = Date.now();
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.pull`, {
    entryId: entry.id, characterId, gameId, pulledAt: now, expiresAt: now + activeDuration()
  });
  foundry.utils.mergeObject(data, {flags: {[MODULE_ID]: {dogmaliter: {
    durability: entry.durability ?? null, maxDurability: entry.max_durability ?? null, enchantment: entry.enchantment ?? 0
  }}}});
  foundry.utils.setProperty(data, "_stats.compendiumSource", source.uuid);
  const copies = stacks ? 1 : Math.min(quantity, 50);
  const createdItems = await actor.createEmbeddedDocuments("Item", Array.from({length: copies}, () => foundry.utils.deepClone(data)));
  const created = createdItems[0];

  // 4. Remove it from the web bag. If that fails, take the Foundry copy back so nothing is duplicated.
  try {
    await api("DELETE", `/games/${encodeURIComponent(gameId)}/characters/${encodeURIComponent(characterId)}/inventory/${encodeURIComponent(entry.id)}`);
  }
  catch(err) {
    for ( const item of createdItems ) await item.delete();
    throw err;
  }
  return {ok: true, message: t("Pull.Pulled", {
    item: created.name, qty: entry.quantity ?? 1, actor: actor.name, time: formatRemaining(now + activeDuration())
  })};
}

/* -------------------------------------------- */
/*  Character sheet                             */
/* -------------------------------------------- */

/**
 * Mark pulled items on the DogmaLiter character sheet's Inventory page: a countdown, or "inactive"
 * (greyed out) once the time is up, with a reactivate button for the GM. Also adds the
 * "Pull from bag" button for linked actors.
 */
export function decorateSheet(app, html, openBag) {
  const actor = app.document ?? app.actor;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const tab = root?.querySelector(".r20-inventory");
  if ( !(actor instanceof Actor) || !tab ) return;

  for ( const row of tab.querySelectorAll(".r20-inv-row[data-item-id]") ) {
    const item = actor.items.get(row.dataset.itemId);
    const pull = pullOf(item);
    if ( !pull || row.querySelector(".dlshop-pull-badge") ) continue;
    const badge = document.createElement("span");
    badge.className = "dlshop-pull-badge";
    badge.dataset.expires = pull.expiresAt;
    row.querySelector(".r20-inv-name")?.append(badge);
    if ( game.user.isGM ) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "r20-icon-button dlshop-pull-reactivate";
      button.dataset.tooltip = t("Pull.Reactivate");
      button.setAttribute("aria-label", t("Pull.Reactivate"));
      button.innerHTML = `<i class="fa-solid fa-rotate-right"></i>`;
      button.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        reactivate(item);
      });
      row.querySelector(".r20-inv-controls")?.prepend(button);
    }
  }
  updateBadges(tab);

  if ( characterIdOf(actor) && actor.isOwner && !tab.querySelector(".dlshop-pull-open") ) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "r20-button dlshop-pull-open";
    button.innerHTML = `<i class="fa-solid fa-sack-xmark"></i> ${t("Pull.OpenBag", {character: foundry.utils.escapeHTML(linkOf(actor)?.characterName ?? "")})}`;
    button.addEventListener("click", ev => {
      ev.preventDefault();
      openBag(actor);
    });
    tab.append(button);
  }
}

/** Refresh countdown badges (in `root`, or everywhere) without re-rendering any sheet. */
export function updateBadges(root=document) {
  const now = Date.now();
  for ( const badge of root.querySelectorAll(".dlshop-pull-badge[data-expires]") ) {
    const inactive = now >= Number(badge.dataset.expires);
    badge.classList.toggle("inactive", inactive);
    badge.innerHTML = inactive
      ? `<i class="fa-solid fa-lock"></i> ${t("Pull.Inactive")}`
      : `<i class="fa-solid fa-hourglass-half"></i> ${formatRemaining(badge.dataset.expires, now)}`;
    badge.dataset.tooltip = inactive ? t("Pull.InactiveHint") : t("Pull.ActiveHint");
    badge.closest(".r20-inv-row")?.classList.toggle("dlshop-pull-inactive", inactive);
  }
}
