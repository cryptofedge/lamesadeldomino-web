/* Mesa play-time SDK v1.0.3 */
(function (root) {
/**
 * Mesa play-time SDK. Vanilla JS, no npm in games.
 * Host injects window.__MESA__ or postMessage { type: "mesa-bootstrap", ... }.
 * v1 is player identity, per-game saves, optional open-lobby multiplayer,
 * cloud saves, and the in-game coin economy.
 *
 * THIS FILE IS THE ONE COPY. It is the source of truth for `window.Mesa`:
 * the engine injects the built artifact into every game and the CDN serves it
 * at /sdk/<major>/mesa-play.js, so a fix here reaches the fleet. The engine
 * repo carries no implementation — only the skills that tell a generator how
 * to call this. Do not re-implement it there.
 *
 * One service owns identity, saves, rooms, coins, prices and entitlements —
 * the play service — and it is reached over `saveEndpoint` + `saveToken`
 * (Bearer). `shop.*` and `economy.*` therefore read the same DynamoDB table
 * that holds the wallet; nothing here asks the site what a price is.
 *
 * Real money is the deliberate exception: `economy.topUp` hands the checkout
 * to the host page, so the confirmation UI — and the price it shows — belong
 * to the site rather than to a game the player can rewrite.
 */

/**
 * @typedef {object} MesaConfig
 * @property {string} [endpoint]
 * @property {string} [gameId]
 * @property {string} [publicId]
 * @property {string} [playerToken]
 * @property {string} [rail]
 * @property {string} [deviceId]
 */

// The compatibility major a build pins to (`/sdk/v1/...`) is derived from this
// number, and the engine reads it to stamp each game, so this is the SDK's
// public version — bump the minor for fixes, the major for breaking changes.
//
// 1.0.0 ships six services together: saves, shop, leaderboards, achievements,
// a vanity address (`mesa.vanity`) and in-game ads (`mesa.ads`). These are
// the first release, so there is no earlier number to stay compatible with.
const VERSION = "1.0.3";

const LOCAL_CACHE = "mesa.play.v1";

/**
 * Reconnect policy for a dropped multiplayer socket.
 *
 * A scale-in, a deploy or a flaky network can close the socket of a player
 * who did nothing wrong, and without a retry they sat alone in a match that
 * looked fine. Backoff is capped and jittered because those events drop
 * everyone at once: un-jittered retries would arrive as a synchronized spike
 * exactly when the fleet is least able to take one.
 */
const MP_RECONNECT_BASE_MS = 1000;
const MP_RECONNECT_MAX_MS = 30000;
const MP_RECONNECT_MAX_ATTEMPTS = 8;

/**
 * A polite, dns-safe label: lowercase letters, digits and internal hyphens,
 * at least three characters and at most sixty-three. The same rule the server
 * enforces, repeated here so a game can pre-validate and give the player a
 * sentence instead of an error code.
 */
const VANITY_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const VANITY_MIN = 3;
const VANITY_MAX = 63;

/**
 * Labels that can never belong to a game, because they already mean
 * something on our own domains (`api.mesa.ai`, `play.mesa.ai`) or are
 * claimed by mail and operations. The server is the authority; this list
 * exists so the common case is refused before a round-trip.
 */
const VANITY_RESERVED = new Set([
  "www", "api", "app", "play", "admin", "cdn", "mail", "docs", "status",
  "support", "help", "blog", "staging", "static", "assets", "files", "media",
  "sdk", "ws", "auth", "account", "billing", "signup", "login", "dashboard",
  "m", "dev", "test", "prod", "preview", "store", "explore", "studio",
  "wallet", "checkout", "gateway", "edge", "origin", "email", "smtp",
  "postmaster", "abuse", "security", "system", "internal", "metrics", "logs",
]);

/** Fold a display name or typed phrase into a candidate label. */
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Why a label cannot be used, or `""` when it can. */
function vanityProblem(label) {
  if (!label) return "empty";
  if (label.length < VANITY_MIN || label.length > VANITY_MAX) return "invalid";
  if (!VANITY_RE.test(label)) return "invalid";
  if (VANITY_RESERVED.has(label)) return "reserved";
  return "";
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CACHE) || "{}");
  } catch {
    return {};
  }
}

function writeCache(patch) {
  try {
    localStorage.setItem(LOCAL_CACHE, JSON.stringify({ ...readCache(), ...patch }));
  } catch {
    /* ignore */
  }
}

// The host may answer more than once. A bootstrap that says `offline` is
// provisional — it means "nobody has answered yet", and the site posts one the
// moment the frame loads, before it has finished minting the play session.
// Treating the first answer as final locks a signed-in player into a game with
// no wallet, and the real bootstrap a moment later is dropped, so the only
// symptom is a balance frozen at zero. Keep listening and upgrade.
let bootstrap = null;
const bootstrapWaiters = [];
// Clients already built from a provisional answer, so a later real bootstrap
// can re-point them in place. A game holds a reference to its client, so it
// must not be rebuilt — only upgraded.
const upgradeHandlers = [];

/**
 * Diagnostics that should say their piece once per session, not once per call.
 *
 * `_shopRead()` runs every time a game draws its shop, and a console repeating
 * the same line a hundred times is a console nobody reads. Cleared by `init()`,
 * so "once" means once per game session rather than once per page load.
 */
const warnedKeys = new Set();
function warnOnce(key, message) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  try {
    console.warn(message);
  } catch {
    /* no console */
  }
}

function isGuestBootstrap(data) {
  return Boolean(data && data.player && data.player.isGuest);
}

/** Fold a host's answer into the live config, upgrading a provisional one. */
function applyBootstrap(data) {
  const next = data && typeof data === "object" ? data : {};
  if (bootstrap) {
    // A real host has already answered — unless that answer was a guest and
    // this one is the account they just signed in to.
    if (!bootstrap.offline && !(isGuestBootstrap(bootstrap) && !next.offline && !isGuestBootstrap(next))) return;
    // Still offline, unless it now carries a room token: a signed-out
    // visitor's multiplayer arrives after the site has already said "offline".
    if (next.offline && !(next.roomToken && !bootstrap.roomToken)) return;
  }
  bootstrap = next;
  window.__MESA__ = { ...(window.__MESA__ || {}), ...next };
  const waiting = bootstrapWaiters.splice(0);
  for (const resolve of waiting) resolve(bootstrap);
  for (const upgrade of [...upgradeHandlers]) {
    try {
      upgrade();
    } catch {
      /* an upgrade must never break the boot that is already running */
    }
  }
  // The host's ad policy travels with the bootstrap, and the real answer can
  // arrive after the first message. Re-point the ad capability in place so a
  // game that drew its title screen from a provisional "offline" answer still
  // gets ads once the host has spoken.
  try {
    resyncAds(next);
  } catch {
    /* ads must never break boot */
  }
}

/** Called when a provisional bootstrap is replaced by a real one. */
function onBootstrapUpgrade(fn) {
  upgradeHandlers.push(fn);
}

/**
 * The live ads capability, kept module-scoped so a later bootstrap can
 * re-point it.
 *
 * The client object is held by the game, so an upgrade must not replace it —
 * only reconfigure it. `resyncAds` is what turns a provisional "offline"
 * answer into a real ad policy when the host's second message arrives.
 */
let adClient = null;

/** A policy message from the host, or `null` when none is in force. */
function adPolicyFrom(data) {
  if (!data || typeof data !== "object") return null;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
  const enabled = Boolean(payload.enabled);
  const formats = Array.isArray(payload.formats)
    ? payload.formats.filter((f) => typeof f === "string")
    : [];
  const minIntervalMs = Math.max(
    0,
    Number(payload.minIntervalMs ?? payload.min_interval_ms ?? 180000) || 0,
  );
  return { enabled, formats, minIntervalMs };
}

/**
 * Fold a host answer into the live ad client.
 *
 * Called once at construction (from the client) and again from
 * `applyBootstrap` whenever a newer answer lands, so the game's reference is
 * never rebuilt.
 */
function resyncAds(boot) {
  if (!adClient) return;
  const fromBootstrap =
    boot && typeof boot === "object" && "adsEnabled" in boot
      ? { enabled: Boolean(boot.adsEnabled), formats: boot.adFormats, minIntervalMs: boot.adMinIntervalMs }
      : null;
  // A host that named a policy on the last bootstrap outranks the earlier
  // one; absent means keep whatever we have.
  if (fromBootstrap) adClient.applyPolicy(fromBootstrap);
}

/** Ask the host for ads. `format` is our own vocabulary; the site maps it. */
function requestAdFromHost(requestId, format, context) {
  post({ type: "mesa-ad-request", requestId, format, context: context || null });
}

/**
 * Whether a host is above us that could run a checkout.
 *
 * A published game can be opened straight from the play CDN with no Mesa
 * page over it. There is no one to show a price or take a tap there, so the
 * SDK must not pretend otherwise — it says so instead of waiting out a
 * timeout for an answer that was never coming.
 */
function hasHost() {
  return (
    typeof window !== "undefined" &&
    window.parent &&
    window.parent !== window
  );
}

/**
 * Ask the host to run a purchase the game is not allowed to make itself.
 *
 * A game runs in a sandboxed cross-origin frame: the wrong place for a price
 * confirmation, and one Stripe will not load into. So the game states *what*
 * it wants to buy — never a price, which is the server's to decide — and the
 * host draws the confirmation, runs the purchase and answers.
 *
 * Resolves the same shape the direct call would have returned, so a game
 * cannot tell the difference. Rejects with `cancelled` when the player says
 * no, and `checkout_unavailable` when there is no host to ask.
 *
 * @param {"item" | "topup"} kind
 * @param {{ sku?: string, packId?: string }} what
 */
function requestCheckoutFromHost(kind, what) {
  if (!hasHost()) {
    const err = new Error(
      "This game is running outside a Mesa page, so there is no checkout to open.",
    );
    err.code = "checkout_unavailable";
    return Promise.reject(err);
  }
  const requestId = `co_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  post({
    type: "mesa-checkout-request",
    requestId,
    kind,
    sku: what?.sku || "",
    packId: what?.packId || "",
    gameId: gameConfig?.gameId || bootstrap?.gameId || "",
  });
  return new Promise((resolve, reject) => {
    let expiry = null;
    const finish = (fn, value) => {
      window.removeEventListener("message", onMessage);
      if (expiry) clearTimeout(expiry);
      fn(value);
    };
    function onMessage(event) {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type !== "mesa-checkout-result") return;
      if (msg.requestId !== requestId) return;
      if (msg.ok === true) return finish(resolve, msg.result || { ok: true });
      const err = new Error(msg.message || "The purchase was not completed.");
      err.code = msg.code || "cancelled";
      finish(reject, err);
    }
    window.addEventListener("message", onMessage);
    expiry = setTimeout(() => {
      const err = new Error("The checkout did not answer in time.");
      err.code = "timeout";
      finish(reject, err);
    }, CHECKOUT_TIMEOUT_MS);
  });
}

/** Tell the host how an ad went, so it can meter and report it. */
function reportAdToHost(result) {
  post({ type: "mesa-ad-result", ...result });
}

/**
 * Start this init() with no host answer inherited from a previous one.
 *
 * `bootstrap` and `upgradeHandlers` are module-scoped, and a page can call
 * init() more than once. Without this the second call reads the first one's
 * answer as if the host had already spoken — so a guest inherits a signed-in
 * player's save token, and an "offline" game inherits a wallet. The symptom is
 * the worst kind: the game looks configured, and the player's saves and coins
 * belong to whoever initialized before them.
 *
 * The message listener itself is registered once per page and is left alone.
 */
function resetHostChannel() {
  bootstrap = null;
  bootstrapWaiters.length = 0;
  upgradeHandlers.length = 0;
}

// The window the message listener is attached to. A real page has exactly one,
// so this is "attach once". A test harness swaps `window` between cases, and
// keying on identity is what stops the listener being stranded on a discarded
// page — where posts from the new host would never be seen.
let listeningWindow = null;

/** Ask, once per page, for the bootstrap and the wallet changes that follow it. */
function startListening() {
  if (typeof window === "undefined" || listeningWindow === window) return;
  listeningWindow = window;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // The site posts `{ type, payload }`; a baked or spliced bootstrap is the
    // payload itself. Accept both, so one SDK reads either host.
    if (data.type === "mesa-bootstrap") {
      applyBootstrap(data.payload && typeof data.payload === "object" ? data.payload : data);
      return;
    }
    if (data.type === "mesa-wallet-changed" && bootstrap) {
      // The player topped up in the parent window. Nothing to do but let the
      // next balance read be the truth.
      bootstrap.balance = typeof data.balance === "number" ? data.balance : bootstrap.balance;
      return;
    }
    // Ads. The host owns the policy and the actual ad; we only ask and report.
    if (data.type === "mesa-ad-policy") {
      try {
        adClient?.applyPolicy(adPolicyFrom(data));
      } catch {
        /* a bad policy must never break the listener */
      }
      return;
    }
    if (data.type === "mesa-ad-show") {
      try {
        const requestId = data.requestId || data.request_id;
        adClient?.settle(requestId, data);
      } catch {
        /* ignore */
      }
    }
  });
}

function waitBootstrap(timeoutMs = 1500) {
  if (typeof window === "undefined") return Promise.resolve({});
  const baked = window.__MESA__;
  const named = Boolean(baked && (baked.gameId || baked.publicId));
  // A published game ships a baked bootstrap that names the game but carries
  // no token: the host posts the token, and the rooms grant along with it,
  // once the frame loads. Resolving on the baked copy alone dropped that
  // message, so the game minted its own guest identity and never saw the
  // grant. Wait for the host unless the page already holds a token, or there
  // is no host above us to post one.
  const hosted = typeof window.parent === "object" && window.parent !== null && window.parent !== window;
  if (baked && (baked.playerToken || (named && !hosted))) {
    // Record it as the live bootstrap, not just the return value: a game may
    // call init() a second time, and `mergedConfig()` reads this.
    if (!bootstrap || bootstrap.offline) bootstrap = baked;
    return Promise.resolve(baked);
  }
  if (bootstrap) return Promise.resolve(bootstrap);

  startListening();
  // Ask, rather than wait to be told. The frame can finish loading before the
  // site has minted the session, and a request is what makes the site post the
  // second time — without it a signed-in player's real bootstrap never arrives.
  post({ type: "mesa-bootstrap-request" });
  return new Promise((resolve) => {
    bootstrapWaiters.push(resolve);
    setTimeout(() => applyBootstrap({ offline: true }), timeoutMs);
  });
}

function deviceId() {
  const cache = readCache();
  if (cache.deviceId) return cache.deviceId;
  const id = `dev_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  writeCache({ deviceId: id });
  return id;
}

/**
 * The store-native purchase surface a desktop prelude publishes, or null.
 *
 * A desktop, Steam or App Store build has no page above it and no Stripe — the
 * store's own purchase must run instead, and only the native side can open it.
 * `mesa-desktop.js` publishes `MesaDesktop.storePurchase` on exactly those
 * builds and nothing else, so its presence is the whole signal. Reaching for it
 * on a plain web page finds `undefined` and changes nothing.
 */
function storeBilling() {
  const desktop = typeof window !== "undefined" ? window.MesaDesktop : null;
  if (!desktop || typeof desktop.storePurchase !== "function") return null;
  return desktop;
}

/** How long the host has to answer a sign-in before we give up. */
const SIGN_IN_TIMEOUT_MS = 120000;

/**
 * How long a game waits for the host to run a checkout before giving up.
 *
 * Deliberately long: the player is reading a price and tapping a button, and
 * a purchase that times out mid-decision is worse than one that waits. The
 * game is told plainly when it does expire, so its shop never spins forever.
 */
const CHECKOUT_TIMEOUT_MS = 120000;

/** Ask the host above us for something only it can do. */
function post(message) {
  try {
    (window.parent || window).postMessage(message, "*");
  } catch {
    /* not serialisable */
  }
}

/**
 * @param {MesaConfig} [config]
 */
async function init(config = {}) {
  gameConfig = config || {};
  resetHostChannel();
  // "Once per session" starts here. Diagnostics dedupe on a module-level set,
  // which would otherwise be per-page-load — long after a game has re-inited.
  warnedKeys.clear();
  // Attach the host channel unconditionally. It used to be attached only when
  // the game was *waiting* for a bootstrap, which meant a page that shipped a
  // token never listened — so a wallet change, an ad policy, or an ad result
  // posted later was dropped on the floor. Those all arrive after boot.
  startListening();
  const boot = await waitBootstrap();
  const client = new MesaClient(buildConfig(mergedConfig()));
  // An unreachable play service must cost a *feature*, never the game.
  //
  // This is the client half of a contract the server already keeps: Django's
  // mint returns None rather than failing a request, precisely so that "the
  // play service being slow, down, or unconfigured means the SDK keeps saves in
  // the browser — worse, but the game still runs". Without this catch the
  // client contradicted that. `ensureSession()` mints an identity over HTTP, so
  // a failure here rejected `__TESANA_READY__`, and a game doing the documented
  // `await window.__TESANA_READY__` threw on its first line — turning a service
  // outage into a broken game for everyone using it.
  //
  // Falling back to offline is the correct degradation, not a swallow: every
  // read already has a local or empty answer (`balance()` reports zero,
  // `shop.read()` reports a shut shutter, saves read as missing), and a later
  // bootstrap upgrade still re-runs the identity step through
  // `onBootstrapUpgrade` below. The player loses cloud features for that
  // session and keeps their game.
  try {
    await client.ensureSession();
  } catch (err) {
    client.goOffline(err);
  }
  window.__MESA_PLAYER__ = client.player.me();
  // A provisional "offline" answer can upgrade later. Re-point this client in
  // place — the game holds a reference to it — and re-run the identity step,
  // or the player's real token arrives and is ignored, leaving a signed-in
  // player with a balance frozen at zero.
  const finishUpgrade = () => {
    client.configure(buildConfig(mergedConfig()));
    client.ensureSession();
    window.__MESA_PLAYER__ = client.player.me();
  };
  onBootstrapUpgrade(finishUpgrade);
  return client;
}

/** Everything the game passed to init(), kept so an upgrade can reuse it. */
let gameConfig = null;

/** Fold the latest host answer and the game's own `init(config)` into one. */
function mergedConfig() {
  return { ...(bootstrap || {}), ...(gameConfig || {}) };
}

/** Turn a raw bootstrap + game config into the client's constructor options. */
function buildConfig(merged) {
  const endpoint = String(merged.endpoint || merged.apiBase || defaultEndpoint()).replace(/\/$/, "");
  // Keep the type the host sent: a Mesa page posts a number, a room build
  // bakes a string, and `mesa.gameId` is public surface a game may compare
  // against. Only trim, never coerce.
  const rawGameId = merged.gameId ?? merged.publicId ?? "";
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : rawGameId;
  return {
    endpoint,
    gameId,
    // The site hands this as `token`; the room build/server splice it as
    // `playerToken`. Either way it is the play service's player token, and it
    // authorises saves and the economy alike.
    token: merged.token || merged.playToken || merged.playerToken || "",
    // The host named a save service (even if it could not mint a token for
    // this player). That is a different thing from a room build, which bakes
    // one `endpoint` that *is* the save service — see `saveServiceNamed`.
    saveEndpoint: merged.saveEndpoint || merged.save_endpoint || "",
    saveToken: merged.saveToken || merged.save_token || "",
    saveServiceNamed: "saveEndpoint" in merged || "save_endpoint" in merged,
    rail: merged.rail || "mesa",
    deviceId: merged.deviceId || deviceId(),
    // The host decides whether this game may place rooms. Absent means an
    // older host that predates the capability, so keep multiplayer working.
    multiplayer: merged.multiplayer !== false,
    // Not fatal. A page opened outside Mesa has no host and no game id, and
    // it still has to play — the shop stays dark and saves stay local, which
    // is the same shape as `offline`, only without a host to have said so.
    offline: Boolean(merged.offline) || !endpoint || !gameId,
    // A signed-out visitor stays offline for saves and the shop, but the host
    // may still hand them a token that only opens rooms, so they can play
    // together on the game's own address. Used by `multiplayer.*` alone.
    roomEndpoint: merged.roomEndpoint || "",
    roomToken: merged.roomToken || "",
    player: merged.player || null,
    // The host tells the frame which public address this game answers on, so
    // a game can show and copy its own link without asking the player to
    // remember it. Absent means no vanity address is configured (or an older
    // host that predates the capability) — `vanity.public()` then reports
    // null and the game simply does not offer one.
    vanityAddress: merged.vanityAddress || merged.vanity || "",
    // Whether the host is willing to place ads in this game. Absent means an
    // older host that predates the capability; treated as "get permission
    // from the host before showing anything" rather than as a blanket yes.
    adsEnabled: merged.adsEnabled,
    adFormats: merged.adFormats || merged.ad_formats || [],
    adMinIntervalMs: merged.adMinIntervalMs ?? merged.ad_min_interval_ms,
  };
}

function defaultEndpoint() {
  if (typeof window === "undefined") return "http://localhost:8788";
  if (window.__MESA__?.endpoint) return window.__MESA__.endpoint;
  return window.location.origin;
}

class MesaClient {
  /**
   * @param {{ endpoint: string, gameId: string, token: string, rail: string, deviceId: string, multiplayer?: boolean, saveEndpoint?: string, saveToken?: string, offline?: boolean, roomEndpoint?: string, roomToken?: string, player?: object|null, vanityAddress?: string, adsEnabled?: boolean }} opts
   */
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.gameId = opts.gameId;
    this.token = opts.token;
    this.rail = opts.rail;
    this.deviceId = opts.deviceId;
    // Saves and the shop fail independently: a game can have a wallet and no
    // cloud save, or a save and no shop. Neither failing stops the game.
    //
    // Two host shapes reach here. A Mesa page hands the save service its own
    // `saveEndpoint`/`saveToken`; a room build bakes one `endpoint` that *is*
    // the save service and a single token. The second shape keeps working by
    // falling back to `endpoint` when no separate save service was named — see
    // `_saveBase`/`_saveToken`.
    this.saveEndpoint = String(opts.saveEndpoint || "").replace(/\/$/, "");
    this.saveToken = opts.saveToken || "";
    // Whether the host told us it has a save service, separately from whether
    // it could mint a token for this player. A page that sends an empty
    // `saveEndpoint` is saying "no cloud saves for you" — not "your endpoint is
    // me" — and the difference decides whether saves go quiet or 401 forever.
    //
    // Two host shapes reach here. A Mesa page names its save service; a room
    // build bakes one `endpoint` that *is* the save service and a single token,
    // and names nothing, so the endpoint stands in for it.
    this.saveServiceNamed = Boolean(opts.saveServiceNamed);
    if (!this.saveServiceNamed && this.endpoint && !this.saveEndpoint) {
      this.saveEndpoint = this.endpoint;
      this.saveToken = this.token;
    }
    // Cloud saves need an address and a credential. A guest has neither, and a
    // doomed request on every save is noise, not a save.
    this.canSaveToCloud = Boolean(this.saveEndpoint && this.saveToken);
    this.offline = Boolean(opts.offline);
    this.roomEndpoint = String(opts.roomEndpoint || "").replace(/\/$/, "");
    this.roomToken = opts.roomToken || "";
    this._player = opts.player || null;
    const reconnect = opts.multiplayerReconnect || {};
    this._mp = {
      ws: null,
      handlers: [],
      roomId: null,
      // Reconnect state. `wsUrl` is kept so a dropped socket can re-enter the
      // same room; `leaving` stops a deliberate leave from being retried.
      wsUrl: null,
      leaving: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectExhausted: false,
      statusHandlers: [],
      // Overridable so a test (or a game with unusual tolerance) can shorten
      // the wait without patching the global timers.
      reconnectBaseMs: Number(reconnect.baseMs) || MP_RECONNECT_BASE_MS,
      reconnectMaxMs: Number(reconnect.maxMs) || MP_RECONNECT_MAX_MS,
      reconnectMaxAttempts: Number(reconnect.maxAttempts) || MP_RECONNECT_MAX_ATTEMPTS,
    };
    this._mpEnabled = opts.multiplayer !== false;
    // The address the host said this game answers on. Kept on the instance so
    // `vanity.public()` is synchronous; `null` rather than `""` because "no
    // address configured" and "an empty address" should not both read as a
    // usable link.
    this._vanityAddress = opts.vanityAddress ? String(opts.vanityAddress) : null;

    this.player = {
      // No player yet means a guest, not a crash: a page with no host, and a
      // game reading `player.me()` before its first save load, both land here.
      me: () => this._player || { isGuest: true, displayName: "Player" },
      isGuest: () => !this._player || Boolean(this._player.isGuest),
      login: (identity) => this.login(identity),
      update: (patch) => this.request("PATCH", "/v1/player/me", patch),
    };
    this.db = {
      get: (key) => this._dbGet(key),
      set: (key, value) => this._dbSet(key, value),
      list: () => this.request("GET", "/v1/db").then((r) => r.items),
      collection: (name) => ({
        get: (id) => this.request("GET", `/v1/collections/${enc(name)}/${enc(id)}`),
        put: (id, data, scope) =>
          this.request("PUT", `/v1/collections/${enc(name)}/${enc(id)}`, { data, scope }),
        list: () => this.request("GET", `/v1/collections/${enc(name)}`).then((r) => r.items),
        delete: (id) => this.request("DELETE", `/v1/collections/${enc(name)}/${enc(id)}`),
      }),
    };

    // The economy belongs to the play service, not the site: coins, prices and
    // entitlements are its table's, and every call below rides the save
    // transport (`this.request`), which it authenticates with the player token.
    //
    // Reads degrade rather than throw. A game draws its shop on the first
    // frame, and a hostless page — or a service that is briefly down — has to
    // render an empty shelf instead of throwing in the middle of a menu. Writes
    // (`buy`, `topUp`) deliberately still surface their errors: a swallowed
    // failure there is a purchase that silently did nothing.
    const read = (path, fallback) =>
      this._canReach() ? this.request("GET", path).catch(() => fallback) : Promise.resolve(fallback);

    this.economy = {
      balance: () => read("/v1/economy/balance", { coins: 0, soft: 0, canSpend: false }),
      packs: () => read("/v1/economy/packs", { packs: [] }).then((r) => r.packs || []),
      topUp: (packId, opts) => this._topUp(packId, opts),
      // Signing in is the host's job — a game cannot show a password field.
      signIn: () => this._signIn(),
    };
    this.shop = {
      catalog: () => this._shopRead().then((result) => result.items),
      // `items()` cannot say *why* a shelf is bare, and the difference decides
      // what the player should see: "nothing is for sale" is an empty rack,
      // "we could not ask" is a shut shutter and a retry. `read()` is that.
      read: () => this._shopRead(),
      buy: (sku, opts) => {
        // When a Mesa page is above us, it runs the purchase: a price
        // confirmation belongs in a window we control, and a sandboxed
        // cross-origin frame is the wrong place for one. The host asks the
        // server, so the game still never states a price.
        //
        // With no host — a game opened straight from the play CDN — there is
        // nobody to draw a confirmation and no page to open checkout on, so
        // the game falls back to the direct call it has always made. That path
        // carries its own token and is exactly as safe as it was.
        if (!hasHost()) {
          return this.request("POST", "/v1/shop/buy", {
            sku,
            clientRequestId: opts?.clientRequestId,
          });
        }
        return requestCheckoutFromHost("item", { sku: sku }).then((result) => {
          if (result && result.ok === true) return result;
          // A host that answered without a grant is a refusal, not a success.
          const err = new Error("The purchase was not completed.");
          err.code = "cancelled";
          throw err;
        });
      },
      entitlements: () => read("/v1/shop/entitlements", { items: [] }).then((r) => r.items || []),
      // Kept so games written against the shop's earlier shape still run, with
      // the shape they expect: `items()` was an array, `inventory()` a sku →
      // count map, and `balance()` a bare number. The service models an
      // entitlement as owned-or-not, so every owned sku maps to one.
      items: () => this.shop.catalog(),
      inventory: () =>
        this.shop.entitlements().then((list) => Object.fromEntries(list.map((e) => [e.sku, 1]))),
      balance: () => this.economy.balance().then((r) => r.coins || 0),
      signIn: () => this._signIn(),
    };

    // Leaderboards and achievements. Both are declared by the build (the same
    // way a shop catalogue is) and both are client-reported, so neither is
    // authoritative — a leaderboard is a ranking to show off, not a prize
    // table. Reads degrade like the shop's, because a scoreboard is drawn on a
    // game-over screen and must never take that screen down with it.
    //
    // Writes surface their errors, like `buy` does: an unknown board id is a
    // build mistake the developer needs to see, not a silent nothing. Gameplay
    // calls should still catch — a score that fails to send is not a reason to
    // break the game — but the failure is visible rather than swallowed here.
    this.scores = {
      // Report a result. Only kept if it beats this player's own best, so
      // calling it on every run is cheap and idempotent. Resolves
      // `{ board, score, best, improved }` — `improved` is the only thing a
      // "new high score!" banner needs.
      submit: (board, score) =>
        this.request("POST", "/v1/scores", { board: String(board || ""), score: Number(score) }),
      // One board's standings, best first. `{ board, order, entries }`, where
      // an entry is `{ rank, score, displayName, isGuest, you? }`. A guest the
      // site vouches for is listed under its placeholder name; one the game
      // minted for itself is not.
      top: (board, opts) =>
        read(
          `/v1/scores/${enc(board)}?gameId=${enc(this.gameId)}${
            opts && opts.limit ? `&limit=${Number(opts.limit)}` : ""
          }`,
          { board: String(board || ""), entries: [] },
        ),
      // This player's own bests across every board they have set.
      me: () => read("/v1/scores", { scores: [] }).then((r) => r.scores || []),
      // Convenience: this player's best on one board, or `null`, for a HUD.
      best: (board) =>
        this.scores.me().then((rows) => rows.find((row) => row.board === board) || null),
    };

    this.achievements = {
      // Every declared achievement, with this player's progress and unlocks
      // folded in — one call is enough to draw the whole screen.
      list: () => read("/v1/achievements", { items: [] }).then((r) => r.items || []),
      // What the player has actually earned, for a badge row or a count.
      unlocked: () => this.achievements.list().then((items) => items.filter((a) => a.unlocked)),
      // Unlock outright. Idempotent: a second call reports `alreadyUnlocked`
      // and keeps the original timestamp rather than rewriting it, so a game
      // that fires this on every frame cannot corrupt the player's history.
      unlock: (id) => this.request("POST", "/v1/achievements/unlock", { id: String(id || "") }),
      // Add to a named counter and unlock whatever the new total crosses.
      // Monotonic — progress only ever goes up — so a replayed report can
      // unlock something sooner but can never walk a target backwards.
      //
      // Call this at a checkpoint or at the end of a run, not per event: each
      // call is a round trip, and reporting "kills" once per kill would spend
      // the whole rate limit on one fight.
      progress: (stat, delta) =>
        this.request("POST", "/v1/achievements/progress", {
          stat: String(stat || ""),
          delta: delta == null ? 1 : Number(delta),
        }),
    };

    // A vanity address is the game's own name on mesa.ai — the thing a
    // creator puts on a poster. It is claimed and released by the site, and
    // the play service is where a label's owner is decided, so the mutating
    // calls are authenticated; the lookup is public because a game may want
    // to show its own link before anyone signs in.
    this.vanity = {
      // The host's answer, or `null` on a page with no host. Synchronous so a
      // title screen can print its own address without awaiting anything.
      public: () => this._vanityAddress || null,
      // What this game currently answers on, resolved server-side (which is
      // the only place that knows whether a label has moved on).
      //
      // `gameId` is required by the route and was missing here, so every call
      // was a 400 that `read` swallowed into the host's own answer — the
      // server was never actually asked. Sending it is what makes this a real
      // lookup rather than an echo of the bootstrap.
      current: () =>
        read(
          `/v1/vanity/current?gameId=${enc(this.gameId)}`,
          { address: this._vanityAddress || null },
        ).then((r) => r.address || this._vanityAddress || null),
      // Is this label free? Never throws; an unreachable service reports
      // `status: "unreachable"` so the UI can offer a retry rather than
      // claiming a name is taken.
      check: (label) => this._vanityCheck(label),
      // Claim it. Rejects with `code` on anything the player can fix:
      // `taken`, `reserved`, `invalid`, `login_required`.
      claim: (label) => this.request("POST", "/v1/vanity/claim", { label: String(label || "") }),
      // Point the game at a label it already owns, or at another label of
      // the player's. The server decides what is allowed.
      set: (label) => this.request("POST", "/v1/vanity/set", { label: String(label || "") }),
      release: () => this.request("POST", "/v1/vanity/release", {}),
      // Convenience for a "share your game" button: a candidate label the
      // player can edit, and the check that says whether it is free.
      suggest: (source) => {
        const label = slugify(source || "");
        const problem = vanityProblem(label);
        return { label, problem, valid: !problem };
      },
    };

    // Ads are the host's business, not ours: the network, the SDK key and
    // the consent screen all live in a window we do not control. A game asks
    // through this object and the host decides whether, when and what to
    // show. Nothing here ever draws an ad itself.
    this.ads = this._makeAds(opts);
    // Kept module-scoped so a bootstrap that lands later can re-point this
    // same object in place, rather than the game holding a stale policy.
    adClient = this.ads;

    this.multiplayer = {
      // Read this before drawing a lobby: when it is false the game is not
      // allowed rooms yet and the calls below refuse.
      enabled: this._mpEnabled,
      // `_mpEnabled` alone is not enough. A game with no host has multiplayer
      // "allowed" and no service to ask, so `list()` used to reject with a
      // transport error — and a game that draws a lobby on load (which the
      // skill tells games to do) got an unhandled rejection on its title
      // screen. An empty lobby is the honest answer for a game that cannot
      // reach the room service, and it is what the game can render.
      list: () =>
        this._mpEnabled && (!this.offline || this._roomsOnly())
          ? this._mpRequest("GET", "/v1/mp/rooms")
              .then((r) => r.rooms)
              .catch(() => [])
          : Promise.resolve([]),
      create: (opts) =>
        this._mpEnabled
          ? this._mpEnter(this._mpRequest("POST", "/v1/mp/rooms", opts || {}))
          : this._mpRefuse(),
      join: (roomId) =>
        this._mpEnabled
          ? this._mpEnter(this._mpRequest("POST", `/v1/mp/rooms/${enc(roomId)}/join`))
          : this._mpRefuse(),
      quickJoin: (opts) =>
        this._mpEnabled
          ? this._mpEnter(this._mpRequest("POST", "/v1/mp/quick-join", opts || {}))
          : this._mpRefuse(),
      send: (data) => this._mpSend(data),
      on: (fn) => this._mpOn(fn),
      // Connection status, separate from room messages: a game can show
      // "reconnecting" without mistaking it for something a player did.
      onStatus: (fn) => this._mpOnStatus(fn),
      leave: () => this._mpLeave(),
    };
  }

  async ensureSession() {
    // The site posted us a player and a token: that identity is authoritative
    // and there is nothing to mint. Minting here would be the guest-identity
    // bug again — the host's token is dropped and the grant goes unread.
    if (this._player && this.token) return this._player;
    if (this.offline) return this._player;
    if (this.token) {
      try {
        const me = await this.request("GET", "/v1/player/me");
        this._player = me.player;
        return this._player;
      } catch {
        this.token = "";
      }
    }
    const guest = await this.request("POST", "/v1/auth/guest", {
      gameId: this.gameId,
      deviceId: this.deviceId,
      rail: this.rail,
    });
    this.token = guest.token;
    this._player = guest.player;
    writeCache({ token: this.token, gameId: this.gameId });
    return this._player;
  }

  /**
   * Link this device to a Mesa account. Saves follow the account after this.
   * @param {{ mesaUserId?: string, email?: string }} identity
   */
  async login(identity = {}) {
    const mesaUserId = identity.mesaUserId || identity.email || this._player?.displayName || "linked-user";
    const result = await this.request("POST", "/v1/auth/link", {
      mesaUserId,
      email: identity.email || mesaUserId,
    });
    this.token = result.token;
    this._player = result.player;
    writeCache({ token: this.token });
    return this._player;
  }

  /**
   * Buy a coin pack.
   *
   * When a Mesa page is above us it runs the whole thing — it opens
   * checkout in a window of its own, which is where a payment form belongs.
   * The game only asks. With no host (a game opened straight from the play
   * CDN) there is no page to open checkout on, so the standalone result is
   * returned as-is for the page to follow itself.
   * @param {string} packId
   * @param {{ clientRequestId?: string }} [opts]
   */
  async _topUp(packId, opts = {}) {
    // A desktop/Steam build buys through its store, not through a Mesa page.
    // `hasHost()` is false there (no parent frame) and Stripe is the wrong rail,
    // so store billing is checked first — its presence is what distinguishes a
    // storefront build from a page opened straight from the play CDN.
    const desktop = storeBilling();
    if (desktop) return this._topUpViaStore(desktop, packId);
    if (hasHost()) {
      // The host owns checkout: it opens Stripe in a window of its own and
      // tells us how it went. We only ask. The message names are the host's,
      // because the host is the side that already had a top-up flow — this SDK
      // used to post a name nobody listened for, which is why asking to buy
      // coins inside a game did nothing at all.
      post({ type: "mesa-topup-request", packId });
      return new Promise((resolve) => {
        let expiry = null;
        const finish = (result) => {
          window.removeEventListener("message", onMessage);
          if (expiry) clearTimeout(expiry);
          resolve(result);
        };
        function onMessage(event) {
          const msg = event.data;
          if (!msg || msg.type !== "mesa-topup-result") return;
          finish({ ok: true, purchased: msg.purchased === true, balance: msg.balance });
        }
        window.addEventListener("message", onMessage);
        // Declining is an answer too. A player who closed checkout should get
        // their shop back, not watch it wait out a timeout.
        expiry = setTimeout(() => finish({ ok: false, purchased: false, code: "timeout" }), CHECKOUT_TIMEOUT_MS);
      });
    }
    const result = await this.request("POST", "/v1/economy/top-up", {
      packId,
      clientRequestId: opts.clientRequestId,
    });
    return result;
  }

  /**
   * Buy a coin pack through the store this build ships on.
   *
   * Two halves, in this order for a reason: the store takes the money, and only
   * then does the play service turn the store's own transaction id into coins.
   * The id is the store's, not ours — it is the one thing a client cannot
   * invent twice, so it is what makes the credit idempotent when the purchase
   * is replayed after a crash. Reporting before a successful purchase would
   * credit coins for a purchase that never happened.
   *
   * The result is shaped like the web top-up: a purchase returns the new
   * balance, and a decline is `{ ok: false, code: "cancelled" }` rather than an
   * exception, because a player closing the store sheet is a normal answer.
   *
   * @param {any} desktop  `window.MesaDesktop` with `storePurchase`
   * @param {string} packId
   */
  async _topUpViaStore(desktop, packId) {
    // Sign in *before* the store sheet, never after.
    //
    // Coins are account-scoped, so a player with no account has nothing to hold
    // them: `redeem` refuses an unlinked player, and a guest is exactly that.
    // On the web rail the refusal arrives harmlessly first, because the host
    // runs checkout server-side and no money has moved yet. Here the store
    // charges on this side of the wire, so a refusal discovered at redemption
    // is a player who was billed and got nothing — the one outcome worth
    // blocking a sale over. A launcher that cannot sign anyone in therefore
    // refuses the sale rather than taking payment it cannot honour.
    const canBuy = () => !this.offline && !this._isGuestSession();
    if (!canBuy()) {
      if (typeof desktop.signIn !== "function") {
        return { ok: false, purchased: false, code: "login_required" };
      }
      const answer = await this._signInViaNative(canBuy);
      if (!answer || answer.signedIn !== true) {
        return { ok: false, purchased: false, code: "login_required" };
      }
    }
    const purchase = await desktop.storePurchase({ packId });
    if (!purchase || purchase.ok !== true) {
      return {
        ok: false,
        purchased: false,
        code: (purchase && purchase.code) || "cancelled",
      };
    }
    // A store that charged but reported no id cannot be credited — there would
    // be no way to tell a replay from a new purchase. Surface it as a failure
    // rather than granting an untraceable lot.
    if (!purchase.transactionId) {
      const err = new Error("The store did not return a transaction id.");
      err.code = "no_transaction_id";
      throw err;
    }
    return this.request("POST", "/v1/economy/redeem", {
      rail: this.rail,
      packId,
      transactionId: purchase.transactionId,
    });
  }

  _mpRefuse() {
    const err = new Error("Multiplayer is not available for this game yet");
    err.code = "multiplayer_disabled";
    return Promise.reject(err);
  }

  /**
   * @param {Promise<{ wsUrl: string, roomId?: string, room?: object, playerId?: string }>} session
   */
  async _mpEnter(session) {
    const joined = await session;
    await this._mpOpen(joined.wsUrl);
    this._mp.roomId = joined.roomId || joined.room?.id || null;
    return {
      wsUrl: joined.wsUrl,
      roomId: this._mp.roomId,
      playerId: joined.playerId || this._player?.id,
      room: joined.room,
    };
  }

  /**
   * @param {string} wsUrl
   */
  _mpOpen(wsUrl) {
    if (typeof WebSocket === "undefined") {
      throw new Error("Mesa.multiplayer requires WebSocket");
    }
    this._mpClose();
    // Reconnecting is re-entering the same room, so the URL is kept. The
    // grant inside it is checked by the room host, which is what lets a
    // client recover from a scale-in without going back through the lobby.
    this._mp.wsUrl = wsUrl;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this._mp.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          this._mpClose();
          reject(new Error("multiplayer connect timeout"));
        }
      }, 8000);
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg?.t === "hello" && !opened) {
          opened = true;
          clearTimeout(timer);
          // A reconnect that got its hello is a recovered session: clear the
          // attempt counter so a later blip starts from a short delay again,
          // and tell the game it is back.
          if (this._mp.reconnectAttempts > 0) {
            this._mpEmitStatus({ status: "reconnected" });
          }
          this._mp.reconnectAttempts = 0;
          resolve(msg);
        }
        for (const fn of this._mp.handlers) {
          try {
            fn(msg);
          } catch {
            /* game handler */
          }
        }
      };
      ws.onerror = () => {
        if (!opened) {
          /* onclose rejects */
        }
      };
      ws.onclose = (event) => {
        if (this._mp.ws === ws) this._mp.ws = null;
        if (!opened) {
          clearTimeout(timer);
          reject(new Error(event.reason || "multiplayer closed"));
          return;
        }
        // The socket dropped after we were in the room. That is a scale-in,
        // a deploy, or a network blip — none of which the player caused, and
        // all of which used to leave them silently alone in a match. Retry
        // unless they actually meant to leave.
        this._mpScheduleReconnect();
      };
    });
  }

  /**
   * Try to get back into a room we were dropped out of.
   *
   * Jittered exponential backoff, capped, and bounded in attempts: jitter
   * because a scale-in drops every player at the same instant and un-jittered
   * retries would arrive as one synchronized spike at the very moment the
   * fleet is least able to take it. Bounded because a room that really is
   * gone should stop being retried and say so.
   */
  _mpScheduleReconnect() {
    const mp = this._mp;
    if (!mp.wsUrl || mp.leaving) return;
    if (mp.reconnectTimer) return;
    const attempts = (mp.reconnectAttempts || 0) + 1;
    mp.reconnectAttempts = attempts;
    if (attempts > mp.reconnectMaxAttempts) {
      mp.reconnectExhausted = true;
      this._mpEmitStatus({ status: "disconnected", reason: "reconnect_exhausted" });
      return;
    }
    this._mpEmitStatus({ status: "reconnecting", attempt: attempts });
    const base = Math.min(mp.reconnectMaxMs, mp.reconnectBaseMs * 2 ** (attempts - 1));
    const delay = base * (0.5 + Math.random() * 0.5);
    mp.reconnectTimer = setTimeout(() => {
      mp.reconnectTimer = null;
      if (mp.leaving) return;
      this._mpOpen(mp.wsUrl).catch(() => {
        // Still not up — schedule the next attempt, which is where the
        // attempt count grows and the backoff widens.
        this._mpScheduleReconnect();
      });
    }, delay);
  }

  _mpEmitStatus(status) {
    for (const fn of this._mp.statusHandlers) {
      try {
        fn(status);
      } catch {
        /* game handler */
      }
    }
  }

  _mpClose() {
    const ws = this._mp.ws;
    this._mp.ws = null;
    if (this._mp.reconnectTimer) {
      clearTimeout(this._mp.reconnectTimer);
      this._mp.reconnectTimer = null;
    }
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {object} data
   */
  _mpSend(data) {
    const ws = this._mp.ws;
    if (!ws || ws.readyState !== 1) throw new Error("Not in a room");
    ws.send(JSON.stringify(data && typeof data === "object" ? data : { value: data }));
  }

  /**
   * @param {(msg: object) => void} fn
   */
  _mpOn(fn) {
    if (typeof fn !== "function") throw new Error("mesa.multiplayer.on requires a function");
    this._mp.handlers.push(fn);
    return () => {
      this._mp.handlers = this._mp.handlers.filter((handler) => handler !== fn);
    };
  }

  /**
   * @param {(status: { status: string, reason?: string }) => void} fn
   */
  _mpOnStatus(fn) {
    if (typeof fn !== "function") throw new Error("mesa.multiplayer.onStatus requires a function");
    this._mp.statusHandlers.push(fn);
    return () => {
      this._mp.statusHandlers = this._mp.statusHandlers.filter((handler) => handler !== fn);
    };
  }

  async _mpLeave() {
    const roomId = this._mp.roomId;
    // Set before closing: `onclose` fires synchronously on `close()`, and
    // without this flag a deliberate leave would look like a dropped socket
    // and schedule a reconnect into the room the player just left.
    this._mp.leaving = true;
    this._mpClose();
    this._mp.roomId = null;
    this._mp.wsUrl = null;
    this._mp.reconnectAttempts = 0;
    this._mp.reconnectExhausted = false;
    try {
      if (!roomId) return { ok: true, room: null };
      try {
        return await this._mpRequest("POST", `/v1/mp/rooms/${enc(roomId)}/leave`);
      } catch {
        return { ok: true, room: null };
      }
    } finally {
      this._mp.leaving = false;
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  request(method, path, body) {
    return this._send(this._baseFor(), this._authFor(), method, path, body);
  }

  /** Whether multiplayer rides a rooms-only token while everything else is offline. */
  _roomsOnly() {
    return Boolean(this.offline && this.roomEndpoint && this.roomToken);
  }

  _mpRequest(method, path, body) {
    return this._roomsOnly()
      ? this._send(this.roomEndpoint, this.roomToken, method, path, body)
      : this.request(method, path, body);
  }

  async _send(base, authToken, method, path, body) {
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    if (this.deviceId) headers["x-mesa-device"] = this.deviceId;
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body == null || method === "GET" ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // No cache fallback here. `_dbGet` owns the local-cache behaviour for
      // saves, keyed by the bare key; this generic transport path would have
      // to re-derive that key from the URL, and getting it wrong returns a
      // confident `null` that pre-empts the real fallback — a save the player
      // still has, reported as missing.
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || res.statusText);
      error.code = data.error;
      error.status = res.status;
      throw error;
    }
    return data;
  }

  /**
   * Re-point this client at a newer host answer, in place.
   *
   * The game holds a reference to this object, so an upgrade must never
   * replace it. This is what turns a provisional "offline" bootstrap into a
   * real one: without it a signed-in player's token arrives and is dropped,
   * and the only symptom is a wallet that never leaves zero.
   */
  configure(config) {
    this.endpoint = String(config.endpoint || "").replace(/\/$/, "");
    this.gameId = config.gameId ?? "";
    this.token = config.token || "";
    this.saveEndpoint = String(config.saveEndpoint || "").replace(/\/$/, "");
    this.saveToken = config.saveToken || "";
    this.saveServiceNamed = Boolean(config.saveServiceNamed);
    if (!this.saveServiceNamed && this.endpoint && !this.saveEndpoint) {
      this.saveEndpoint = this.endpoint;
      this.saveToken = this.token;
    }
    this.canSaveToCloud = Boolean(this.saveEndpoint && this.saveToken);
    this.offline = Boolean(config.offline) || !this.endpoint || !this.gameId;
    this.roomEndpoint = String(config.roomEndpoint || "").replace(/\/$/, "");
    this.roomToken = config.roomToken || "";
    if (config.player) this._player = config.player;
    if (config.vanityAddress !== undefined) {
      this._vanityAddress = config.vanityAddress ? String(config.vanityAddress) : null;
    }
    if (this.ads && ("adsEnabled" in config || "adFormats" in config)) {
      this.ads.applyPolicy({
        enabled: Boolean(config.adsEnabled),
        formats: config.adFormats,
        minIntervalMs: config.adMinIntervalMs,
      });
    }
    this._mpEnabled = config.multiplayer !== false;
    this.multiplayer.enabled = this._mpEnabled;
    return this;
  }

  /**
   * Carry on without the play service.
   *
   * The boot path calls this when the identity step fails — an unreachable
   * endpoint, a 500, a bad secret, a cert the browser will not accept. A game
   * must not die of it: the server side of this contract already returns no
   * token and lets the game run, so the client falls back to exactly the state
   * a game with no endpoint is in.
   *
   * Marking the client offline is the honest outcome rather than a silent
   * swallow. Every read already has an offline answer — `balance()` reports
   * zero coins and `canSpend: false`, the shop reports a shut shutter, saves
   * read as absent and write to the local cache — so the game draws its
   * title screen instead of throwing. A later bootstrap upgrade re-runs the
   * identity step and flips this back off.
   *
   * The token is cleared rather than kept: it is the thing that failed to
   * authenticate, and half an identity is worse than none — every call would
   * retry a credential the service just refused.
   *
   * @param {unknown} [reason] the failure, kept for diagnostics
   */
  goOffline(reason) {
    this.offline = true;
    this.token = "";
    this.saveToken = "";
    this.canSaveToCloud = false;
    this._mpEnabled = false;
    this.multiplayer.enabled = false;
    // One deduped line rather than a wall: a page whose endpoint is
    // misconfigured would otherwise log this on every call.
    warnOnce(
      "play-session",
      `[mesa] play service unavailable; running without cloud saves or the shop${
        reason ? ` (${(reason && reason.message) || reason})` : ""
      }`,
    );
    return this;
  }

  /**
   * Which origin and which credential a path uses.
   *
   * A Mesa page gives the save service its own address and token; a room
   * build bakes one `endpoint` that is the save service and one token. Both
   * collapse to `_baseFor` / `_authFor` here so no call site has to know which
   * shape it is running in.
   */
  _baseFor() {
    return this.saveEndpoint || this.endpoint;
  }

  _authFor() {
    return this.saveEndpoint ? this.saveToken : this.token;
  }

  /**
   * Whether a call has somewhere to go at all.
   *
   * A game opened outside a Mesa page — or a build nothing ever answered —
   * has no address, and `fetch` on a relative URL throws. Reads check this and
   * answer empty; that is what keeps a shop drawing on a hostless page instead
   * of taking the menu down with it.
   */
  _canReach() {
    return Boolean(this._baseFor() && this.gameId);
  }

  /**
   * This game's shelf, and whether we actually reached it.
   *
   * `status` is `ok`, `empty` (the server genuinely sells nothing here — do
   * not retry), `no_host` (nothing was ever handed to this page), or
   * `unreachable` (show a retry). Reads never reject; a shop that cannot be
   * priced must not take the menu down with it.
   */
  async _shopRead() {
    if (!this._canReach()) {
      warnOnce(
        "shop-no-host",
        "Mesa shop: nothing to ask — this game was not handed an API address."
          + " Running outside a Mesa page does that; so does a page that never"
          + " answered the bootstrap request.",
      );
      return { status: "no_host", items: [] };
    }
    try {
      const data = await this.request("GET", "/v1/shop/catalog");
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        // The one that earns its keep: an empty shelf and a catalogue nobody
        // declared look identical from inside a game, and this names the file
        // to fix. It is the runtime half of the build's empty-trader gate.
        warnOnce(
          "shop-empty",
          "Mesa shop: the server sells nothing for this game. If it is meant"
            + " to, the build has to declare its items in assets/ui/shop.json —"
            + " the server only sells what it was told about.",
        );
        return { status: "empty", items: [] };
      }
      return { status: "ok", items };
    } catch (err) {
      warnOnce(
        "shop-unreachable",
        `Mesa shop: could not reach the shop (${(err && err.message) || "request failed"}).`
          + " The game keeps playing; nothing is purchasable until it answers.",
      );
      return { status: "unreachable", items: [] };
    }
  }

  // ------------------------------------------------------------------ vanity
  //
  // A game's own address. The claim and the lookup both belong to the site
  // and the play service; this is only the game's side of it. Checks never
  // throw, because a name field that reports "taken" when the network is
  // down is worse than one that says "try again".
  //
  // The check is strict about the label itself — it does not rewrite what the
  // player typed. Turning a phrase into a candidate is `suggest()`'s job, and
  // the two are deliberately separate: silently hyphenating what someone
  // asked for is how a player ends up owning a name they did not choose.
  async _vanityCheck(label) {
    const candidate = String(label || "").trim().toLowerCase();
    const problem = vanityProblem(candidate);
    if (problem) return { label: candidate, status: problem, available: false };
    if (!this._canReach()) return { label: candidate, status: "no_host", available: false };
    try {
      const data = await this.request("GET", `/v1/vanity/available/${enc(candidate)}`);
      return {
        label: candidate,
        status: "ok",
        available: Boolean(data?.available),
      };
    } catch {
      return { label: candidate, status: "unreachable", available: false };
    }
  }

  // --------------------------------------------------------------------- ads
  //
  // A thin, honest wrapper around the host. The policy (whether ads run, how
  // often, which formats) is the host's and arrives in the bootstrap; the
  // network key and the consent screen never cross into the frame. A game can
  // therefore rely on one rule: if `ads.enabled()` is false, nothing will ever
  // be shown, and it should not pretend otherwise.
  _makeAds(opts) {
    const state = {
      enabled: Boolean(opts.adsEnabled),
      formats: Array.isArray(opts.adFormats) ? opts.adFormats.slice() : [],
      minIntervalMs:
        opts.adMinIntervalMs == null ? 180000 : Math.max(0, Number(opts.adMinIntervalMs) || 0),
      lastShownAt: 0,
      pending: new Map(),
      seq: 0,
    };
    const self = this;

    function applyPolicy(policy) {
      if (!policy || typeof policy !== "object") return state;
      if ("enabled" in policy) state.enabled = Boolean(policy.enabled);
      if (Array.isArray(policy.formats)) state.formats = policy.formats.slice();
      if (policy.minIntervalMs != null) {
        state.minIntervalMs = Math.max(0, Number(policy.minIntervalMs) || 0);
      }
      return state;
    }

    return {
      // Live state, for a menu that wants to show "no ads on this account".
      get enabled() {
        return state.enabled;
      },
      formats: () => state.formats.slice(),
      /** May the host show something of this format right now? */
      ready: (format) => {
        if (!state.enabled) return false;
        if (Date.now() - state.lastShownAt < state.minIntervalMs) return false;
        return !format || state.formats.length === 0 || state.formats.includes(format);
      },
      /**
       * Ask the host to show an ad. Resolves `{ shown, format, reason }` and
       * never rejects: an ad that did not run is a normal answer, not an
       * error the player must see. `reason` is one of `disabled`,
       * `too_soon`, `unsupported`, `declined`, `no_host`, `error`.
       */
      show: (format, context) => {
        const wanted = format || "interstitial";
        if (!state.enabled) return Promise.resolve({ shown: false, format: wanted, reason: "disabled" });
        if (Date.now() - state.lastShownAt < state.minIntervalMs) {
          return Promise.resolve({ shown: false, format: wanted, reason: "too_soon" });
        }
        if (state.formats.length && !state.formats.includes(wanted)) {
          return Promise.resolve({ shown: false, format: wanted, reason: "unsupported" });
        }
        const requestId = `ad_${Date.now().toString(36)}_${(state.seq += 1)}`;
        return new Promise((resolve) => {
          const finish = (result) => {
            state.pending.delete(requestId);
            // Record the attempt either way: a host that declined should not
            // be asked again on the very next frame.
            state.lastShownAt = Date.now();
            reportAdToHost({ requestId, format: wanted, ...result });
            resolve({ format: wanted, ...result });
          };
          state.pending.set(requestId, finish);
          requestAdFromHost(requestId, wanted, context);
          // No host above us, or one that never answers. Ten seconds is long
          // enough for a real network fill and short enough not to stall a
          // game waiting at a level boundary.
          setTimeout(
            () => state.pending.has(requestId) && finish({ shown: false, reason: "no_host" }),
            10000,
          );
        });
      },
      // ---- internal wiring (used by the bootstrap listener) ----
      applyPolicy,
      settle(requestId, message) {
        const finish = state.pending.get(requestId);
        if (!finish) return;
        const shown = Boolean(message.shown);
        finish({ shown, reason: message.reason || (shown ? "ok" : "declined") });
      },
    };
  }

  // ------------------------------------------------------------------ saves
  //
  // Writes go to the local cache first, always, so a failed upload is a save
  // that has not synced yet rather than a save the player has lost. Reads fall
  // back to the last cloud value when the service is unreachable — the last
  // known state beats dropping the player back into a new game.
  async _dbGet(key) {
    const local = (readCache().db || {})[key];
    if (!this.canSaveToCloud) return local === undefined ? null : local;
    try {
      const data = await this.request("GET", `/v1/db/${enc(key)}`);
      if ((data.value === undefined || data.value === null) && local != null && this._isGuestSession()) {
        // A guest's first cloud session, after playing with saves kept only in
        // this browser: their progress is theirs, so it goes up rather than
        // being overwritten by the empty cloud answer.
        this.request("PUT", `/v1/db/${enc(key)}`, { value: local }).catch(() => {});
        return local;
      }
      const db = readCache().db || {};
      db[key] = data.value;
      writeCache({ db });
      return data.value === undefined ? null : data.value;
    } catch {
      return local === undefined ? null : local;
    }
  }

  async _dbSet(key, value) {
    const db = readCache().db || {};
    db[key] = value;
    writeCache({ db });
    if (!this.canSaveToCloud) return value;
    try {
      await this.request("PUT", `/v1/db/${enc(key)}`, { value });
    } catch {
      /* written locally already; it will sync when the service is back */
    }
    return value;
  }

  /**
   * Ask the host to open its sign-in UI, then wait to be told it is done.
   *
   * The account UI belongs to the host: a game cannot show a password field in
   * an iframe the site does not control, and should not be trusted with one.
   * Resolves when the host says the player is signed in. The bootstrap that
   * follows carries a token, which flips `offline` off, so balance(),
   * inventory() and buy() start working without the game reloading.
   */
  _signIn() {
    const signedIn = () => !this.offline && !this._isGuestSession();
    if (signedIn()) return Promise.resolve({ signedIn: true });
    // A desktop/Steam build has no host to draw an account UI. Its launcher is
    // the sign-in surface, and only it can vouch for the player to the host
    // with the internal secret that account linking requires — so this asks the
    // native side to run sign-in and then waits for the bootstrap that carries
    // the linked token, exactly as the web path waits for the host's answer.
    const desktop = storeBilling();
    if (desktop && typeof desktop.signIn === "function") return this._signInViaNative(signedIn);
    post({ type: "mesa-sign-in-request", gameId: this.gameId });
    return new Promise((resolve) => {
      let expiry = null;
      const finish = (result) => {
        if (expiry) clearTimeout(expiry);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      // The player is signed in, but the token travels in a separate bootstrap
      // and may still be in flight. Resolving the moment we hear "yes" would
      // let a game that awaits signIn() and then immediately buys be refused a
      // second time for still being offline — the exact dead end this whole
      // exchange exists to remove.
      const waitForToken = (attempt) => {
        if (signedIn()) return finish({ signedIn: true });
        if ((attempt || 0) >= 60) return finish({ signedIn: true });
        setTimeout(() => waitForToken((attempt || 0) + 1), 50);
      };
      function onMessage(event) {
        const msg = event.data;
        if (!msg || msg.type !== "mesa-signed-in") return;
        if (!msg.signedIn) return finish({ signedIn: false });
        waitForToken(0);
      }
      window.addEventListener("message", onMessage);
      // Declining is an answer too. Report what is actually true rather than
      // leaving the game's promise pending forever.
      expiry = setTimeout(() => finish({ signedIn: signedIn() }), SIGN_IN_TIMEOUT_MS);
    });
  }

  /** A guest the site vouches for: saves in the cloud, but has no account to spend from. */
  _isGuestSession() {
    if (!this._player) return false;
    // Two signals, because the answer arrives from two places. A host posts
    // `isGuest: true` in its bootstrap — the web's word for it — while an
    // identity this client resolves itself (`/v1/player/me`) reports `isLinked`
    // and no `isGuest` at all. Reading only the first would let a native
    // session, whose whole point is an account-free identity, pass as a
    // signed-in player; the store path gates a sale on exactly this, so that
    // mistake is a card charged for coins we then refuse to grant.
    return this._player.isGuest === true || this._player.isLinked === false;
  }

  /**
   * Ask the native launcher to sign the player in, then wait for the token.
   *
   * The launcher is the only party that can reach the host route with the
   * internal secret that account linking needs, so this hands it the request
   * and then watches `signedIn()` — which flips the moment the linked bootstrap
   * replaces the guest one. Polling rather than listening is deliberate: the
   * bootstrap arrives through the SDK's own upgrade path (`onBootstrapUpgrade`
   * re-points the client and re-runs identity), and there is no second channel
   * to subscribe to here.
   */
  _signInViaNative(signedIn) {
    return window.MesaDesktop.signIn({ gameId: this.gameId }).then((answer) => {
      if (!answer || answer.ok !== true || answer.signedIn !== true) return { signedIn: false };
      return new Promise((resolve) => {
        const waitForToken = (attempt) => {
          if (signedIn()) return resolve({ signedIn: true });
          // Report what is actually true when the wait runs out. The web path
          // predates this and answers optimistically; its launcher-started
          // sign-in gets a fresh page instead, so it never observes the lie.
          // Here the caller is a store purchase deciding whether money may
          // move, and "probably signed in" is not a state a charge may proceed
          // on — a token that never arrived means no account to hold the coins.
          if ((attempt || 0) >= 60) return resolve({ signedIn: signedIn() });
          setTimeout(() => waitForToken((attempt || 0) + 1), 50);
        };
        waitForToken(0);
      });
    });
  }

}

function enc(value) {
  return encodeURIComponent(String(value));
}


  var api = { init: init, MesaClient: MesaClient, version: VERSION };
  root.Mesa = api;
  // A game's first line may be `await window.__TESANA_READY__`, the promise
  // form the engine's skills teach, so start booting the moment this loads.
  // Resolving it here — rather than waiting for the game to call init() — is
  // what lets a game read its save before the first draw instead of painting a
  // default state and snapping.
  root.__TESANA_READY__ = init();
})(typeof window !== "undefined" ? window : globalThis);
