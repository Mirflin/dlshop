import { MODULE_ID, TEMPLATES, t } from "../config.mjs";
import { coinsHTML, denominations, getPurse, payFrom, totalCoins } from "../currency.mjs";
import { getQuantity, getShop, isOutsideHours, sellPrice, stockWordKey } from "../store.mjs";
import { requestBuy, requestSell } from "../transactions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Plain-text-ish description of an item source, for tooltips. */
function describe(data) {
  const desc = foundry.utils.getProperty(data, "system.description.value")
    ?? foundry.utils.getProperty(data, "system.description");
  return (typeof desc === "string") ? desc : "";
}

/**
 * The shop a customer browses: wares to buy, and the customer's items the shop will buy.
 */
export default class ShopWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({shopId, actor, keeper, ...options}={}) {
    super(options);
    this.shopId = shopId;
    this.actor = actor ?? null;
    this.keeper = keeper ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-shop-window`,
    classes: [MODULE_ID, "dlshop-window"],
    window: {icon: "fa-solid fa-store", resizable: true},
    position: {width: 780, height: 760},
    actions: {
      shopTab: ShopWindow.#onTab,
      buy: ShopWindow.#onBuy,
      sell: ShopWindow.#onSell,
      step: ShopWindow.#onStep,
      manage: ShopWindow.#onManage
    }
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/shop-window.hbs`, scrollable: [".dlshop-list"]}
  };

  /** Open (or switch) the shop window. */
  static open(shopId, {actor, keeper}={}) {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    actor ??= game.user.character ?? null;
    if ( existing ) {
      Object.assign(existing, {shopId, actor, keeper});
      existing.tab = "buy";
      existing.#greeted = false;
      return existing.render({force: true, window: {title: existing.title}});
    }
    return new this({shopId, actor, keeper}).render({force: true});
  }

  tab = "buy";
  filter = "";
  #music = null;
  #musicSrc = null;
  #greeted = false;

  get shop() {
    return getShop(this.shopId);
  }

  get title() {
    return this.shop?.name ?? t("Shop");
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const shop = this.shop;
    if ( !shop ) return {missing: true};
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    const keeperActor = game.actors.get(shop.actorId);
    const actor = this.actor;
    const purse = actor ? getPurse(actor) : null;
    const isGM = game.user.isGM;

    const wares = await Promise.all(shop.wares.filter(w => w.enabled || isGM).map(async w => {
      const desc = describe(w.data);
      const soldOut = !w.infinite && (w.quantity <= 0);
      return {
        ...w,
        soldOut,
        stockText: ShopWindow.#stockText(shop, w, soldOut, isGM),
        // With vague stock the exact count must not leak through the quantity picker's limit either.
        maxQty: (w.infinite || (shop.vagueStock && !isGM)) ? null : w.quantity,
        affordable: !!purse && !!payFrom(purse, w.price),
        tooltip: desc ? await TextEditor.enrichHTML(desc, {secrets: false}) : ""
      };
    }));

    const sellables = actor ? actor.items.contents
      .map(item => ({item, price: sellPrice(shop, item)}))
      .filter(({price}) => price !== null)
      .map(({item, price}) => ({uuid: item.uuid, name: item.name, img: item.img, price, quantity: getQuantity(item)}))
      .sort((a, b) => a.name.localeCompare(b.name)) : [];

    return {
      shop,
      keeper: {name: keeperActor?.name ?? "", img: keeperActor?.img || this.keeper?.document.texture.src || ""},
      description: shop.description ? await TextEditor.enrichHTML(shop.description, {secrets: game.user.isGM}) : "",
      actor: actor ? {name: actor.name, img: actor.img} : null,
      purse: purse ? denominations().map(d => ({...d, n: purse[d.key]})) : [],
      wealth: purse ? totalCoins(purse) : 0,
      wares,
      sellables,
      tab: this.tab,
      filter: this.filter,
      isGM,
      closed: !shop.open,
      outsideHours: shop.open && isOutsideHours(shop)
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const search = this.element.querySelector("input.dlshop-search");
    if ( search ) {
      search.addEventListener("input", ev => {
        this.filter = ev.currentTarget.value;
        this.#applyFilter();
      });
      this.#applyFilter();
    }
    this.element.querySelector(".dlshop-list")?.addEventListener("input", ev => {
      if ( ev.target.closest(".dlshop-qty") ) ShopWindow.#updateRowPrice(ev.target.closest(".dlshop-row"));
    });
    this.#playAudio();
  }

  /** How much of a ware is left, as the customer (or the GM) should see it. */
  static #stockText(shop, ware, soldOut, isGM) {
    if ( ware.infinite ) return t("Plenty");
    if ( soldOut ) return t("SoldOut");
    if ( !shop.vagueStock ) return t("InStock", {n: ware.quantity});
    const words = t(`StockWords.${stockWordKey(ware.quantity)}`);
    return isGM ? t("InStockGM", {n: ware.quantity, words}) : words;
  }

  #applyFilter() {
    const q = this.filter.trim().toLowerCase();
    for ( const row of this.element.querySelectorAll(".dlshop-row[data-name]") ) {
      row.hidden = !!q && !row.dataset.name.toLowerCase().includes(q);
    }
  }

  /** Greeting plays once per visit, background music loops while the window is open. */
  async #playAudio() {
    const shop = this.shop;
    if ( !shop ) return;
    const AudioHelper = foundry.audio.AudioHelper;
    const volume = Number(shop.volume ?? 0.5);
    if ( !this.#greeted && shop.greeting ) {
      AudioHelper.play({src: shop.greeting, volume, channel: "interface"}, false);
    }
    this.#greeted = true;
    if ( this.#musicSrc === (shop.music || null) ) return;
    this.#stopMusic();
    this.#musicSrc = shop.music || null;
    if ( !shop.music ) return;
    const sound = await AudioHelper.play({src: shop.music, volume, loop: true, channel: "music"}, false);
    if ( !this.rendered || (this.#musicSrc !== shop.music) ) sound?.stop();
    else this.#music = sound;
  }

  #stopMusic() {
    this.#music?.stop({fade: 800});
    this.#music = null;
    this.#musicSrc = null;
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#stopMusic();
    this.#greeted = false;
    Hooks.callAll(`${MODULE_ID}.closeShop`, this);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onTab(event, target) {
    this.tab = target.dataset.tab;
    this.render();
  }

  static #onStep(event, target) {
    const input = target.closest(".dlshop-qty").querySelector("input");
    const value = (Number(input.value) || 1) + Number(target.dataset.step);
    input.value = Math.clamp(value, 1, Number(input.max) || Infinity);
    ShopWindow.#updateRowPrice(target.closest(".dlshop-row"));
  }

  /** Show the total for the chosen quantity, with the unit price in brackets. */
  static #updateRowPrice(row) {
    if ( !row?.dataset.price ) return;
    const unit = Number(row.dataset.price);
    const input = row.querySelector(".dlshop-qty input");
    const qty = Math.clamp(Math.floor(Number(input.value)) || 1, 1, Number(input.max) || Infinity);
    const total = unit * qty;
    const price = row.querySelector(".dlshop-price");
    price.innerHTML = coinsHTML(total)
      + (qty > 1 ? `<span class="dlshop-each">(${coinsHTML(unit)} ${t("Each")})</span>` : "");
    const wealth = row.closest("[data-wealth]")?.dataset.wealth;
    if ( (wealth !== undefined) && row.closest("[data-tab-list='buy']") ) {
      price.classList.toggle("dear", total > Number(wealth));
    }
  }

  static #rowQty(target) {
    return Math.max(1, Math.floor(Number(target.closest(".dlshop-row").querySelector(".dlshop-qty input")?.value) || 1));
  }

  static async #onBuy(event, target) {
    if ( !this.actor ) return ui.notifications.warn(t("NoCustomer"));
    target.disabled = true;
    await requestBuy(this.shopId, target.closest(".dlshop-row").dataset.id, this.actor.uuid, ShopWindow.#rowQty(target));
    if ( this.rendered ) this.render();
  }

  static async #onSell(event, target) {
    if ( !this.actor ) return ui.notifications.warn(t("NoCustomer"));
    target.disabled = true;
    await requestSell(this.shopId, target.closest(".dlshop-row").dataset.uuid, ShopWindow.#rowQty(target));
    if ( this.rendered ) this.render();
  }

  static async #onManage() {
    const { default: ShopManager } = await import("./shop-manager.mjs");
    ShopManager.open(this.shopId, "stock");
  }
}
