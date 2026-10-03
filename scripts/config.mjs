export const MODULE_ID = "dlshop";
export const SOCKET = `module.${MODULE_ID}`;
export const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** Localize a key in this module's namespace. */
export function t(key, data) {
  const k = `DLSHOP.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}
