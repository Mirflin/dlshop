import { MODULE_ID, t } from "./scripts/config.mjs";
import { coinsHTML, getPurse, setPurse } from "./scripts/currency.mjs";
import { getShop, getShops } from "./scripts/store.mjs";
import { registerSocket, requestSendItem } from "./scripts/transactions.mjs";
import { FROM_WEB, queuePurseSync, refreshPurseFromWeb, registerDogmaLiterSettings } from "./scripts/dogmaliter.mjs";
import DogmaLiterWindow from "./scripts/apps/dogmaliter-window.mjs";
import DogmaLiterImport from "./scripts/apps/dogmaliter-import.mjs";
import DogmaLiterBag from "./scripts/apps/dogmaliter-bag.mjs";
import { decorateSheet, isInactive, updateBadges } from "./scripts/pull.mjs";
import { addPurseToSheet } from "./scripts/sheet.mjs";
import {
  debouncedPrompt, findNearbyShop, hidePrompt, isPromptKeeper, openNearbyShop, positionPrompt
} from "./scripts/proximity.mjs";
import ShopManager from "./scripts/apps/shop-manager.mjs";
import ShopWindow from "./scripts/apps/shop-window.mjs";
import ShopItemSheet from "./scripts/apps/item-sheet.mjs";

const openManager = () => ShopManager.open();

/** Re-render any open module windows (debounced so a burst of document updates renders once). */
const refreshApps = foundry.utils.debounce(() => {
  for ( const app of foundry.applications.instances.values() ) {
    if ( (app instanceof ShopWindow) || (app instanceof ShopManager) ) app.render();
  }
  debouncedPrompt();
}, 50);

Hooks.once("init", () => {
  Handlebars.registerHelper("dlshopCoins", amount => new Handlebars.SafeString(coinsHTML(amount)));

  foundry.documents.collections.Items.registerSheet(MODULE_ID, ShopItemSheet, {
    types: ["item"],
    makeDefault: true,
    label: "DLSHOP.ItemSheet.Label"
  });

  game.settings.registerMenu(MODULE_ID, "manager", {
    name: "DLSHOP.Settings.Manager.Name",
    label: "DLSHOP.Settings.Manager.Label",
    hint: "DLSHOP.Settings.Manager.Hint",
    icon: "fa-solid fa-store",
    type: ShopManager,
    restricted: true
  });

  registerDogmaLiterSettings(DogmaLiterWindow);
  game.settings.registerMenu(MODULE_ID, "dogmaliterImport", {
    name: "DLSHOP.DLImport.Menu.Name",
    label: "DLSHOP.DLImport.Menu.Label",
    hint: "DLSHOP.DLImport.Menu.Hint",
    icon: "fa-solid fa-cloud-arrow-down",
    type: DogmaLiterImport,
    restricted: true
  });

  // Purchase history per shop (see scripts/history.mjs).
  game.settings.register(MODULE_ID, "history", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "shops", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "coinGold", {
    name: "DLSHOP.Settings.CoinGold.Name",
    hint: "DLSHOP.Settings.CoinHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "coinSilver", {
    name: "DLSHOP.Settings.CoinSilver.Name",
    hint: "DLSHOP.Settings.CoinHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "coinBronze", {
    name: "DLSHOP.Settings.CoinBronze.Name",
    hint: "DLSHOP.Settings.CoinHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "silverPerGold", {
    name: "DLSHOP.Settings.SilverPerGold.Name",
    scope: "world",
    config: true,
    type: Number,
    default: 10,
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "bronzePerSilver", {
    name: "DLSHOP.Settings.BronzePerSilver.Name",
    scope: "world",
    config: true,
    type: Number,
    default: 10,
    onChange: refreshApps
  });

  game.settings.register(MODULE_ID, "showPrompt", {
    name: "DLSHOP.Settings.ShowPrompt.Name",
    hint: "DLSHOP.Settings.ShowPrompt.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => debouncedPrompt()
  });

  game.keybindings.register(MODULE_ID, "openShop", {
    name: "DLSHOP.Keybinding.Name",
    hint: "DLSHOP.Keybinding.Hint",
    editable: [{key: "KeyG"}],
    onDown: () => {
      openNearbyShop();
      return true;
    }
  });
});

/** Items pulled from a DogmaLiter bag can't be rolled once their time is up. */
Hooks.once("setup", () => {
  const ItemClass = CONFIG.Item.documentClass;
  const roll = ItemClass.prototype.roll;
  if ( typeof roll !== "function" ) return;
  ItemClass.prototype.roll = function(...args) {
    if ( isInactive(this) ) {
      ui.notifications.warn(t("Pull.Error.InactiveUse", {item: this.name}));
      return null;
    }
    return roll.apply(this, args);
  };
});

Hooks.once("ready", () => {
  registerSocket();
  // Countdowns of pulled items on open sheets.
  setInterval(() => updateBadges(), 30 * 1000);
  // Opening hours follow the real clock: re-check the trade prompt every minute.
  setInterval(() => debouncedPrompt(), 60 * 1000);
  game.modules.get(MODULE_ID).api = {
    getShops, getShop, getPurse, setPurse, findNearbyShop, openNearbyShop, openManager,
    openShop: (shopId, options) => ShopWindow.open(shopId, options),
    openDogmaLiter: () => DogmaLiterWindow.open(),
    openDogmaLiterImport: () => DogmaLiterImport.open(),
    openBag: actor => DogmaLiterBag.open(actor),
    editShop: shopId => ShopManager.open(shopId)
  };
});

/* -------------------------------------------- */
/*  Keep windows and the trade prompt current   */
/* -------------------------------------------- */

for ( const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActor", "deleteActor"] ) {
  Hooks.on(hook, refreshApps);
}

Hooks.on("canvasReady", () => debouncedPrompt());
Hooks.on("controlToken", () => debouncedPrompt());
Hooks.on("createToken", () => debouncedPrompt());
Hooks.on("deleteToken", () => debouncedPrompt());
Hooks.on("updateToken", () => debouncedPrompt());
Hooks.on("refreshToken", token => {
  if ( isPromptKeeper(token) ) positionPrompt();
  if ( token.controlled || (token.actor === game.user.character) ) debouncedPrompt();
});
Hooks.on("canvasPan", () => positionPrompt());
Hooks.on("canvasTearDown", () => hidePrompt());
Hooks.on(`${MODULE_ID}.closeShop`, () => debouncedPrompt());
Hooks.on("renderShopWindow", () => debouncedPrompt());

/* -------------------------------------------- */
/*  DogmaLiter web inventory                    */
/* -------------------------------------------- */

/** Any purse change in Foundry is written to the linked DogmaLiter character. */
Hooks.on("updateActor", (actor, changes, options, userId) => {
  if ( options[FROM_WEB] ) return;
  if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.purse`) ) queuePurseSync(actor, userId);
});

/** Each time a linked actor's sheet is opened, load its money from DogmaLiter. */
const openedSheets = new WeakSet();
function onSheetOpen(app) {
  if ( openedSheets.has(app) ) return;
  openedSheets.add(app);
  const actor = app.document ?? app.actor;
  if ( !(actor instanceof Actor) ) return;
  refreshPurseFromWeb(actor).catch(err => {
    console.warn(`${MODULE_ID} | Could not load ${actor.name}'s money from DogmaLiter`, err);
    ui.notifications.warn(t("DL.Error.MoneyLoad", {actor: actor.name, error: err.message}));
  });
}
function onSheetClose(app) {
  openedSheets.delete(app);
}
Hooks.on("renderActorSheet", onSheetOpen);
Hooks.on("renderActorSheetV2", onSheetOpen);
Hooks.on("closeActorSheet", onSheetClose);
Hooks.on("closeActorSheetV2", onSheetClose);

/** The character sheet's Inventory "Send" button (DogmaLiter). Returning false marks it handled. */
Hooks.on("dogmaliter.sendItem", (item, actor) => {
  foundry.applications.api.DialogV2.confirm({
    window: {title: t("DL.SendTitle")},
    content: `<p>${t("DL.SendConfirm", {item: foundry.utils.escapeHTML(item.name), actor: foundry.utils.escapeHTML(actor.name)})}</p>`
  }).then(confirmed => confirmed && requestSendItem(item.uuid));
  return false;
});

/** Gold / Silver / Bronze on every actor sheet (v1 and v2 sheets). */
Hooks.on("renderActorSheet", addPurseToSheet);
Hooks.on("renderActorSheetV2", addPurseToSheet);

/** Timers on pulled items and the "Pull from bag" button on the Inventory page. */
const openBag = actor => DogmaLiterBag.open(actor);
Hooks.on("renderActorSheet", (app, html) => decorateSheet(app, html, openBag));
Hooks.on("renderActorSheetV2", (app, html) => decorateSheet(app, html, openBag));

/** Actors sidebar: DogmaLiter for everyone, the Shop Manager for the GM. */
Hooks.on("renderActorDirectory", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actions = root?.querySelector(".header-actions");
  if ( !actions || actions.querySelector(".dlshop-dir-buttons") ) return;
  const row = document.createElement("div");
  row.className = "dlshop-dir-buttons";
  const add = (icon, label, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i class="${icon}"></i> ${label}`;
    button.addEventListener("click", onClick);
    row.append(button);
  };
  if ( game.user.isGM ) add("fa-solid fa-store", t("Shops"), openManager);
  add("fa-solid fa-link", t("DL.Short"), () => DogmaLiterWindow.open());
  actions.append(row);
});

/** Items sidebar: import from DogmaLiter (GM). */
Hooks.on("renderItemDirectory", (app, html) => {
  if ( !game.user.isGM ) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actions = root?.querySelector(".header-actions");
  if ( !actions || actions.querySelector(".dlshop-dir-buttons") ) return;
  const row = document.createElement("div");
  row.className = "dlshop-dir-buttons";
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> ${t("DLImport.Button")}`;
  button.addEventListener("click", () => DogmaLiterImport.open());
  row.append(button);
  actions.append(row);
});
