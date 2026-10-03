import { MODULE_ID } from "./config.mjs";

/**
 * Purchase history: every purchase and sale made in a shop, newest first, kept in the world setting
 * "history" as {shopId: entry[]}. Written by the GM, who runs all transactions.
 *
 * @typedef HistoryEntry
 * @property {string} id
 * @property {number} time        Real time (ms since epoch).
 * @property {"buy"|"sell"} type   "buy": the customer bought from the shop; "sell": sold to it.
 * @property {string} userName
 * @property {string} actorName
 * @property {string} itemName
 * @property {string} img
 * @property {number} qty
 * @property {number} total       In the smallest coin.
 */

/** Entries kept per shop; older ones are dropped. */
const LIMIT = 500;

export function getHistory(shopId) {
  return game.settings.get(MODULE_ID, "history")?.[shopId] ?? [];
}

export async function recordHistory(shopId, entry) {
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "history") ?? {});
  const list = all[shopId] ?? [];
  list.unshift({id: foundry.utils.randomID(), time: Date.now(), ...entry});
  all[shopId] = list.slice(0, LIMIT);
  return game.settings.set(MODULE_ID, "history", all);
}

export async function clearHistory(shopId) {
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "history") ?? {});
  delete all[shopId];
  return game.settings.set(MODULE_ID, "history", all);
}
