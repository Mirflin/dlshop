import { MODULE_ID, TEMPLATES, t } from "../config.mjs";
import {
  apiUrl, characterIdOf, connection, linkActor, linkOf, listCharacters, listGames, login, logout,
  unlinkActor, uploadUrl
} from "../dogmaliter.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * DogmaLiter window for every user: log in with your own DogmaLiter account, choose a game, and link
 * your Foundry actors to your DogmaLiter characters. The GM's game choice is also the world default.
 */
export default class DogmaLiterWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-dogmaliter`,
    tag: "form",
    classes: [MODULE_ID, "dlshop-dogmaliter"],
    window: {title: "DLSHOP.DL.Title", icon: "fa-solid fa-link", resizable: true},
    position: {width: 620, height: 720},
    form: {handler: DogmaLiterWindow.#onSubmit, closeOnSubmit: false},
    actions: {
      login: DogmaLiterWindow.#onLogin,
      logout: DogmaLiterWindow.#onLogout,
      reload: DogmaLiterWindow.#onReload,
      link: DogmaLiterWindow.#onLink,
      unlink: DogmaLiterWindow.#onUnlink
    }
  };

  static PARTS = {
    main: {template: `${TEMPLATES}/dogmaliter-window.hbs`, scrollable: [""]}
  };

  /** Open the window (one per user). */
  static open() {
    const app = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? new this();
    return app.render({force: true});
  }

  /** @type {object[]|null} DogmaLiter games of the logged-in user. */
  games = null;
  /** @type {object[]|null} Characters of the chosen game. */
  characters = null;
  charactersFor = "";
  actorId = game.user.character?.id ?? "";
  loadMoney = true;
  error = "";
  busy = false;

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const conn = connection();
    const context = {
      conn,
      isGM: game.user.isGM,
      apiUrl: apiUrl(),
      error: this.error,
      busy: this.busy
    };
    if ( !conn.loggedIn ) return context;

    try {
      this.games ??= await listGames();
      if ( conn.gameId && (this.charactersFor !== conn.gameId) ) {
        this.characters = await listCharacters(conn.gameId);
        this.charactersFor = conn.gameId;
      }
    }
    catch(err) {
      this.error = context.error = err.message;
      this.games ??= [];
    }

    const games = this.games.map(g => ({value: g.id, label: g.isGM ? `${g.title} (GM)` : g.title}));
    if ( conn.gameId && !games.some(g => g.value === conn.gameId) ) {
      games.unshift({value: conn.gameId, label: conn.gameTitle || conn.gameId});
    }

    // Foundry actors this user may link: their own (all of them for the GM).
    const actors = game.actors.contents.filter(a => a.isOwner)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === "character" ? -1 : 1)));
    if ( !actors.some(a => a.id === this.actorId) ) this.actorId = actors[0]?.id ?? "";
    const selected = game.actors.get(this.actorId);

    // Which DogmaLiter characters are already linked, and to which actor.
    const linkedTo = new Map();
    for ( const a of game.actors ) {
      const id = characterIdOf(a);
      if ( id ) linkedTo.set(id, a);
    }

    const characters = (conn.gameId ? this.characters ?? [] : []).map(c => ({
      id: c.id,
      name: c.name,
      owner: c.owner?.username ?? "",
      portrait: uploadUrl(c.portrait_id),
      coins: {gold: c.currency_gold ?? 0, silver: c.currency_silver ?? 0, bronze: c.currency_copper ?? 0},
      linkedTo: linkedTo.get(c.id)?.name ?? "",
      isSelectedLink: !!selected && (linkedTo.get(c.id) === selected)
    }));

    const links = actors.filter(a => characterIdOf(a)).map(a => {
      const link = linkOf(a);
      const id = characterIdOf(a);
      return {
        actorId: a.id,
        actorName: a.name,
        img: a.img,
        characterName: link?.characterName || this.characters?.find(c => c.id === id)?.name || id,
        gameTitle: link?.gameTitle ?? ""
      };
    });

    return Object.assign(context, {
      games,
      actorOptions: actors.map(a => ({value: a.id, label: a.name})),
      actorId: this.actorId,
      selectedActor: selected ? {name: selected.name, img: selected.img} : null,
      characters,
      links,
      loadMoney: this.loadMoney
    });
  }

  /* -------------------------------------------- */
  /*  Form                                        */
  /* -------------------------------------------- */

  /** Changes to the game / actor selects and the money checkbox; Enter in the login form logs in. */
  static async #onSubmit(event, form, formData) {
    if ( !connection().loggedIn ) {
      if ( event.type === "submit" ) return DogmaLiterWindow.#onLogin.call(this);
      return;
    }
    const data = formData.object;
    if ( "loadMoney" in data ) this.loadMoney = !!data.loadMoney;
    if ( "actorId" in data ) this.actorId = data.actorId;
    if ( ("gameId" in data) && (data.gameId !== connection().gameId) ) {
      const ref = {id: data.gameId ?? "", title: this.games?.find(g => g.id === data.gameId)?.title ?? ""};
      await game.settings.set(MODULE_ID, "dlMyGame", ref);
      // The GM's choice is also the world's game, used for actors linked before games were per-link.
      if ( game.user.isGM ) await game.settings.set(MODULE_ID, "dlGame", ref);
      this.characters = null;
      this.charactersFor = "";
    }
    this.render();
  }

  /** @override */
  _onChangeForm(formConfig, event) {
    // Selects and checkboxes apply immediately; text fields (login, attribute) wait for their buttons.
    if ( ["SELECT"].includes(event.target.tagName) || (event.target.type === "checkbox") ) {
      return super._onChangeForm({...formConfig, submitOnChange: true}, event);
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onLogin() {
    const form = this.element;
    const email = form.querySelector("[name=email]")?.value.trim();
    const password = form.querySelector("[name=password]")?.value ?? "";
    if ( !email || !password ) return ui.notifications.warn(t("DL.Error.Credentials"));
    this.busy = true;
    this.render();
    try {
      const user = await login(email, password);
      Object.assign(this, {error: "", games: null, characters: null, charactersFor: ""});
      ui.notifications.info(t("DL.LoggedIn", {user: user?.username ?? email}));
    }
    catch(err) {
      this.error = err.message;
    }
    this.busy = false;
    this.render();
  }

  static async #onLogout() {
    await logout();
    Object.assign(this, {error: "", games: null, characters: null, charactersFor: ""});
    this.render();
  }

  static #onReload() {
    Object.assign(this, {error: "", games: null, characters: null, charactersFor: ""});
    this.render();
  }

  /** Link the selected actor to the clicked DogmaLiter character. */
  static async #onLink(event, target) {
    const actor = game.actors.get(this.actorId);
    const character = this.characters?.find(c => c.id === target.closest("[data-character-id]")?.dataset.characterId);
    if ( !actor || !character ) return;
    if ( !actor.isOwner ) return ui.notifications.warn(t("Error.NotOwner"));
    const conn = connection();
    await linkActor(actor, {gameId: conn.gameId, gameTitle: conn.gameTitle, character, loadMoney: this.loadMoney});
    ui.notifications.info(t("DL.Linked", {actor: actor.name, character: character.name}));
    this.render();
  }

  static async #onUnlink(event, target) {
    const actor = game.actors.get(target.closest("[data-actor-id]")?.dataset.actorId);
    if ( !actor?.isOwner ) return;
    await unlinkActor(actor);
    ui.notifications.info(t("DL.Unlinked", {actor: actor.name}));
    this.render();
  }
}
