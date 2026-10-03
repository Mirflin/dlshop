import { MODULE_ID, t } from "./config.mjs";
import { getShops, isOpenNow } from "./store.mjs";
import ShopWindow from "./apps/shop-window.mjs";

/**
 * The tokens the current user is "walking around as": their controlled tokens,
 * or failing that, the tokens of their assigned character.
 */
function customerTokens() {
  if ( !canvas.ready ) return [];
  const controlled = canvas.tokens.controlled.filter(tk => tk.actor?.isOwner);
  if ( controlled.length ) return controlled;
  const character = game.user.character;
  if ( !character ) return [];
  return canvas.tokens.placeables.filter(tk => tk.actor?.id === character.id);
}

/**
 * Find the closest shopkeeper token within interaction range of one of the user's tokens.
 * @returns {{shop: object, keeper: Token, customer: Token}|null}
 */
export function findNearbyShop() {
  const customers = customerTokens();
  if ( !customers.length ) return null;
  const shopsByActor = new Map(Object.values(getShops()).filter(s => s.actorId).map(s => [s.actorId, s]));
  if ( !shopsByActor.size ) return null;

  let best = null;
  for ( const keeper of canvas.tokens.placeables ) {
    const shop = shopsByActor.get(keeper.document.actorId);
    if ( !shop ) continue;
    if ( !game.user.isGM && (keeper.document.hidden || !isOpenNow(shop)) ) continue;
    const range = (Number(shop.range) || 2) * canvas.grid.distance;
    for ( const customer of customers ) {
      if ( (customer === keeper) || (customer.document.level !== keeper.document.level) ) continue;
      const distance = canvas.grid.measurePath([customer.center, keeper.center]).distance;
      if ( (distance <= range + 0.001) && (!best || (distance < best.distance)) ) best = {shop, keeper, customer, distance};
    }
  }
  return best;
}

/** Keybinding handler: open the nearest shop. */
export function openNearbyShop() {
  const found = findNearbyShop();
  if ( !found ) {
    if ( customerTokens().length ) ui.notifications.info(t("NoShopNearby"));
    else ui.notifications.info(t("NoToken"));
    return;
  }
  ShopWindow.open(found.shop.id, {actor: found.customer.actor, keeper: found.keeper});
}

/* -------------------------------------------- */
/*  "Press G to trade" prompt                   */
/* -------------------------------------------- */

/** A floating label over the head of the nearest shopkeeper. */
let prompt;
let promptKeeper = null;

function keyLabel() {
  const binding = game.keybindings.get(MODULE_ID, "openShop")[0];
  if ( !binding ) return null;
  const KM = foundry.helpers.interaction.KeyboardManager;
  return [...binding.modifiers, KM.getKeycodeDisplayString(binding.key)].join(" + ");
}

function hidePrompt() {
  promptKeeper = null;
  prompt?.classList.remove("visible");
}

/** Decide whether the prompt should show, and over which shopkeeper. */
export function updatePrompt() {
  if ( !game.ready || !canvas.ready ) return hidePrompt();
  const found = game.settings.get(MODULE_ID, "showPrompt") ? findNearbyShop() : null;
  const key = found ? keyLabel() : null;
  const shopOpen = foundry.applications.instances.get(`${MODULE_ID}-shop-window`)?.rendered;
  if ( !found || !key || shopOpen ) return hidePrompt();
  if ( !prompt ) {
    prompt = document.createElement("div");
    prompt.id = `${MODULE_ID}-prompt`;
    document.body.append(prompt);
  }
  prompt.innerHTML = `<kbd>${key}</kbd><span>${t("PromptTrade", {shop: foundry.utils.escapeHTML(found.shop.name)})}</span>`;
  promptKeeper = found.keeper;
  positionPrompt();
  prompt.classList.add("visible");
}

/** Keep the prompt above the shopkeeper's head as the canvas pans, zooms or the token moves. */
export function positionPrompt() {
  if ( !prompt || !promptKeeper ) return;
  if ( promptKeeper.destroyed || !promptKeeper.visible ) return hidePrompt();
  // The token's display position, which follows its movement animation.
  const {x, y} = canvas.clientCoordinatesFromCanvas({x: promptKeeper.x + (promptKeeper.w / 2), y: promptKeeper.y});
  prompt.style.left = `${x}px`;
  prompt.style.top = `${y}px`;
}

/** Is this token the one the prompt is following? */
export function isPromptKeeper(token) {
  return token === promptKeeper;
}

export { hidePrompt };

export const debouncedPrompt = foundry.utils.debounce(updatePrompt, 100);
