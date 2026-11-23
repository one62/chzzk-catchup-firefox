"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const mediaSource = fs.readFileSync(require.resolve("../src/media.js"), "utf8");
const source = fs.readFileSync(require.resolve("../src/clip-audio-live.js"), "utf8");

function live({ muted = false, settings = {}, pathname = "/", failEffect = false } = {}) {
  const video = { muted, readyState: 4, isConnected: true,
    getBoundingClientRect: () => ({ width: 640, height: 360 }) };
  const listeners = {};
  const timers = new Set();
  let connect;
  let storageChanged;
  let preventMute;
  const effect = { created: 0, disposed: 0, options: null };
  const location = { origin: "https://chzzk.naver.com", pathname };
  const window = { addEventListener(name, listener) { listeners[name] = listener; } };
  const context = vm.createContext({
    location, window,
    browser: {
      runtime: { onConnect: { addListener(fn) { connect = fn; } } },
      storage: {
        onChanged: { addListener(fn) { storageChanged = fn; } },
        local: { get: async () => settings },
      },
    },
    document: { querySelectorAll: () => [video], addEventListener(name, fn) { listeners[name] = fn; } },
    getComputedStyle: () => ({ visibility: "visible", opacity: "1" }),
    setInterval(fn) { timers.add(fn); return fn; }, clearInterval(id) { timers.delete(id); },
    console: { warn() {} },
    ClipAudioOpen: { install(allowed, findVideo, onPreventedMute) {
      preventMute = () => {
        if (!allowed()) return false;
        onPreventedMute(findVideo());
        return true;
      };
    } },
    ClipAudioEffects: { create(_video, options) {
      if (failEffect) throw new Error("unsupported source");
      effect.created++;
      effect.options = options;
      return { dispose() { effect.disposed++; } };
    } },
  });
  vm.runInContext(mediaSource, context);
  vm.runInContext(source, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function setSettings(values) {
    settings = { ...settings, ...values };
    storageChanged(Object.fromEntries(Object.keys(values).map(key => [key, {}])), "local");
    await flush();
  }
  function simulateClipClick({ intercept = false } = {}) {
    location.pathname = "/live/test";
    listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
    if (!intercept || !preventMute?.()) video.muted = true;
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
  return { video, listeners, timers, effect, location, flush, setSettings, simulateClipClick, openPort, popup };
}

test("the parent option restores audio with no effect, including after live SPA navigation", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 0);
  editor.close();
  assert.equal(app.video.muted, false);
  assert.equal(app.timers.size, 0);
});

test("a prevented startup mute can be reapplied when disabling the option mid-edit", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true } });
  await app.flush();
  app.simulateClipClick({ intercept: true });
  assert.equal(app.video.muted, false);
  const editor = app.openPort();
  await app.setSettings({ clipKeepLiveAudio: false });
  assert.equal(app.video.muted, true);
  editor.close();
  assert.equal(app.video.muted, false);
});

test("the effect is gated by the parent and active only while an editor is open", async () => {
  const app = live({ settings: { clipLiveAudioEffect: true } });
  await app.flush();
  assert.equal(app.effect.created, 0);
  app.simulateClipClick();
  const editor = app.openPort();
  assert.equal(app.video.muted, true);
  assert.equal(app.effect.created, 0);
  await app.setSettings({ clipKeepLiveAudio: true });
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 1);
  await app.setSettings({ clipEnabled: false });
  assert.equal(app.video.muted, true);
  assert.equal(app.effect.disposed, 1);
  await app.setSettings({ clipEnabled: true });
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 2);
  editor.close();
  assert.equal(app.effect.disposed, 2);
  assert.equal(app.video.muted, false);
});

test("an effect failure leaves the mute prevention active", async () => {
  const app = live({ failEffect: true, settings: { clipKeepLiveAudio: true, clipLiveAudioEffect: true } });
  await app.flush();
  app.simulateClipClick();
  app.openPort();
  assert.equal(app.video.muted, false);
});

test("the editor can use panning alone and change effects while open", async () => {
  const app = live({ settings: { clipKeepLiveAudio: true, clipLiveAudioPan: true } });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  assert.equal(app.effect.options.usePan, true);
  assert.equal(app.effect.options.useEffect, false);
  await app.setSettings({ clipLiveAudioEffect: true });
  assert.equal(app.effect.options.usePan, true);
  assert.equal(app.effect.options.useEffect, true);
  await app.setSettings({ clipLiveAudioPan: false });
  assert.equal(app.effect.options.usePan, false);
  assert.equal(app.effect.options.useEffect, true);
  editor.close();
  assert.equal(app.effect.disposed, 3);
});

test("manual mute and an existing mute are respected", async () => {
  const settings = { clipKeepLiveAudio: true };
  const app = live({ settings });
  await app.flush();
  app.simulateClipClick();
  const editor = app.openPort();
  app.listeners.pointerdown({ isTrusted: true, type: "pointerdown" });
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
  const app = live({ settings: { clipKeepLiveAudio: true, clipLiveAudioEffect: true } });
  await app.flush();
  app.simulateClipClick();
  const { editor, notify } = app.popup();
  notify(true, { isTrusted: false });
  notify(true, { source: { ...editor, opener: null } });
  assert.equal(app.video.muted, true);
  notify(true);
  notify(true);
  assert.equal(app.video.muted, false);
  assert.equal(app.effect.created, 1);
  const tab = app.openPort();
  editor.closed = true;
  for (const refresh of app.timers) refresh();
  assert.equal(app.effect.disposed, 0);
  tab.close();
  assert.equal(app.effect.disposed, 1);
  assert.equal(app.timers.size, 0);
});
