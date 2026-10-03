import { MODULE_ID } from "./config.mjs";

/**
 * Three-tier coinage (gold / silver / bronze by default). All prices are stored as a whole number
 * of the smallest coin; each actor's purse is stored per denomination in its module flags and
 * edited from the coin row this module adds to the actor sheet.
 */

const setting = key => game.settings.get(MODULE_ID, key);

/**
 * A coin's display name: the GM's own name for it, or else the name in the user's language. The old
 * English defaults ("Gold"...) count as "not set", so worlds saved with them still get translated.
 */
function coinName(key, englishDefault) {
  const value = String(setting(key) ?? "").trim();
  if ( value && (value !== englishDefault) ) return value;
  return game.i18n.localize(`DLSHOP.Coins.${englishDefault}`);
}

/** Denominations from most to least valuable. `value` is worth in the smallest coin. */
export function denominations() {
  const silverPerGold = Math.max(1, Math.floor(setting("silverPerGold")) || 10);
  const bronzePerSilver = Math.max(1, Math.floor(setting("bronzePerSilver")) || 10);
  return [
    {key: "gold", name: coinName("coinGold", "Gold"), value: silverPerGold * bronzePerSilver},
    {key: "silver", name: coinName("coinSilver", "Silver"), value: bronzePerSilver},
    {key: "bronze", name: coinName("coinBronze", "Bronze"), value: 1}
  ];
}

/* -------------------------------------------- */
/*  Amounts                                     */
/* -------------------------------------------- */

/** Split an amount of the smallest coin into {gold, silver, bronze} using the fewest coins. */
export function splitCoins(amount) {
  let rest = Math.max(0, Math.floor(amount) || 0);
  const coins = {};
  for ( const d of denominations() ) {
    coins[d.key] = Math.floor(rest / d.value);
    rest -= coins[d.key] * d.value;
  }
  return coins;
}

/** Total worth of a {gold, silver, bronze} purse in the smallest coin. */
export function totalCoins(coins) {
  return denominations().reduce((sum, d) => sum + ((Math.max(0, Math.floor(Number(coins?.[d.key])) || 0)) * d.value), 0);
}

/** Display parts for an amount, e.g. [{key: "gold", name: "Gold", n: 1}, {key: "silver", ...}]. Empty for 0. */
export function coinParts(amount) {
  const coins = splitCoins(amount);
  return denominations().filter(d => coins[d.key] > 0).map(d => ({key: d.key, name: d.name, n: coins[d.key]}));
}

/** HTML for an amount, used by the `dlshopCoins` Handlebars helper. */
export function coinsHTML(amount) {
  const parts = coinParts(amount);
  if ( !parts.length ) return `<span class="dl-coins free">${game.i18n.localize("DLSHOP.Free")}</span>`;
  const coins = parts.map(p => `<span class="dl-coin ${p.key}" data-tooltip="${foundry.utils.escapeHTML(p.name)}">${p.n}</span>`);
  return `<span class="dl-coins">${coins.join("")}</span>`;
}

/** Plain text for an amount, for notifications: "1 Gold, 5 Silver". */
export function coinsText(amount) {
  const parts = coinParts(amount);
  if ( !parts.length ) return game.i18n.localize("DLSHOP.Free");
  return parts.map(p => `${p.n} ${p.name}`).join(", ");
}

/* -------------------------------------------- */
/*  Paying and receiving                        */
/* -------------------------------------------- */

/**
 * Pay `cost` out of a purse, spending the smallest coins first and breaking larger coins as needed
 * (the change comes back in smaller coins). Returns the new purse, or null if it can't afford it.
 */
export function payFrom(purse, cost) {
  const coins = {...purse};
  let remaining = Math.max(0, Math.floor(cost));
  for ( const d of denominations().reverse() ) {
    if ( remaining <= 0 ) break;
    const use = Math.min(coins[d.key], Math.ceil(remaining / d.value));
    coins[d.key] -= use;
    remaining -= use * d.value;
  }
  if ( remaining > 0 ) return null;
  return addTo(coins, -remaining);
}

/** Add an amount to a purse in the fewest coins. */
export function addTo(purse, amount) {
  const coins = {...purse};
  const add = splitCoins(amount);
  for ( const d of denominations() ) coins[d.key] = (coins[d.key] || 0) + add[d.key];
  return coins;
}

/* -------------------------------------------- */
/*  Actor storage                               */
/* -------------------------------------------- */

/** Read an actor's purse as {gold, silver, bronze}. */
export function getPurse(actor) {
  const purse = {};
  for ( const d of denominations() ) {
    purse[d.key] = Math.max(0, Math.floor(Number(actor.getFlag(MODULE_ID, `purse.${d.key}`))) || 0);
  }
  return purse;
}

/** Write an actor's purse. */
export async function setPurse(actor, purse) {
  const update = {};
  for ( const d of denominations() ) {
    update[`flags.${MODULE_ID}.purse.${d.key}`] = Math.max(0, Math.floor(Number(purse[d.key])) || 0);
  }
  return actor.update(update);
}
