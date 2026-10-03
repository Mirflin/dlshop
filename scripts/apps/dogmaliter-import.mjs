import { MODULE_ID, TEMPLATES, t } from "../config.mjs";
import {
  connection, downloadImage, importedItems, itemDataFromCompendium, listCompendium, listItemTags, uploadUrl
} from "../dogmaliter.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RARITIES = ["common", "uncommon", "rare", "epic", "masterwork", "legendary", "unique"];
/** DogmaLiter equipment slots, in the order its own item editor lists them. */
const SLOTS = ["head", "chest", "gloves", "belt", "boots", "main_hand", "off_hand", "ring", "amulet"];
const NEW_FOLDER = "__new__";

/**
 * GM window: browse the game's DogmaLiter compendium and create Foundry items from it. Each created
 * item keeps the DogmaLiter id as its Item ID, so it can be stocked in shops and sent back to the web
 * inventory. Importing an item that is already in Foundry updates it instead of making a copy.
 */
export default class DogmaLiterImport extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-dogmaliter-import`,
    tag: "form",
    classes: [MODULE_ID, "dlshop-dl-import"],
    window: {title: "DLSHOP.DLImport.Title", icon: "fa-solid fa-cloud-arrow-down", resizable: true},
    position: {width: 760, height: 760},
    form: {handler: DogmaLiterImport.#onSubmit, closeOnSubmit: false},
    actions: {
      page: DogmaLiterImport.#onPage,
      toggle: DogmaLiterImport.#onToggle,
      selectPage: DogmaLiterImport.#onSelectPage,
      clearSelection: DogmaLiterImport.#onClearSelection,
      import: DogmaLiterImport.#onImport,
      login: () => game.modules.get(MODULE_ID).api.openDogmaLiter()
    }
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/dogmaliter-import.hbs`, scrollable: [".dlshop-dli-list"]}
  };

  static open() {
    const app = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? new this();
    return app.render({force: true});
  }

  page = 1;
  search = "";
  rarity = "";
  tag = "";
  slot = "";
  /** @type {string[]|null} Item tags of the game, for the tag filter. */
  tags = null;
  tagsFor = "";
  type = game.documentTypes?.Item?.includes("item") ? "item" : (game.documentTypes?.Item?.find(t => t !== "base") ?? "");
  folder = "";
  /** @type {Map<string, object>} Selected DogmaLiter items, kept across pages. */
  selected = new Map();
  result = null;
  resultKey = "";
  error = "";
  busy = false;

  /** @override */
  async _prepareContext(options) {
    const conn = connection();
    const context = {conn, ready: conn.loggedIn && !!conn.gameId, busy: this.busy};
    if ( !context.ready ) return context;

    if ( this.tagsFor !== conn.gameId ) {
      try { this.tags = await listItemTags(conn.gameId); }
      catch { this.tags = []; }
      this.tagsFor = conn.gameId;
    }
    const key = JSON.stringify([conn.gameId, this.page, this.search, this.rarity, this.tag, this.slot]);
    if ( this.resultKey !== key ) {
      try {
        this.result = await listCompendium(conn.gameId, {page: this.page, search: this.search, rarity: this.rarity, tag: this.tag, slot: this.slot});
        this.error = "";
      }
      catch(err) {
        this.result = {items: [], pagination: {}};
        this.error = err.message;
      }
      this.resultKey = key;
    }

    const imported = importedItems();
    const items = (this.result.items ?? []).map(i => ({
      id: i.id,
      name: i.name,
      img: i.image_id ? uploadUrl(i.image_id) : "icons/svg/item-bag.svg",
      rarity: i.rarity,
      category: i.category,
      tags: (i.tags ?? []).join(", "),
      selected: this.selected.has(i.id),
      inFoundry: imported.get(i.id)?.name ?? ""
    }));
    const pagination = this.result.pagination ?? {};

    return Object.assign(context, {
      error: this.error,
      items,
      search: this.search,
      rarity: this.rarity,
      tag: this.tag,
      slot: this.slot,
      slotOptions: SLOTS.map(s => ({value: s, label: t(`DLImport.Slots.${s}`)})),
      tagOptions: (this.tags ?? []).map(name => ({value: name, label: name})),
      rarityOptions: RARITIES.map(r => ({value: r, label: r[0].toUpperCase() + r.slice(1)})),
      page: pagination.page ?? this.page,
      totalPages: pagination.total_pages ?? 1,
      totalItems: pagination.total_items ?? items.length,
      hasPrev: !!pagination.has_prev,
      hasNext: !!pagination.has_next,
      selectedCount: this.selected.size,
      type: this.type,
      typeOptions: (game.documentTypes?.Item ?? []).filter(t => t !== "base")
        .map(t => ({value: t, label: game.i18n.localize(CONFIG.Item.typeLabels?.[t] ?? t)})),
      folder: this.folder,
      imageFolder: game.settings.get(MODULE_ID, "dlImageFolder") || "dogmaliter-images",
      folderOptions: [
        {value: NEW_FOLDER, label: t("DLImport.NewFolder")},
        ...game.folders.filter(f => f.type === "Item").sort((a, b) => a.name.localeCompare(b.name))
          .map(f => ({value: f.id, label: f.name}))
      ]
    });
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Search as you type (debounced); Enter does not submit the form.
    const runSearch = foundry.utils.debounce(value => {
      this.search = value.trim();
      this.page = 1;
      this.render();
    }, 400);
    this.element.addEventListener("input", ev => {
      if ( ev.target.name === "search" ) runSearch(ev.target.value);
    });
    this.element.addEventListener("keydown", ev => {
      if ( (ev.key === "Enter") && (ev.target.tagName === "INPUT") ) ev.preventDefault();
    });
  }

  /** @override */
  _onChangeForm(formConfig, event) {
    if ( event.target.name === "search" ) return;
    return super._onChangeForm({...formConfig, submitOnChange: true}, event);
  }

  /** Filter and import options. */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    if ( ("rarity" in data) && (data.rarity !== this.rarity) ) {
      this.rarity = data.rarity ?? "";
      this.page = 1;
    }
    if ( ("tag" in data) && (data.tag !== this.tag) ) {
      this.tag = data.tag ?? "";
      this.page = 1;
    }
    if ( ("slot" in data) && (data.slot !== this.slot) ) {
      this.slot = data.slot ?? "";
      this.page = 1;
    }
    if ( "type" in data ) this.type = data.type;
    if ( "folder" in data ) this.folder = data.folder ?? "";
    this.render();
  }

  /* -------------------------------------------- */

  static #onPage(event, target) {
    this.page = Math.max(1, this.page + Number(target.dataset.step));
    this.render();
  }

  /** Clicking a row toggles it. */
  static #onToggle(event, target) {
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.result?.items?.find(i => i.id === id);
    if ( !item ) return;
    if ( this.selected.has(id) ) this.selected.delete(id);
    else this.selected.set(id, item);
    this.render();
  }

  static #onSelectPage() {
    for ( const item of this.result?.items ?? [] ) this.selected.set(item.id, item);
    this.render();
  }

  static #onClearSelection() {
    this.selected.clear();
    this.render();
  }

  /** Create (or update) Foundry items for everything selected. */
  static async #onImport() {
    if ( !this.selected.size ) return ui.notifications.warn(t("DLImport.NothingSelected"));
    if ( !this.type ) return ui.notifications.warn(t("DLImport.NoType"));
    this.busy = true;
    this.render();
    try {
      let folder = this.folder;
      if ( folder === NEW_FOLDER ) {
        const created = await Folder.implementation.create({name: "DogmaLiter", type: "Item"});
        folder = this.folder = created.id;
      }
      const existing = importedItems();
      const toCreate = [];
      const toUpdate = [];
      let imageFailures = 0;
      for ( const webItem of this.selected.values() ) {
        let img;
        if ( webItem.image_id ) {
          try { img = await downloadImage(webItem.image_id); }
          catch(err) {
            imageFailures++;
            console.warn(`${MODULE_ID} | Could not download the image of ${webItem.name}`, err);
          }
        }
        const current = existing.get(webItem.id);
        if ( current ) {
          const data = itemDataFromCompendium(webItem, {type: current.type, img: img ?? current.img});
          toUpdate.push({_id: current.id, name: data.name, img: data.img, ...(data.system ? {system: data.system} : {}),
            [`flags.${MODULE_ID}.dogmaliter`]: data.flags[MODULE_ID].dogmaliter});
        }
        else toCreate.push(itemDataFromCompendium(webItem, {type: this.type, folder, img}));
      }
      if ( toCreate.length ) await Item.implementation.createDocuments(toCreate);
      if ( toUpdate.length ) await Item.implementation.updateDocuments(toUpdate);
      ui.notifications.info(t("DLImport.Done", {created: toCreate.length, updated: toUpdate.length}));
      if ( imageFailures ) ui.notifications.warn(t("DLImport.ImageFailures", {n: imageFailures}));
      this.selected.clear();
    }
    catch(err) {
      console.error(`${MODULE_ID} | DogmaLiter import failed`, err);
      ui.notifications.error(t("DLImport.Failed", {error: err.message}));
    }
    this.busy = false;
    this.render();
  }
}
