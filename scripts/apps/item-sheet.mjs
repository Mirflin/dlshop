import { MODULE_ID, TEMPLATES } from "../config.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * A minimal item sheet: name, image and the item's id in the external inventory.
 * The id is stored in `flags.dlshop.inventoryId`.
 */
export default class ShopItemSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "dlshop-item-sheet"],
    position: {width: 460, height: "auto"},
    window: {resizable: false},
    form: {submitOnChange: true}
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/item-sheet.hbs`}
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.document;
    context.inventoryId = this.document.getFlag(MODULE_ID, "inventoryId") ?? "";
    return context;
  }
}
