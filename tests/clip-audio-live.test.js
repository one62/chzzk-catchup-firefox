"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const mediaSource = fs.readFileSync(require.resolve("../src/media.js"), "utf8");
const effectsSource = fs.readFileSync(require.resolve("../src/clip-audio-effects.js"), "utf8");
const source = fs.readFileSync(require.resolve("../src/clip-audio-live.js"), "utf8");

function live({ muted = false, settings = {}, pathname = "/", failEffect = false, opener = null,
  readSettings = null } = {}) {
  let layoutReads = 0;
  let styleReads = 0;
  const makeVideo = (overrides = {}) => ({
    muted, paused: false, readyState: 4, isConnected: true, currentSrc: "blob:https://chzzk.naver.com/clip",
    getBoundingClientRect() { layoutReads++; return { width: 640, height: 360 }; },
    ...overrides,
  });
  let videos = [makeVideo()];
  const listeners = {};
  const docListeners = {};
  const timers = new Set();
  const ports = [];
  let connect;
  let storageChanged;
  let notifyOpen;
  let preventMute;
  let now = 1000;
  const effect = { created: 0, disposed: 0, videos: [] };
  const location = { origin: "https://chzzk.naver.com", pathname,
    get href() { return `${this.origin}${this.pathname}`; } };
  const window = { opener, addEventListener(name, listener) { listeners[name] = listener; } };
  const context = vm.createContext({
    location, window, URL, Date: { now: () => now },
    browser: {
      runtime: {
        connect(info) {
          let onDisconnect;
          const port = { ...info, onDisconnect: { addListener(fn) { onDisconnect = fn; } },
            disconnect() { this.disconnected = true; }, triggerDisconnect() { onDisconnect?.(); } };
          ports.push(port);
          return port;
        },
        onConnect: { addListener(fn) { connect = fn; } },
      },
      storage: {
        onChanged: { addListener(fn) { storageChanged = fn; } },
        local: { get: defaults => {
          const snapshot = { ...defaults, ...settings };
          return readSettings ? readSettings(snapshot) : Promise.resolve(snapshot);
        } },
      },
    },
    document: {
      querySelectorAll: () => videos,
      addEventListener(name, fn) { docListeners[name] = fn; listeners[name] = fn; },
    },
    getComputedStyle: () => { styleReads++; return { display: "block", visibility: "visible", opacity: "1" }; },
    setInterval(fn) { timers.add(fn); return fn; }, clearInterval(id) { timers.delete(id); },
    console: { warn() {} },
    ClipAudioOpen: { install(allowed, findVideo, onOpen, onPreventedMute) {
      notifyOpen = () => { if (allowed()) onOpen(findVideo()); };
      preventMute = () => {
        if (!allowed()) return false;
        onPreventedMute(findVideo());
        return true;
      };
    } },
    ClipAudioEffects: {
      isSupportedSource(video) {
        if (!video) return false;
        if (video.srcObject) return true;
        if (!video.currentSrc) return false;
        return new URL(video.currentSrc, location.href).origin === location.origin;
      },
      create(video) {
        if (failEffect) throw new Error("unsupported source");
        effect.created++;
        effect.videos.push(video);
        return { dispose() { effect.disposed++; } };
      },
    },
  });
  vm.runInContext(mediaSource, context);
  vm.runInContext(source, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function setSettings(values) {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
      changes[key] = { oldValue: settings[key], newValue };
      settings[key] = newValue;
    }
    storageChanged(changes, "local");
    await flush();
  }
  function simulateClipClick({ intercept = false, deferMute = false } = {}) {
    location.pathname = "/live/test";
    listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
    listeners.click({ isTrusted: true, type: "click" });
    notifyOpen?.();
    if (!deferMute && (!intercept || !preventMute?.())) videos[0].muted = true;
  }
  function openPort() {
    let onDisconnect;
    const port = { name: "clip-audio-live", onDisconnect: { addListener(fn) { onDisconnect = fn; } },
      disconnect() { this.disconnected = true; } };
    connect(port);
    return { close: onDisconnect, port };
  }
  function popup() {
    const editor = { opener: window, location: { origin: location.origin, pathname: "/clip-editor" } };
    function notify(open, overrides = {}) {
      listeners.message({
        source: editor, isTrusted: true, origin: location.origin,
        data: { type: "chzzk-clip-audio-editor", open }, ...overrides,
      });
    }
    return { editor, notify };
  }
  return {
    get video() { return videos[0]; },
    setVideos(next) { videos = next; },
    makeVideo, listeners, docListeners, timers, ports, effect, location, flush, setSettings,
    simulateClipClick, openPort, popup,
    setFailEffect(value) { failEffect = value; },
    reads: () => ({ layoutReads, styleReads }),
    resetReads() { layoutReads = 0; styleReads = 0; },
    advanceTime(ms) { now += ms; },
  };
}

test("the parent option restores live audio without attaching Web Audio on the live tab", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true, clipEditorAudioPan: true } });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 0);
  editor.close();
  assert.equal(app.video.muted, false);
  assert.equal(app.timers.size, 0);
});

test("input before the editor connects preserves a prevented mute for disabling the option mid-edit", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick({ intercept: true });
  assert.equal(app.video.muted, false);
  app.advanceTime(1500);
  app.listeners.keydown({ isTrusted: true, type: "keydown", key: "Enter" });
  app.listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
  const editor = app.openPort();
  await app.setSettings({ clipKeepLiveAudio: false });
  assert.equal(app.video.muted, true);
  editor.close();
  assert.equal(app.video.muted, false);
});

test("input before the editor connects preserves the state before an asynchronous mute", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick({ deferMute: true });
  app.video.muted = true;
  app.advanceTime(1500);
  app.listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
  app.listeners.keydown({ isTrusted: true, type: "keydown", key: "Enter" });
  const editor = app.popup();
  editor.notify(true);
  assert.equal(app.video.muted, false);
  editor.notify(false);
  assert.equal(app.video.muted, false);
});

test("a confirmed snapshot does not hold unrelated gestures after changing broadcasts", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick({ intercept: true });
  app.location.pathname = "/live/other";
  app.video.muted = true;
  app.listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
  const editor = app.openPort();
  assert.equal(app.video.muted, true);
  editor.close();
});

test("live mute prevention can be enabled mid-edit and follows the clip master switch", async () => {
  const app = live({ settings: { clipEditorAudioPan: true } });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  assert.equal(app.video.muted, true);
  assert.equal(app.effect.created, 0);
  await app.setSettings({ clipKeepLiveAudio: true });
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 0);
  await app.setSettings({ clipEnabled: false });
  assert.equal(app.video.muted, true);
  await app.setSettings({ clipEnabled: true });
  assert.equal(app.video.muted, false);
  editor.close();
  assert.equal(app.video.muted, false);
});

test("manual mute and an existing mute are respected, including keyboard shortcuts while editing", async () => {
  const settings = { clipKeepLiveAudio: true };
  const app = live({ settings });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  app.listeners.keydown({ isTrusted: true, type: "keydown", key: "m" });
  app.video.muted = true;
  app.listeners.volumechange({ target: app.video });
  editor.close();
  assert.equal(app.video.muted, true);

  const initiallyMuted = live({ muted: true, settings });
  await initiallyMuted.flush();
  initiallyMuted.simulateClipClick();
  const other = initiallyMuted.openPort();
  assert.equal(initiallyMuted.video.muted, true);
  other.close();
  assert.equal(initiallyMuted.video.muted, true);
});

test("a separate editor window is tracked only when its opener is the broadcast", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick();
  const { editor, notify } = app.popup();
  notify(true, { isTrusted: false });
  notify(true, { source: { ...editor, opener: null } });
  assert.equal(app.video.muted, true);
  notify(true);
  notify(true);
  assert.equal(app.video.muted, false);
  const tab = app.openPort();
  editor.closed = true;
  for (const refresh of app.timers) refresh();
  assert.equal(app.timers.size, 1);
  tab.close();
  assert.equal(app.timers.size, 0);
});

test("live rememberMute skips typing keys and preserves snapshots across player switches", async () => {
  const app = live({ pathname: "/live/test", settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.resetReads();

  app.listeners.keydown({ isTrusted: true, type: "keydown", key: "a" });
  app.listeners.keydown({ isTrusted: true, type: "keydown", key: "Enter", target: { tagName: "INPUT" } });
  app.listeners.keydown({ isTrusted: true, type: "keydown", key: " ", target: { isContentEditable: true } });
  assert.deepEqual(app.reads(), { layoutReads: 0, styleReads: 0 });

  const first = app.video;
  app.listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
  assert.deepEqual(app.reads(), { layoutReads: 1, styleReads: 1 });

  const main = app.makeVideo({
    muted: false,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  });
  app.setVideos([first, main]);
  app.listeners.click({ isTrusted: true, type: "click" });
  main.muted = true;

  const editor = app.openPort();
  assert.equal(main.muted, false);
  editor.close();
  assert.equal(main.muted, false);
});

test("clip editor applies right panning only when enabled with mute prevention, with or without opener", async () => {
  for (const opener of [null, {}]) {
    const app = live({ pathname: "/clip-editor", opener, settings: { clipEditorAudioPan: true } });
    await app.flush();
    assert.equal(app.ports.length, opener ? 0 : 1);
    assert.equal(app.effect.created, 0);

    await app.setSettings({ clipKeepLiveAudio: true });
    assert.equal(app.effect.created, 1);
    assert.equal(app.effect.videos[0], app.video);

    app.resetReads();
    app.docListeners.playing({ type: "playing", target: app.video });
    assert.equal(app.effect.created, 1);
    assert.deepEqual(app.reads(), { layoutReads: 0, styleReads: 0 });

    await app.setSettings({ clipEditorAudioPan: false });
    assert.equal(app.effect.disposed, 1);
    await app.setSettings({ clipEditorAudioPan: true });
    assert.equal(app.effect.created, 2);
    await app.setSettings({ clipEnabled: false });
    assert.equal(app.effect.disposed, 2);
    await app.setSettings({ clipEnabled: true });
    assert.equal(app.effect.created, 3);

    app.listeners.pagehide();
    assert.equal(app.effect.disposed, 3);
    if (!opener) assert.equal(app.ports[0].disconnected, true);

    app.listeners.pageshow();
    await app.flush();
    assert.equal(app.effect.created, 4);
    if (!opener) assert.equal(app.ports.length, 2);
  }
});

test("clip editor waits for playback readiness, rejects external URLs, and follows replacement videos", async () => {
  const app = live({ pathname: "/clip-editor", opener: {},
    settings: { clipKeepLiveAudio: true, clipEditorAudioPan: true } });
  app.video.paused = true;
  app.video.readyState = 1;
  await app.flush();
  assert.equal(app.effect.created, 0);

  app.video.currentSrc = "https://cdn.example/external.mp4";
  app.video.crossOrigin = "anonymous";
  app.docListeners.loadedmetadata({ type: "loadedmetadata", target: app.video });
  app.video.paused = false;
  app.docListeners.play({ type: "play", target: app.video });
  assert.equal(app.effect.created, 0);

  app.video.currentSrc = "blob:https://chzzk.naver.com/clip-1";
  app.docListeners.loadedmetadata({ type: "loadedmetadata", target: app.video });
  assert.equal(app.effect.created, 1);

  const replacement = app.makeVideo({ currentSrc: "blob:https://chzzk.naver.com/clip-2" });
  app.video.isConnected = false;
  app.setVideos([replacement]);
  app.docListeners.play({ type: "play", target: replacement });
  assert.equal(app.effect.disposed, 1);
  assert.equal(app.effect.created, 2);
  assert.equal(app.effect.videos[1], replacement);
});

test("settings read completing after pagehide does not recreate panning, and pageshow waits for fresh settings", async () => {
  let resolveRead;
  let reads = 0;
  const app = live({
    pathname: "/clip-editor", opener: {},
    settings: { clipKeepLiveAudio: true, clipEditorAudioPan: true },
    readSettings: snapshot => {
      reads++;
      if (reads === 1 || reads === 3) {
        return new Promise(resolve => { resolveRead = next => resolve({ ...snapshot, ...next }); });
      }
      return Promise.resolve(snapshot);
    },
  });
  app.listeners.pagehide();
  resolveRead();
  await app.flush();
  assert.equal(app.effect.created, 0);

  app.listeners.pageshow();
  await app.flush();
  assert.equal(app.effect.created, 1);

  app.listeners.pagehide();
  assert.equal(app.effect.disposed, 1);
  app.listeners.pageshow();
  app.docListeners.playing({ type: "playing", target: app.video });
  assert.equal(app.effect.created, 1);

  resolveRead({ clipEditorAudioPan: false });
  await app.flush();
  assert.equal(app.effect.created, 1);
});

test("disabling panning via storage.onChanged cancels a pending suspended attach before async get resolves", async () => {
  const sources = [];
  let ctx;
  let storageChanged;
  let readCount = 0;
  let resolveSecondRead;
  function node(properties = {}) {
    return { ...properties, connect(target) { this.output = target; return target; },
      disconnect() { this.output = null; } };
  }
  const destination = node();
  class SuspendedContext extends EventTarget {
    state = "suspended";
    destination = destination;
    closeCalls = 0;
    constructor() { super(); ctx = this; }
    resume() { return Promise.resolve(); }
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
    createMediaElementSource() { const s = node(); sources.push(s); return s; }
    createStereoPanner() { return node({ pan: {} }); }
  }
  const video = {
    muted: false, paused: false, readyState: 4, isConnected: true,
    currentSrc: "blob:https://chzzk.naver.com/clip-1",
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  doc.querySelectorAll = () => [video];
  const win = new EventTarget();
  win.opener = {};
  const location = new URL("https://chzzk.naver.com/clip-editor");
  const context = vm.createContext({
    location, window: win, document: doc, URL, AudioContext: SuspendedContext,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setInterval() { return 1; }, clearInterval() {},
    console: { warn() {} },
    ClipAudioOpen: { install() {} },
    browser: {
      runtime: { connect() {}, onConnect: { addListener() {} } },
      storage: {
        local: {
          get: defaults => ++readCount === 1
            ? Promise.resolve({ ...defaults, clipKeepLiveAudio: true, clipEditorAudioPan: true })
            : new Promise(resolve => {
                resolveSecondRead = () => resolve({ ...defaults, clipKeepLiveAudio: true, clipEditorAudioPan: false });
              }),
        },
        onChanged: { addListener(fn) { storageChanged = fn; } },
      },
    },
  });
  vm.runInContext(mediaSource, context);
  vm.runInContext(effectsSource, context);
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  assert.equal(sources.length, 0);

  storageChanged({ clipEditorAudioPan: { oldValue: true, newValue: false } }, "local");
  assert.equal(ctx.closeCalls, 1);

  ctx.state = "running";
  ctx.dispatchEvent(new Event("statechange"));
  assert.equal(sources.length, 0);

  resolveSecondRead();
  await new Promise(setImmediate);
  assert.equal(sources.length, 0);
});

test("deferred AudioContext cancellation on pause and error on origin change both recover on next valid playback", async () => {
  const sources = [];
  let ctx;
  function node(properties = {}) {
    return { ...properties, connect(target) { this.output = target; return target; },
      disconnect() { this.output = null; } };
  }
  const destination = node();
  class SuspendedContext extends EventTarget {
    state = "suspended";
    destination = destination;
    closeCalls = 0;
    constructor() { super(); ctx = this; }
    resume() { return Promise.resolve(); }
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
    createMediaElementSource() { const s = node(); sources.push(s); return s; }
    createStereoPanner() { return node({ pan: {} }); }
  }
  const video = {
    muted: false, paused: false, readyState: 4, isConnected: true,
    currentSrc: "blob:https://chzzk.naver.com/clip-1",
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  doc.querySelectorAll = () => [video];
  const win = new EventTarget();
  win.opener = {};
  const location = new URL("https://chzzk.naver.com/clip-editor");
  const context = vm.createContext({
    location, window: win, document: doc, URL, AudioContext: SuspendedContext,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setInterval() { return 1; }, clearInterval() {},
    console: { warn() {} },
    ClipAudioOpen: { install() {} },
    browser: {
      runtime: { connect() {}, onConnect: { addListener() {} } },
      storage: {
        local: { get: async defaults => ({ ...defaults, clipKeepLiveAudio: true, clipEditorAudioPan: true }) },
        onChanged: { addListener() {} },
      },
    },
  });
  vm.runInContext(mediaSource, context);
  vm.runInContext(effectsSource, context);
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  assert.equal(sources.length, 0);

  const firstCtx = ctx;
  video.paused = true;
  ctx.state = "running";
  ctx.dispatchEvent(new Event("statechange"));
  assert.equal(sources.length, 0);
  assert.equal(firstCtx.closeCalls, 1);

  video.paused = false;
  const playEvent = new Event("play");
  Object.defineProperty(playEvent, "target", { value: video });
  doc.dispatchEvent(playEvent);
  assert.notEqual(ctx, firstCtx);
  assert.equal(sources.length, 0);

  const secondCtx = ctx;
  video.currentSrc = "https://cdn.example/no-cors.mp4";
  ctx.state = "running";
  ctx.dispatchEvent(new Event("statechange"));
  assert.equal(sources.length, 0);
  assert.equal(secondCtx.closeCalls, 1);

  video.currentSrc = "blob:https://chzzk.naver.com/clip-2";
  const loaded = new Event("loadedmetadata");
  Object.defineProperty(loaded, "target", { value: video });
  doc.dispatchEvent(loaded);
  assert.equal(sources.length, 0);

  ctx.state = "running";
  ctx.dispatchEvent(new Event("statechange"));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].output.pan.value, 0.55);
  assert.equal(sources[0].output.output, destination);
});
