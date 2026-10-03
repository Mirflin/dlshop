import { MODULE_ID, TEMPLATES, t } from "../config.mjs";
import { denominations, splitCoins, totalCoins } from "../currency.mjs";
import { defaultShop, deleteShop, getShop, getShops, isOutsideHours, itemSnapshot, saveShop, updateShop } from "../store.mjs";
import { clearHistory, getHistory } from "../history.mjs";
import ShopWindow from "./shop-window.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** A new stock entry copied from an item. */
function makeWare(item) {
  return {
    id: foundry.utils.randomID(), name: item.name, img: item.img, type: item.type, sourceUuid: item.uuid,
    price: 0, quantity: 1, infinite: false, enabled: true, badge: "", rank: "",
    data: itemSnapshot(item)
  };
}

/** Resolve dropped data (an item or a folder of items) to Item documents. */
async function itemsFromDrop(data) {
  if ( data.type === "Item" ) return [await fromUuid(data.uuid)].filter(i => i instanceof Item);
  if ( (data.type === "Folder") && (data.documentName === "Item") ) {
    const folder = await fromUuid(data.uuid);
    let items = folder?.contents ?? [];
    if ( folder?.pack ) items = await Promise.all(items.map(i => fromUuid(i.uuid)));
    return items.filter(i => i instanceof Item);
  }
  return [];
}

/**
 * The GM's shop manager: a list of every shop, and each shop's signboard / stock / buy list.
 * Every change is saved as soon as it is made.
 */
export default class ShopManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-manager`,
    tag: "form",
    classes: [MODULE_ID, "dlshop-manager"],
    window: {title: "DLSHOP.ManagerTitle", icon: "fa-solid fa-store", resizable: true},
    position: {width: 940, height: 760},
    form: {handler: ShopManager.#onChangeForm, submitOnChange: true, closeOnSubmit: false},
    actions: {
      view: ShopManager.#onView,
      shopTab: ShopManager.#onTab,
      create: ShopManager.#onCreate,
      edit: ShopManager.#onEdit,
      open: ShopManager.#onOpen,
      toggle: ShopManager.#onToggle,
      place: ShopManager.#onPlace,
      duplicate: ShopManager.#onDuplicate,
      delete: ShopManager.#onDelete,
      addUuid: ShopManager.#onAddUuid,
      viewWare: ShopManager.#onViewWare,
      removeWare: ShopManager.#onRemoveWare,
      addWant: ShopManager.#onAddWant,
      removeWant: ShopManager.#onRemoveWant,
      clearHistory: ShopManager.#onClearHistory
    }
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/shop-manager.hbs`, scrollable: [".dlshop-manager-body"]}
  };

  /** Open the manager, optionally straight onto one shop. */
  static open(shopId, tab) {
    const app = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? new this();
    if ( shopId ) {
      app.view = "shop";
      app.shopId = shopId;
      if ( tab ) app.tab = tab;
    }
    return app.render({force: true});
  }

  /** @type {"list"|"shop"} */
  view = "list";
  shopId = null;
  /** @type {"details"|"stock"|"buys"|"history"} */
  tab = "details";

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = {view: this.view, tab: this.tab, denominations: denominations(), hasScene: !!canvas.scene};
    if ( this.view === "shop" ) {
      const shop = getShop(this.shopId);
      if ( shop ) return Object.assign(context, this.#shopContext(shop));
      this.view = context.view = "list";
    }
    context.shops = Object.values(getShops()).map(s => {
      const keeper = game.actors.get(s.actorId);
      const placed = !!keeper && !!canvas.scene?.tokens.some(tk => tk.actorId === keeper.id);
      return {...s, keeper: keeper ? {name: keeper.name, img: keeper.img} : null, placed, waresCount: s.wares.length};
    }).sort((a, b) => a.name.localeCompare(b.name));
    return context;
  }

  #shopContext(shop) {
    const taken = new Set(Object.values(getShops()).filter(s => s.id !== shop.id).map(s => s.actorId));
    const actorOptions = game.actors.contents
      .map(a => ({value: a.id, label: taken.has(a.id) ? `${a.name} (${t("HasShop")})` : a.name}))
      .sort((a, b) => a.label.localeCompare(b.label));
    const keeper = game.actors.get(shop.actorId);
    return {
      shop,
      actorOptions,
      keeper: keeper ? {name: keeper.name, img: keeper.img} : null,
      keeperTaken: taken.has(shop.actorId),
      sellPercent: Math.round(shop.sellRatio * 100),
      volumePercent: Math.round(shop.volume * 100),
      wares: shop.wares.map(w => ({...w, coins: splitCoins(w.price)})),
      wants: shop.wants.map(w => ({...w, coins: splitCoins(w.price)})),
      outsideHours: isOutsideHours(shop),
      history: getHistory(shop.id).map(e => ({...e, when: new Date(e.time).toLocaleString()}))
    };
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("keydown", ev => {
      if ( (ev.key !== "Enter") || (ev.target.tagName !== "INPUT") ) return;
      ev.preventDefault();
      if ( ev.target.classList.contains("dlshop-uuid-input") ) ShopManager.#onAddUuid.call(this, ev, ev.target);
      else ev.target.blur();
    });
    this.element.addEventListener("dragover", ev => {
      const zone = ev.target.closest("[data-drop]");
      if ( !zone ) return;
      ev.preventDefault();
      zone.classList.add("drag-over");
    });
    this.element.addEventListener("dragleave", ev => ev.target.closest?.("[data-drop]")?.classList.remove("drag-over"));
    this.element.addEventListener("drop", ev => {
      const zone = ev.target.closest("[data-drop]");
      if ( !zone ) return;
      zone.classList.remove("drag-over");
      this.#onDrop(ev, zone.dataset.drop);
    });
  }

  /* -------------------------------------------- */
  /*  Saving                                      */
  /* -------------------------------------------- */

  /** Every change is saved immediately. */
  static async #onChangeForm(event, form, formData) {
    const name = event.target?.name;
    if ( !name ) return;
    const data = foundry.utils.expandObject(formData.object);
    if ( (this.view !== "shop") || !this.shopId ) return;

    await updateShop(this.shopId, shop => {
      for ( const key of ["subtitle", "slogan", "description", "actorId", "background", "music", "greeting"] ) {
        if ( key in data ) shop[key] = String(data[key] ?? "").trim();
      }
      if ( String(data.name ?? "").trim() ) shop.name = data.name.trim();
      if ( "open" in data ) shop.open = !!data.open;
      if ( data.hours ) {
        shop.hours.enabled = !!data.hours.enabled;
        // Time inputs are disabled (and not submitted) while the hours are switched off.
        for ( const key of ["from", "to"] ) {
          if ( /^\d{2}:\d{2}$/.test(data.hours[key] ?? "") ) shop.hours[key] = data.hours[key];
        }
      }
      if ( "buyBack" in data ) shop.buyBack = !!data.buyBack;
      if ( "vagueStock" in data ) shop.vagueStock = !!data.vagueStock;
      if ( "range" in data ) shop.range = Math.max(0, Number(data.range) || 0);
      if ( "sellPercent" in data ) shop.sellRatio = Math.clamp(Number(data.sellPercent) || 0, 0, 1000) / 100;
      if ( "volumePercent" in data ) shop.volume = Math.clamp(Number(data.volumePercent) || 0, 0, 100) / 100;
      for ( const ware of shop.wares ) {
        const row = data.wares?.[ware.id];
        if ( !row ) continue;
        ware.price = totalCoins(row.price);
        ware.infinite = !!row.infinite;
        ware.enabled = !!row.enabled;
        if ( "quantity" in row ) ware.quantity = Math.max(0, Math.floor(Number(row.quantity)) || 0);
        ware.badge = String(row.badge ?? "").trim();
        ware.rank = String(row.rank ?? "").trim();
      }
      for ( const want of shop.wants ) {
        const row = data.wants?.[want.id];
        if ( !row ) continue;
        want.name = String(row.name ?? want.name).trim();
        want.price = totalCoins(row.price);
      }
    });
  }

  /** Add items to the stock or buy list, or set the shopkeeper. */
  async #onDrop(event, list) {
    event.preventDefault();
    if ( !this.shopId ) return;
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if ( list === "keeper" ) {
      if ( data.type !== "Actor" ) return;
      const actor = await fromUuid(data.uuid);
      if ( actor ) await updateShop(this.shopId, shop => { shop.actorId = actor.id; });
      return;
    }
    const items = await itemsFromDrop(data);
    if ( !items.length ) return ui.notifications.warn(t("DropItemsOnly"));
    await this.#addItems(items, list);
  }

  async #addItems(items, list) {
    await updateShop(this.shopId, shop => {
      for ( const item of items ) {
        if ( list === "stock" ) shop.wares.push(makeWare(item));
        else shop.wants.push({id: foundry.utils.randomID(), name: item.name, img: item.img, price: 0});
      }
    });
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #shopId(target) {
    return target.closest("[data-shop-id]")?.dataset.shopId ?? this.shopId;
  }

  static #onView(event, target) {
    this.view = target.dataset.view;
    this.render();
  }

  static #onTab(event, target) {
    this.tab = target.dataset.tab;
    this.render();
  }

  static async #onCreate() {
    const shop = defaultShop();
    await saveShop(shop);
    Object.assign(this, {view: "shop", shopId: shop.id, tab: "details"});
    this.render();
  }

  static #onEdit(event, target) {
    Object.assign(this, {view: "shop", shopId: ShopManager.#shopId.call(this, target), tab: "details"});
    this.render();
  }

  static #onOpen(event, target) {
    ShopWindow.open(ShopManager.#shopId.call(this, target), {actor: canvas.tokens?.controlled[0]?.actor});
  }

  static async #onToggle(event, target) {
    await updateShop(ShopManager.#shopId.call(this, target), shop => { shop.open = !shop.open; });
  }

  /** Drop the shopkeeper's token in the middle of the current view. */
  static async #onPlace(event, target) {
    const shop = getShop(ShopManager.#shopId.call(this, target));
    const actor = game.actors.get(shop?.actorId);
    if ( !actor ) return ui.notifications.warn(t("Error.NoKeeper"));
    if ( !canvas.scene ) return ui.notifications.warn(t("Error.NoScene"));
    const {x, y} = canvas.stage.pivot;
    const {width, height} = actor.prototypeToken;
    const position = canvas.grid.getSnappedPoint({
      x: x - ((width * canvas.grid.sizeX) / 2),
      y: y - ((height * canvas.grid.sizeY) / 2)
    }, {mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX});
    if ( canvas.level ) position.level = canvas.level.id;
    const tokenData = await actor.getTokenDocument(position);
    await canvas.scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    ui.notifications.info(t("Placed", {actor: actor.name, shop: shop.name}));
    this.render();
  }

  static async #onDuplicate(event, target) {
    const shop = getShop(ShopManager.#shopId.call(this, target));
    if ( !shop ) return;
    await saveShop({...foundry.utils.deepClone(shop), id: foundry.utils.randomID(), name: t("CopyOf", {shop: shop.name}), actorId: ""});
  }

  static async #onDelete(event, target) {
    const shop = getShop(ShopManager.#shopId.call(this, target));
    if ( !shop ) return;
    const confirmed = await DialogV2.confirm({
      window: {title: t("DeleteTitle")},
      content: `<p>${t("DeleteConfirm", {shop: foundry.utils.escapeHTML(shop.name)})}</p>`
    });
    if ( !confirmed ) return;
    if ( this.shopId === shop.id ) Object.assign(this, {view: "list", shopId: null});
    await deleteShop(shop.id);
    await clearHistory(shop.id);
  }

  static async #onClearHistory() {
    const shop = getShop(this.shopId);
    if ( !shop ) return;
    const confirmed = await DialogV2.confirm({
      window: {title: t("ClearHistory")},
      content: `<p>${t("ClearHistoryConfirm", {shop: foundry.utils.escapeHTML(shop.name)})}</p>`
    });
    if ( confirmed ) await clearHistory(shop.id);
  }

  /** Add an item to the stock by UUID (a raw UUID or an @UUID[...] link). */
  static async #onAddUuid(event, target) {
    const input = this.element.querySelector(".dlshop-uuid-input");
    const raw = input?.value.trim();
    if ( !raw ) return;
    const uuid = raw.match(/@UUID\[([^\]]+)\]/)?.[1] ?? raw;
    const doc = await fromUuid(uuid).catch(() => null);
    const items = doc instanceof Item ? [doc]
      : await itemsFromDrop({type: doc?.documentName, documentName: doc?.type, uuid});
    if ( !items.length ) return ui.notifications.warn(t("Error.BadUuid", {uuid}));
    input.value = "";
    await this.#addItems(items, "stock");
  }

  /** Open the sheet of the item a ware was copied from. */
  static async #onViewWare(event, target) {
    const ware = getShop(this.shopId)?.wares.find(w => w.id === target.closest("[data-id]").dataset.id);
    const item = ware?.sourceUuid ? await fromUuid(ware.sourceUuid) : null;
    if ( !item ) return ui.notifications.warn(t("Error.SourceMissing", {item: ware?.name}));
    item.sheet.render(true);
  }

  static async #onRemoveWare(event, target) {
    const id = target.closest("[data-id]").dataset.id;
    await updateShop(this.shopId, shop => { shop.wares = shop.wares.filter(w => w.id !== id); });
  }

  static async #onAddWant() {
    await updateShop(this.shopId, shop => {
      shop.wants.push({id: foundry.utils.randomID(), name: t("NewWant"), img: "icons/svg/item-bag.svg", price: 1});
    });
  }

  static async #onRemoveWant(event, target) {
    const id = target.closest("[data-id]").dataset.id;
    await updateShop(this.shopId, shop => { shop.wants = shop.wants.filter(w => w.id !== id); });
  }
}
