import { MODULE_ID, t } from "./config.mjs";
import { getPurse } from "./currency.mjs";
import { getQuantity } from "./store.mjs";

/**
 * DogmaLiter web inventory integration.
 *
 * Every user (GM or player) can log in with their own DogmaLiter account. Login tokens are kept in a
 * client setting, i.e. only in that user's browser, never in the world where others could read them.
 *
 *  - Linking: a user links one of their actors to one of their DogmaLiter characters in the
 *    DogmaLiter window. The link is stored in `flags.dlshop.dl` ({gameId, gameTitle, characterId,
 *    characterName}); there is no manual id entry.
 *  - Money: whenever an actor's purse changes, its Gold / Silver / Bronze are written to the linked
 *    character (Bronze = DogmaLiter "copper"), by the active GM and by the player who made the change,
 *    whoever of them is logged in. The request sets absolute values, so sending twice is harmless.
 *  - Items: the "Send" button on the character sheet's Inventory page delivers the item (by its
 *    Item ID, `flags.dlshop.inventoryId`) to the linked character, then removes it from Foundry.
 *    DogmaLiter only lets GMs deliver items, so this always runs on the logged-in GM's client.
 *  - Import: the GM can create Foundry items from the game's DogmaLiter compendium.
 */

const setting = key => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

export function registerDogmaLiterSettings(menuType) {
  game.settings.registerMenu(MODULE_ID, "dogmaliter", {
    name: "DLSHOP.DL.Menu.Name",
    label: "DLSHOP.DL.Menu.Label",
    hint: "DLSHOP.DL.Menu.Hint",
    icon: "fa-solid fa-link",
    type: menuType,
    restricted: false
  });
  game.settings.register(MODULE_ID, "dlApiUrl", {
    name: "DLSHOP.DL.ApiUrlSetting.Name",
    hint: "DLSHOP.DL.ApiUrlSetting.Hint",
    scope: "world", config: true, type: String, default: "https://api.dogmaliter.online",
    // A login only works on the server it came from.
    onChange: () => logout()
  });
  game.settings.register(MODULE_ID, "dlGame", {
    scope: "world", config: false, type: Object, default: {id: "", title: ""}
  });
  // The game this browser's user is working with; falls back to the world's game.
  game.settings.register(MODULE_ID, "dlMyGame", {
    scope: "client", config: false, type: Object, default: {id: "", title: ""}
  });
  // Where imported item images are saved (Foundry's Data folder).
  game.settings.register(MODULE_ID, "dlImageFolder", {
    name: "DLSHOP.DLImport.ImageFolder.Name",
    hint: "DLSHOP.DLImport.ImageFolder.Hint",
    scope: "world", config: true, type: String, default: "dogmaliter-images", filePicker: "folder"
  });
  // Login tokens: this browser only.
  game.settings.register(MODULE_ID, "dlAuth", {
    scope: "client", config: false, type: Object, default: {}
  });
}

/** The API address without a trailing slash or "/api" (both forms are accepted in the setting). */
export function apiUrl() {
  return String(setting("dlApiUrl") || "https://api.dogmaliter.online").trim().replace(/\/+$/, "").replace(/\/api$/, "");
}

export function connection() {
  const auth = setting("dlAuth") ?? {};
  const mine = setting("dlMyGame") ?? {};
  const gameRef = mine.id ? mine : (setting("dlGame") ?? {});
  return {
    loggedIn: !!auth.refreshToken,
    username: auth.username ?? "",
    userId: auth.userId ?? "",
    gameId: gameRef.id ?? "",
    gameTitle: gameRef.title ?? ""
  };
}

/** Older versions also kept the id in a sheet attribute with this name; it is cleaned up on (un)link. */
const LEGACY_ATTRIBUTE = "Character ID";

/** The actor's link to a DogmaLiter character, if any. */
export function linkOf(actor) {
  return actor?.getFlag(MODULE_ID, "dl") ?? null;
}

/** The id of the DogmaLiter character the actor is linked to, or "". */
export function characterIdOf(actor) {
  return String(linkOf(actor)?.characterId ?? "").trim();
}

/** The DogmaLiter game the actor's character belongs to. */
export function gameIdOf(actor) {
  return linkOf(actor)?.gameId || (setting("dlGame") ?? {}).id || "";
}

/* -------------------------------------------- */
/*  HTTP                                        */
/* -------------------------------------------- */

class DogmaLiterError extends Error {}

async function readJSON(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { return {error: text}; }
}

let refreshing = null;

/** Exchange the refresh token for a new pair. Concurrent callers share one refresh. */
async function refreshTokens() {
  refreshing ??= (async () => {
    const auth = setting("dlAuth") ?? {};
    if ( !auth.refreshToken ) throw new DogmaLiterError(t("DL.Error.NotLoggedIn"));
    const response = await fetch(`${apiUrl()}/api/auth/refresh`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({refresh_token: auth.refreshToken})
    });
    const data = await readJSON(response);
    if ( !response.ok ) {
      await game.settings.set(MODULE_ID, "dlAuth", {});
      throw new DogmaLiterError(t("DL.Error.SessionExpired"));
    }
    await game.settings.set(MODULE_ID, "dlAuth", {...auth, accessToken: data.access_token, refreshToken: data.refresh_token});
  })().finally(() => refreshing = null);
  return refreshing;
}

/** Call the DogmaLiter API as the logged-in GM, refreshing the access token once if it expired. */
export async function api(method, path, body) {
  const send = () => fetch(`${apiUrl()}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${setting("dlAuth")?.accessToken ?? ""}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if ( !setting("dlAuth")?.refreshToken ) throw new DogmaLiterError(t("DL.Error.NotLoggedIn"));
  let response = await send();
  if ( response.status === 401 ) {
    await refreshTokens();
    response = await send();
  }
  const data = await readJSON(response);
  if ( !response.ok ) throw new DogmaLiterError(data.error || `${response.status} ${response.statusText}`);
  return data;
}

/** Log in with email and password. The password itself is never stored. */
export async function login(email, password) {
  const response = await fetch(`${apiUrl()}/api/auth/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({email, password})
  });
  const data = await readJSON(response);
  if ( !response.ok ) throw new DogmaLiterError(data.error || `${response.status} ${response.statusText}`);
  await game.settings.set(MODULE_ID, "dlAuth", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    username: data.user?.username ?? email,
    userId: data.user?.id ?? ""
  });
  return data.user;
}

export async function logout() {
  await game.settings.set(MODULE_ID, "dlAuth", {});
}

/** DogmaLiter games the logged-in user belongs to, each marked with whether they are its GM. */
export async function listGames() {
  const {userId} = connection();
  const games = await api("GET", "/games");
  return (Array.isArray(games) ? games : games.games ?? []).map(g => ({
    ...g,
    isGM: (g.owner_id === userId)
      || !!g.members?.some(m => (m.user_id === userId) && ["gm", "assistant_gm"].includes(m.role))
  }));
}

/** The characters of a game the logged-in user may see: their own, or all of them for a GM. */
export async function listCharacters(gameId) {
  const session = await api("GET", `/games/${encodeURIComponent(gameId)}/session`);
  return session.characters ?? [];
}

/** The item tags defined in a game. */
export async function listItemTags(gameId) {
  const session = await api("GET", `/games/${encodeURIComponent(gameId)}/session`);
  return session.item_tags ?? [];
}

/** Public image address of a DogmaLiter upload (portraits). */
export function uploadUrl(id) {
  return id ? `${apiUrl()}/api/uploads/${encodeURIComponent(id)}` : "";
}

/* -------------------------------------------- */
/*  Linking                                     */
/* -------------------------------------------- */

/**
 * Link an actor to a DogmaLiter character. Optionally copies the character's money into the actor's
 * purse, so the web amounts are not overwritten by Foundry's on the next change.
 */
export async function linkActor(actor, {gameId, gameTitle, character, loadMoney=true}) {
  const update = {
    [`flags.${MODULE_ID}.dl`]: {gameId, gameTitle, characterId: character.id, characterName: character.name}
  };
  if ( loadMoney ) {
    update[`flags.${MODULE_ID}.purse`] = {
      gold: Number(character.currency_gold) || 0,
      silver: Number(character.currency_silver) || 0,
      bronze: Number(character.currency_copper) || 0
    };
  }
  removeLegacyAttribute(actor, update);
  await actor.update(update);
}

export async function unlinkActor(actor) {
  const update = {[`flags.${MODULE_ID}.-=dl`]: null};
  removeLegacyAttribute(actor, update);
  await actor.update(update);
}

function removeLegacyAttribute(actor, update) {
  const attr = actor.findAttribute?.(LEGACY_ATTRIBUTE);
  if ( attr ) update[`system.attributes.-=${attr.id}`] = null;
}

/* -------------------------------------------- */
/*  Compendium import (GM)                      */
/* -------------------------------------------- */

/**
 * One page of the game's DogmaLiter compendium (GM only in DogmaLiter).
 * @returns {Promise<{items: object[], pagination: object}>}
 */
export async function listCompendium(gameId, {page=1, search="", rarity="", tag="", slot=""}={}) {
  const query = new URLSearchParams({page: String(page), per_page: "60"});
  if ( search ) query.set("search", search);
  if ( rarity ) query.set("rarity", rarity);
  if ( tag ) query.set("tag", tag);
  if ( slot ) query.set("slot", slot);
  return api("GET", `/games/${encodeURIComponent(gameId)}/items?${query}`);
}

/** Plain DogmaLiter text as simple HTML paragraphs. */
function textToHTML(text) {
  return String(text ?? "").trim().split(/\n{2,}/).filter(Boolean)
    .map(p => `<p>${foundry.utils.escapeHTML(p).replace(/\n/g, "<br>")}</p>`).join("");
}

const IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp"};
const readyFolders = new Set();

/** Make sure a folder (and its parents) exists in Foundry's Data storage. */
async function ensureFolder(path) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  let current = "";
  for ( const part of path.split("/").filter(Boolean) ) {
    current = current ? `${current}/${part}` : part;
    if ( readyFolders.has(current) ) continue;
    try { await FilePicker.browse("data", current); }
    catch { await FilePicker.createDirectory("data", current); }
    readyFolders.add(current);
  }
}

/**
 * Download a DogmaLiter image into the configured image folder and return its Foundry path.
 * DogmaLiter serves images at extension-less addresses, which Foundry does not accept as an item
 * image, so imported items use a local copy (named after the DogmaLiter image id).
 */
export async function downloadImage(imageId) {
  const folder = String(setting("dlImageFolder") || "dogmaliter-images").replace(/^\/+|\/+$/g, "");
  const response = await fetch(uploadUrl(imageId));
  if ( !response.ok ) throw new DogmaLiterError(`${response.status} ${response.statusText}`);
  const blob = await response.blob();
  const ext = IMAGE_TYPES[blob.type];
  if ( !ext ) throw new DogmaLiterError(`unsupported image type "${blob.type}"`);
  await ensureFolder(folder);
  const file = new File([blob], `${imageId}.${ext}`, {type: blob.type});
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const result = await FilePicker.upload("data", folder, file, {}, {notify: false});
  if ( !result?.path ) throw new DogmaLiterError("upload failed");
  return result.path;
}

/** Foundry item data for a DogmaLiter compendium item. `img` is its downloaded image, if any. */
export function itemDataFromCompendium(webItem, {type, folder, img}={}) {
  const data = {
    name: webItem.name,
    type,
    img: img || "icons/svg/item-bag.svg",
    folder: folder || null,
    flags: {[MODULE_ID]: {
      inventoryId: webItem.id,
      dogmaliter: {rarity: webItem.rarity ?? "", category: webItem.category ?? "", tags: webItem.tags ?? []}
    }}
  };
  // Systems built from template.json (Magicpunk) declare which fields each item type has.
  if ( foundry.utils.getProperty(game.model?.Item?.[type] ?? {}, "description") !== undefined ) {
    data.system = {description: textToHTML(webItem.description)};
  }
  return data;
}

/** World items already imported from DogmaLiter, by DogmaLiter item id. */
export function importedItems() {
  const map = new Map();
  for ( const item of game.items ) {
    const id = item.getFlag(MODULE_ID, "inventoryId");
    if ( id ) map.set(String(id), item);
  }
  return map;
}

function requireGame(actor) {
  const gameId = gameIdOf(actor);
  if ( !gameId ) throw new DogmaLiterError(t("DL.Error.NoGame"));
  return gameId;
}

/* -------------------------------------------- */
/*  Money                                       */
/* -------------------------------------------- */

/** Write an actor's Gold / Silver / Bronze to its DogmaLiter character. */
export async function pushPurse(actor) {
  const characterId = characterIdOf(actor);
  if ( !characterId ) return;
  const gameId = requireGame(actor);
  const purse = getPurse(actor);
  await api("PATCH", `/games/${gameId}/characters/${encodeURIComponent(characterId)}`, {
    currency_gold: purse.gold,
    currency_silver: purse.silver,
    currency_copper: purse.bronze
  });
}

/** Marks actor updates that came from DogmaLiter, so they are not sent straight back. */
export const FROM_WEB = "dlshopFromWeb";

const lastRefresh = new Map();

/**
 * Load the linked character's money from DogmaLiter into the actor's purse. Done by a user who owns
 * the actor and is logged in (the character's owner or a GM in DogmaLiter); at most every 5 seconds.
 * @returns {Promise<boolean>} Whether the purse changed.
 */
export async function refreshPurseFromWeb(actor) {
  const characterId = characterIdOf(actor);
  if ( !characterId || !actor.isOwner || !connection().loggedIn ) return false;
  const now = Date.now();
  if ( now - (lastRefresh.get(actor.uuid) ?? 0) < 5000 ) return false;
  lastRefresh.set(actor.uuid, now);
  const gameId = requireGame(actor);
  const {character} = await api("GET", `/games/${encodeURIComponent(gameId)}/characters/${encodeURIComponent(characterId)}`);
  if ( !character ) return false;
  const web = {
    gold: Number(character.currency_gold) || 0,
    silver: Number(character.currency_silver) || 0,
    bronze: Number(character.currency_copper) || 0
  };
  const current = getPurse(actor);
  if ( (web.gold === current.gold) && (web.silver === current.silver) && (web.bronze === current.bronze) ) return false;
  await actor.update({[`flags.${MODULE_ID}.purse`]: web}, {[FROM_WEB]: true});
  return true;
}

const pendingPurses = new Map();

/**
 * Debounced per actor, so typing in a coin box sends one request. Sent by the active GM and by the
 * user who made the change (if they own the actor), whichever of them is logged in to DogmaLiter.
 * @param {Actor} actor
 * @param {string} userId   The user who changed the purse.
 */
export function queuePurseSync(actor, userId) {
  if ( !connection().loggedIn || !characterIdOf(actor) ) return;
  const isActiveGM = !!game.users.activeGM?.isSelf;
  const isAuthor = (userId === game.userId) && actor.isOwner;
  if ( !isActiveGM && !isAuthor ) return;
  clearTimeout(pendingPurses.get(actor.uuid));
  pendingPurses.set(actor.uuid, setTimeout(async () => {
    pendingPurses.delete(actor.uuid);
    try {
      await pushPurse(actor);
    }
    catch(err) {
      console.error(`${MODULE_ID} | DogmaLiter money sync failed for ${actor.name}`, err);
      ui.notifications.warn(t("DL.Error.MoneySync", {actor: actor.name, error: err.message}));
    }
  }, 800));
}

/* -------------------------------------------- */
/*  Items                                       */
/* -------------------------------------------- */

/**
 * Deliver an owned item to the DogmaLiter character, then remove it from the actor. Runs on the GM.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
/**
 * Why an item can't be sent right now, or null if it can. Checked on the GM's client before the GM
 * is asked to approve, so requests that would fail anyway don't bother them.
 */
export function sendProblem(item) {
  const actor = item.parent;
  if ( !characterIdOf(actor) ) return t("DL.Error.NoCharacterId", {actor: actor.name});
  if ( !String(item.getFlag(MODULE_ID, "inventoryId") ?? "").trim() ) return t("DL.Error.NoItemId", {item: item.name});
  if ( !gameIdOf(actor) ) return t("DL.Error.NoGame");
  if ( !connection().loggedIn ) return t("DL.Error.GMNotLoggedIn");
  return null;
}

export async function sendItemToInventory(item) {
  const actor = item.parent;
  const problem = sendProblem(item);
  if ( problem ) return {ok: false, message: problem};
  const characterId = characterIdOf(actor);
  const itemId = String(item.getFlag(MODULE_ID, "inventoryId")).trim();
  const gameId = requireGame(actor);
  const quantity = Math.clamp(getQuantity(item), 1, 9999);
  await api("POST", `/games/${gameId}/characters/${encodeURIComponent(characterId)}/inventory`, {
    items: [{item_id: itemId, quantity}]
  });
  const name = item.name;
  await item.delete();
  return {ok: true, message: t("DL.Sent", {qty: quantity, item: name, actor: actor.name})};
}

export { DogmaLiterError };
