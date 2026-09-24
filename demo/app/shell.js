/*
 * tesana-shell.js — injected by build/build-game.mjs as the FIRST <script> of
 * web-export/index.html. Plain ES2020, no build step, nothing importable: games
 * never reference Tesana code. Provides the Studio bridge, console ring, mute /
 * volume, mobile hygiene (isMobile), screenshots, loading overlay, watermark and
 * the QA hooks. Reads
 * {title, isMobile, orientation, disableWatermark, watermarkUrl, logoUrl, posterUrl, gameType}
 * from <script type="application/json" id="tesana-meta">.
 *
 * Watermark: the Tesana badge PNG (`watermarkUrl`, inlined by the build) in a
 * #tesana-watermark overlay with the same geometry as Godot's presets/_shared.py
 * — a 16:9 box fitted and centred in the viewport, badge 11.5% of the box width
 * at its bottom-right (margins 2.25% right / 1.5% bottom), pointer-events:none,
 * revealed once the game is ready; narrower than 16:9 the box hugs the bottom
 * edge and the badge is at least 96px wide. `disableWatermark` (paid opt-out) renders
 * nothing; a missing PNG falls back to the text "Made on Tesana". QA rigs
 * (sdk qa_rig.py / qa_mcp.py, incl. the poster capture) set
 * `window.__TESANA_QA_RIG__ = true` from an init script and get no badge at all,
 * matching Godot whose engine-native captures never include it.
 */
(function () {
  "use strict";
  var VERSION = "2.0.0";
  var RING_CAPACITY = 200, READY_TIMEOUT_MS = 12000, ACTIVITY_WINDOW_MS = 30000;
  var meta = {};
  try { meta = JSON.parse(document.getElementById("game-meta").textContent) || {}; } catch (e) { /* defaults */ }
  var title = meta.title || document.title || "Untitled Game";
  // Read once, here: the shell is the first script in <head>, so only a Playwright
  // init script (the QA rig) can have set this — never the game's own code.
  var qaRig = window["__TESANA_QA_RIG__"] === true;

  // ---------------------------------------------------------------- console ring
  var ring = [];
  function push(level, message) {
    ring.push({ level: level, message: message, timestamp: Date.now() });
    while (ring.length > RING_CAPACITY) ring.shift();
  }
  function fmt(arg) {
    if (arg instanceof Error) return arg.stack || arg.name + ": " + arg.message;
    if (typeof arg !== "object" || arg === null) return String(arg);
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      push(level, args.map(fmt).join(" "));
      if (typeof original === "function") original.apply(console, args);
    };
  });

  // ---------------------------------------------------------------- bridge out
  function post(message) {
    try { (window.parent || window).postMessage(message, "*"); } catch (e) { /* unserialisable payload */ }
  }
  function reportError(error, fallback) {
    var err = error instanceof Error ? error : new Error(String(error == null ? fallback : error));
    post({ type: "game-error", message: err.message, stack: err.stack || null });
  }
  window.addEventListener("error", function (event) {
    push("error", "Uncaught: " + (event.message || fmt(event.error)) + (event.filename ? " at " + event.filename + ":" + event.lineno : ""));
    reportError(event.error, event.message || "Unknown error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    push("error", "Unhandled Promise: " + fmt(event.reason));
    reportError(event.reason, "Unhandled rejection");
  });
  window["__TESANA_BRIDGE__"] = { installed: true, version: VERSION };

  // ---------------------------------------------------------------- input tracking
  var lastInputAt = null, inputPosted = false;
  function noteInput() {
    lastInputAt = Date.now();
    if (!inputPosted) { inputPosted = true; post({ type: "game-input" }); }
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.addEventListener(ev, noteInput, { capture: true, passive: true }); });

  // ---------------------------------------------------------------- mute / volume
  // Every AudioContext created after this point routes through a master GainNode:
  // `ctx.destination` returns the gain and the gain feeds the real destination.
  var masters = [], muted = false, volume = 1;
  function applyAudio() {
    masters.forEach(function (gain) { gain.gain.value = muted ? 0 : volume; });
    var media = document.querySelectorAll("audio, video");
    for (var i = 0; i < media.length; i++) media[i].muted = muted;
  }
  function patchAudioContext(name) {
    var Native = window[name];
    if (typeof Native !== "function") return;
    var Patched = function TesanaAudioContext(options) {
      var ctx = options === undefined ? new Native() : new Native(options);
      var gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.value = muted ? 0 : volume;
      Object.defineProperty(ctx, "destination", { get: function () { return gain; }, configurable: true });
      Object.defineProperty(ctx, "__tesanaMaster", { value: gain });
      masters.push(gain);
      return ctx;
    };
    Patched.prototype = Native.prototype;
    window[name] = Patched;
  }
  patchAudioContext("AudioContext");
  patchAudioContext("webkitAudioContext");

  // ---------------------------------------------------------------- mobile hygiene
  // A mobile game (meta.isMobile = the creation-time device profile from
  // .tesana_meta.json) gets the browser behaviours a touch game must have
  // switched off, so the game's OWN touch controls work first time: no pinch or
  // double-tap zoom, no rubber-band scroll from a touch on the canvas, no
  // long-press callout / context menu / text selection over the game, no tap
  // highlight. The shell mounts NO controls and exposes NO input API — the game
  // writes its controls (preambles.MOBILE_BLOCK describes exactly this; keep the
  // two in agreement). The style goes at the TOP of <head> so the game's own
  // CSS wins any tie; build-game.mjs writes the matching viewport meta
  // (viewport-fit=cover, no user scaling) at build time.
  var MOBILE_CSS =
    "html,body{touch-action:manipulation;overscroll-behavior:none;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}" +
    "canvas{touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}";
  function isCanvas(node) { return !!node && String(node.tagName || "").toUpperCase() === "CANVAS"; }
  function blockEvent(event) { if (event.cancelable !== false) event.preventDefault(); }
  function mountMobileHygiene() {
    var style = document.createElement("style");
    style.setAttribute("data-tesana", "mobile");
    style.textContent = MOBILE_CSS;
    document.head.insertBefore(style, document.head.firstChild);
    // Pinch zoom on iOS Safari / WKWebView (non-standard gesture events; the viewport meta covers Chromium).
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (ev) { document.addEventListener(ev, blockEvent, { passive: false }); });
    // Long-press over the game surface; the game's DOM UI keeps its own menus.
    document.addEventListener("contextmenu", function (event) { if (isCanvas(event.target)) blockEvent(event); });
    // Scroll / rubber-band from a touch that starts on the canvas, for engines that ignore
    // touch-action (older WebKit). The canvas is the game, never a scroller.
    document.addEventListener("touchmove", function (event) { if (isCanvas(event.target)) blockEvent(event); }, { passive: false });
  }
  if (meta.isMobile) mountMobileHygiene();

  // ---------------------------------------------------------------- frames & screenshots
  var frameCount = 0, fps = 0, lastFrameAt = 0;
  var afterFrame = []; // run right after the game's rAF callback, in the same frame (drawing buffer still valid)
  function largestCanvas() {
    var best = null, area = 0, list = document.getElementsByTagName("canvas");
    for (var i = 0; i < list.length; i++) {
      var rect = list[i].getBoundingClientRect(), a = rect.width * rect.height;
      if (a > area && list[i].width > 0 && list[i].height > 0) { area = a; best = list[i]; }
    }
    return best;
  }
  function onFrame(now) {
    frameCount++;
    if (lastFrameAt) { var inst = 1000 / Math.max(1, now - lastFrameAt); fps = fps ? fps * 0.9 + inst * 0.1 : inst; }
    lastFrameAt = now;
    afterFrame.splice(0).forEach(function (cb) { try { cb(); } catch (e) { /* never break the game loop */ } });
  }
  var nativeRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (callback) {
    return nativeRAF(function (now) { try { callback(now); } finally { onFrame(now); } });
  };
  function captureDataUrl() {
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        var canvas = largestCanvas();
        if (!canvas) return reject(new Error("No canvas to capture"));
        try { resolve(canvas.toDataURL("image/png")); } catch (e) { reject(e); }
      };
      afterFrame.push(finish);
      setTimeout(finish, 500); // game not animating → read the canvas directly
    });
  }

  // ---------------------------------------------------------------- bridge in
  var recording = false;
  function record(durationMs) {
    return new Promise(function (resolve, reject) {
      var canvas = largestCanvas();
      if (recording) return reject(new Error("Recording already in progress"));
      if (!canvas) return reject(new Error("No canvas to record"));
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") return reject(new Error("MediaRecorder is not supported"));
      var duration = Math.min(30000, Math.max(250, Number(durationMs) || 5000));
      var stream = canvas.captureStream(30);
      var mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
      var recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
      var chunks = [];
      recording = true;
      var stop = function () { recording = false; stream.getTracks().forEach(function (t) { t.stop(); }); };
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = function () { stop(); reject(new Error("MediaRecorder error")); };
      recorder.onstop = function () {
        stop();
        var reader = new FileReader();
        reader.onload = function () { resolve({ dataUrl: String(reader.result), mimeType: recorder.mimeType, durationMs: duration }); };
        reader.onerror = function () { reject(new Error("FileReader failed")); };
        reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start(250);
      setTimeout(function () { recorder.stop(); }, duration);
    });
  }
  function errorText(e) { return e instanceof Error ? e.message : String(e); }
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "set-muted":
        muted = Boolean(msg.muted);
        return applyAudio();
      case "set-volume": {
        var v = Number(msg.volume);
        volume = isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        return applyAudio();
      }
      case "capture-screenshot":
        return captureDataUrl().then(
          function (dataUrl) { post({ type: "screenshot-result", dataUrl: dataUrl }); },
          function (e) { post({ type: "screenshot-result", dataUrl: null, error: errorText(e) }); },
        );
      case "get-console-logs":
        return post({ type: "console-logs-result", logs: ring.slice() });
      case "start-recording":
        return record(msg.durationMs).then(
          function (r) { post({ type: "recording-result", dataUrl: r.dataUrl, mimeType: r.mimeType, durationMs: r.durationMs }); },
          function (e) { post({ type: "recording-result", dataUrl: null, error: errorText(e) }); },
        );
      case "activity-status":
        return post({ type: "activity-status-result", active: lastInputAt !== null && Date.now() - lastInputAt <= ACTIVITY_WINDOW_MS, lastInputAt: lastInputAt, phase: ready ? "running" : "loading" });
    }
  });

  // ---------------------------------------------------------------- overlay, watermark, readiness
  var CSS =
    ".tesana-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;color:#fff;background:#0b0d12 center/cover no-repeat;font:500 16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;transition:opacity 280ms ease}" +
    ".tesana-overlay[data-hide]{opacity:0;pointer-events:none}" +
    ".tesana-overlay__shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.7))}" +
    ".tesana-overlay__title{position:relative;margin:0;font-size:clamp(26px,5vw,42px);font-weight:700;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.7);max-width:80vw}" +
    ".tesana-overlay__logo{position:relative;max-width:min(70vw,360px);max-height:28vh;object-fit:contain}" +
    ".tesana-overlay__bar{position:relative;width:min(60vw,320px);height:6px;border-radius:999px;background:rgba(255,255,255,.18);overflow:hidden}" +
    ".tesana-overlay__bar::after{content:'';position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:999px;background:#7c5cff;animation:tesana-slide 1.1s ease-in-out infinite}" +
    "@keyframes tesana-slide{to{left:100%}}" +
    // Watermark geometry = Godot's presets/_shared.py (#tesana-watermark / -inner / img): full-viewport
    // fixed layer → 16:9 box fitted (contain) and centred via margin:auto → badge 11.5% of the box width,
    // bottom-right, margins 2.25% right / 1.5% bottom. Hidden until ready. One deliberate departure
    // (orchestrator 2026-09-08, mobile push): narrower than 16:9 (phones in portrait) the box is anchored
    // to the bottom edge instead of centred — Godot's rule puts the badge mid-screen there — and the badge
    // keeps a 96px minimum so it stays legible at 390px wide. Desktop 16:9 is unchanged (box == viewport).
    ".tesana-watermark{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;justify-content:flex-end;align-items:flex-end;z-index:2147483001;pointer-events:none;user-select:none}" +
    ".tesana-watermark[data-ready]{display:flex}" +
    ".tesana-watermark__inner{position:relative;width:100vw;height:56.25vw;max-width:100vw;max-height:100vh;aspect-ratio:16/9;margin:auto;display:flex;justify-content:flex-end;align-items:flex-end}" +
    ".tesana-watermark__img{width:11.5%;height:auto;display:block;margin-bottom:1.5%;margin-right:2.25%}" +
    "@media (max-aspect-ratio:16/9){.tesana-watermark__inner{width:100vw;height:auto;max-height:100vh;margin-bottom:0;padding-bottom:env(safe-area-inset-bottom,0px)}.tesana-watermark__img{min-width:96px}}" +
    "@media (min-aspect-ratio:16/9){.tesana-watermark__inner{height:100vh;width:auto;max-width:100vw}}" +
    // Text fallback (PNG missing at build): same anchor, the previous 11px badge.
    ".tesana-watermark__text{display:block;margin-bottom:1.5%;margin-right:2.25%;font:500 11px system-ui,sans-serif;color:rgba(255,255,255,.55);letter-spacing:.04em;text-shadow:0 1px 4px rgba(0,0,0,.6)}";
  var ready = false, overlay = null, watermark = null;
  function el(tag, className, parent) {
    var node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  }
  function mountDom() {
    document.head.appendChild(document.createElement("style")).textContent = CSS;
    overlay = el("div", "tesana-overlay", document.getElementById("game") || document.body);
    overlay.setAttribute("role", "status");
    if (meta.posterUrl) {
      overlay.style.backgroundImage = 'url("' + meta.posterUrl + '")';
      el("div", "tesana-overlay__shade", overlay);
    }
    if (meta.logoUrl) { var img = el("img", "tesana-overlay__logo", overlay); img.alt = title; img.src = meta.logoUrl; }
    else el("h1", "tesana-overlay__title", overlay).textContent = title;
    el("div", "tesana-overlay__bar", overlay);
    if (!meta.disableWatermark && !qaRig) mountWatermark();
  }
  function mountWatermark() {
    // On <body>, not #game: games that re-render #game must not lose the badge.
    watermark = el("div", "tesana-watermark", document.body);
    watermark.id = "tesana-watermark"; // same hook as Godot's overlay
    watermark.setAttribute("aria-hidden", "true");
    var inner = el("div", "tesana-watermark__inner", watermark);
    if (meta.watermarkUrl) {
      var img = el("img", "tesana-watermark__img", inner);
      img.alt = "Made on Tesana";
      img.draggable = false;
      img.src = meta.watermarkUrl;
    } else {
      el("span", "tesana-watermark__text", inner).textContent = "Made on Tesana";
    }
  }
  function markReady() {
    if (ready) return;
    ready = qa.ready = true;
    if (overlay) { overlay.setAttribute("data-hide", ""); setTimeout(function () { overlay.remove(); }, 320); }
    if (watermark) watermark.setAttribute("data-ready", ""); // Godot reveals it when its loading screen goes, too
    post({ type: "tesana-ready", version: VERSION, adapter: meta.gameType === "3d" ? "three" : "phaser" });
  }
  // A frame is "real" once a 16×9 downscale of the largest canvas is not flat (luminance variance).
  var probe = document.createElement("canvas");
  probe.width = 16; probe.height = 9;
  var probeCtx = probe.getContext("2d", { willReadFrequently: true });
  function frameHasContent() {
    var canvas = largestCanvas();
    if (!canvas || !probeCtx) return false;
    try {
      probeCtx.drawImage(canvas, 0, 0, 16, 9);
      var d = probeCtx.getImageData(0, 0, 16, 9).data, sum = 0, sq = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) { var lum = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += lum; sq += lum * lum; }
      var mean = sum / n;
      return sq / n - mean * mean > 4;
    } catch (e) { return false; }
  }
  function readinessProbe() {
    if (ready) return;
    if (frameCount % 3 === 0 && frameHasContent()) return markReady();
    afterFrame.push(readinessProbe);
  }
  function start() {
    mountDom();
    afterFrame.push(readinessProbe);
    setTimeout(markReady, READY_TIMEOUT_MS);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // ---------------------------------------------------------------- QA hooks
  var KEYS = { Space: [" ", 32], Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], ShiftLeft: ["Shift", 16], ShiftRight: ["Shift", 16], ControlLeft: ["Control", 17], ControlRight: ["Control", 17], AltLeft: ["Alt", 18], AltRight: ["Alt", 18] };
  function keyInfo(code) {
    var m;
    if (KEYS[code]) return { key: KEYS[code][0], keyCode: KEYS[code][1] };
    if ((m = /^Key([A-Z])$/.exec(code))) return { key: m[1].toLowerCase(), keyCode: m[1].charCodeAt(0) };
    if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return { key: m[1], keyCode: 48 + Number(m[1]) };
    return { key: code, keyCode: 0 };
  }
  function injectKey(code, down) {
    var info = keyInfo(String(code));
    var init = { code: String(code), key: info.key, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true };
    // One event dispatched on the focused element (or body) bubbles through document to window, so
    // Phaser's keyboard plugin (window listener) and plain document/element listeners each see it once.
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", init));
    if (down) noteInput();
  }
  function injectTap(x, y) {
    var target = document.elementFromPoint(x, y) || document.body;
    var init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    [["pointerdown", 1], ["mousedown", 1], ["pointerup", 0], ["mouseup", 0], ["click", 0]].forEach(function (pair) {
      init.buttons = pair[1];
      var Ctor = pair[0].indexOf("pointer") === 0 && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(pair[0], init));
    });
    noteInput();
  }
  var qa = {
    ready: false,
    version: VERSION,
    screenshot: captureDataUrl,
    stats: function () { return { fps: Math.round(fps * 10) / 10, canvases: document.getElementsByTagName("canvas").length }; },
    inject: function (actions) {
      return (Array.isArray(actions) ? actions : []).reduce(function (chain, action) {
        return chain.then(function () {
          if (!action) return;
          if (action.type === "key") injectKey(action.code, Boolean(action.down));
          else if (action.type === "tap") injectTap(Number(action.x) || 0, Number(action.y) || 0);
          else if (action.type === "wait") return new Promise(function (r) { setTimeout(r, Math.max(0, Number(action.ms) || 0)); });
        });
      }, Promise.resolve());
    },
  };
  window["__TESANA_QA__"] = qa;
})();
