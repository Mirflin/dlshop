import { MODULE_ID, TEMPLATES, t } from "../config.mjs";
import { connection, linkOf } from "../dogmaliter.mjs";
import { activeDuration, bagEntryView, fetchBag, formatRemaining } from "../pull.mjs";
import { requestPullItem } from "../transactions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The bag of a linked DogmaLiter character: what is in it on the website, with a "Pull" button that
 * moves an item onto the Foundry actor (through the GM, see scripts/pull.mjs). One window per actor.
 */
export default class DogmaLiterBag extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({actor, ...options}={}) {
    super({id: `${MODULE_ID}-bag-${actor.id}`, ...options});
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "dlshop-bag"],
    window: {icon: "fa-solid fa-sack-xmark", resizable: true},
    position: {width: 560, height: 640},
    actions: {
      pull: DogmaLiterBag.#onPull,
      reload: DogmaLiterBag.#onReload,
      login: () => game.modules.get(MODULE_ID).api.openDogmaLiter()
    }
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/dogmaliter-bag.hbs`, scrollable: [".dlshop-bag-list"]}
  };

  /** Open (or bring up) the bag window of an actor. */
  static open(actor) {
    const app = foundry.applications.instances.get(`${MODULE_ID}-bag-${actor.id}`) ?? new this({actor});
    return app.render({force: true});
  }

  /** @type {object[]|null} */
  entries = null;
  error = "";
  busy = new Set();

  get title() {
    return t("Pull.BagTitle", {character: linkOf(this.actor)?.characterName || this.actor.name});
  }

  /** @override */
  async _prepareContext(options) {
    const conn = connection();
    const link = linkOf(this.actor);
    const context = {
      linked: !!link,
      loggedIn: conn.loggedIn,
      actorName: this.actor.name,
      character: link?.characterName ?? "",
      hours: formatRemaining(Date.now() + activeDuration())
    };
    if ( !context.linked || !context.loggedIn ) return context;
    if ( !this.entries ) {
      try {
        this.entries = await fetchBag(this.actor);
        this.error = "";
      }
      catch(err) {
        this.entries = [];
        this.error = err.message;
      }
    }
    context.error = this.error;
    context.entries = this.entries.map(e => ({...bagEntryView(e), busy: this.busy.has(e.id)}));
    return context;
  }

  static async #onPull(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    const entry = this.entries?.find(e => e.id === entryId);
    if ( !entry || this.busy.has(entryId) ) return;
    const view = bagEntryView(entry);
    const confirmed = await DialogV2.confirm({
      window: {title: t("Pull.ConfirmTitle")},
      content: `<p>${t("Pull.Confirm", {
        item: foundry.utils.escapeHTML(view.name), qty: view.quantity,
        actor: foundry.utils.escapeHTML(this.actor.name), time: formatRemaining(Date.now() + activeDuration())
      })}</p>`
    });
    if ( !confirmed ) return;
    this.busy.add(entryId);
    this.render();
    await requestPullItem(this.actor.uuid, entryId);
    this.busy.delete(entryId);
    this.entries = null;
    if ( this.rendered ) this.render();
  }

  static #onReload() {
    this.entries = null;
    this.render();
  }
}
