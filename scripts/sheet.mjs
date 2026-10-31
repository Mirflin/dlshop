import { denominations, getPurse, setPurse } from "./currency.mjs";

/**
 * Add a Gold / Silver / Bronze row to actor sheets. On the DogmaLiter sheet it sits under the
 * portraits; on other sheets it goes at the top of the sheet body.
 */
export function addPurseToSheet(app, html) {
  const actor = app.document ?? app.actor;
  if ( !(actor instanceof Actor) || !actor.testUserPermission(game.user, "OBSERVER") ) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if ( !root || root.querySelector(".dlshop-sheet-purse") ) return;

  const editable = app.isEditable ?? actor.isOwner;
  const purse = getPurse(actor);
  const row = document.createElement("fieldset");
  row.className = "dlshop-sheet-purse";
  row.innerHTML = denominations().map(d => `
    <label class="dlshop-sheet-coin ${d.key}">
      <span class="dlshop-sheet-coin-icon" aria-hidden="true"></span>
      <span class="dlshop-sheet-coin-name">${foundry.utils.escapeHTML(d.name)}</span>
      <input type="number" min="0" step="1" data-dlshop-coin="${d.key}" value="${purse[d.key]}" ${editable ? "" : "disabled"}>
    </label>`).join("");

  // Saved here rather than through the sheet's form, so it works with any sheet class.
  row.addEventListener("change", ev => {
    const input = ev.target.closest("[data-dlshop-coin]");
    if ( !input ) return;
    ev.stopPropagation();
    const next = getPurse(actor);
    next[input.dataset.dlshopCoin] = Math.max(0, Math.floor(Number(input.value)) || 0);
    setPurse(actor, next);
  });
  row.addEventListener("keydown", ev => {
    if ( ev.key === "Enter" ) {
      ev.preventDefault();
      ev.target.blur();
    }
  });

  const images = root.querySelector(".r20-images");
  if ( images ) images.after(row);
  else (root.querySelector(".sheet-body") ?? root.querySelector(".window-content") ?? root).prepend(row);
}
