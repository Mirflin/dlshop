import { MODULE_ID, t } from "./config.mjs";

/**
 * Approval cards for the GM, stacked in the bottom-left corner of the screen (above the player
 * list). Each card asks one question and resolves to true (approve) or false (decline).
 */

let container;

function getContainer() {
  if ( container?.isConnected ) return container;
  container = document.createElement("section");
  container.id = `${MODULE_ID}-approvals`;
  container.className = "dlshop dlshop-approvals";
  document.body.append(container);
  window.addEventListener("resize", placeContainer);
  placeContainer();
  return container;
}

/** Sit just above Foundry's player list, which also lives in the bottom-left corner. */
function placeContainer() {
  if ( !container ) return;
  const players = document.getElementById("players");
  const top = players?.getBoundingClientRect().top;
  container.style.bottom = top ? `${Math.max(12, window.innerHeight - top + 10)}px` : "12px";
}

/**
 * Ask the GM to approve sending an item to the DogmaLiter web inventory.
 * @param {object} request
 * @param {User} request.user          The player asking.
 * @param {Actor} request.actor        The actor the item belongs to.
 * @param {Item} request.item
 * @param {number} request.quantity
 * @param {string} request.character   The DogmaLiter character's name.
 * @returns {Promise<boolean>}
 */
export function askSendApproval({user, actor, item, quantity, character}) {
  const esc = foundry.utils.escapeHTML;
  const card = document.createElement("article");
  card.className = "dlshop-approval";
  card.innerHTML = `
    <header><i class="fa-solid fa-cloud-arrow-up"></i> ${t("Approval.Title")}</header>
    <div class="dlshop-approval-body">
      <img src="${esc(item.img)}" alt="">
      <p>${t("Approval.Text", {
        user: `<strong>${esc(user.name)}</strong>`,
        qty: quantity,
        item: `<strong>${esc(item.name)}</strong>`,
        actor: esc(actor.name),
        character: `<strong>${esc(character)}</strong>`
      })}</p>
    </div>
    <footer>
      <button type="button" class="decline"><i class="fa-solid fa-xmark"></i> ${t("Approval.Decline")}</button>
      <button type="button" class="approve"><i class="fa-solid fa-check"></i> ${t("Approval.Approve")}</button>
    </footer>`;

  getContainer().append(card);
  placeContainer();
  foundry.audio.AudioHelper.play({src: CONFIG.sounds.notification, volume: 0.6}, false);

  return new Promise(resolve => {
    const answer = approved => {
      card.classList.add("closing");
      setTimeout(() => card.remove(), 200);
      resolve(approved);
    };
    card.querySelector(".approve").addEventListener("click", () => answer(true), {once: true});
    card.querySelector(".decline").addEventListener("click", () => answer(false), {once: true});
  });
}
