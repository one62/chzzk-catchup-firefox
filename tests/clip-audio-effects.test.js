"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const script = fs.readFileSync(require.resolve("../src/clip-audio-effects.js"), "utf8");

function makeVideo(overrides = {}) {
  return {
    isConnected: true,
    paused: false,
    readyState: 4,
    currentSrc: "blob:https://chzzk.naver.com/clip",
    ...overrides,
  };
}

function setup(initialState = "running") {
  const sources = [];
  const pannings = [];
  const warnings = [];
  const contextOptions = [];
  const contexts = [];
  let ctx;
  function node(properties = {}) {
    return {
      ...properties,
      output: null,
      connect(target) { this.output = target; return target; },
      disconnect() { this.output = null; },
    };
  }
  const destination = node();
  class Context extends EventTarget {
    state = initialState;
    destination = destination;
    resumeCalls = 0;
    closeCalls = 0;
    constructor(options) {
      super();
      contextOptions.push(options);
      ctx = this;
      contexts.push(this);
    }
    resume() { this.resumeCalls++; return Promise.resolve(); }
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
    createMediaElementSource() {
      const source = node();
      sources.push(source);
      return source;
    }
    createStereoPanner() {
      const pan = node({ pan: {} });
      pannings.push(pan);
      return pan;
    }
  }
  const document = new EventTarget();
  document.visibilityState = "visible";
  const window = new EventTarget();
  const env = { AudioContext: Context, document, window, URL,
    location: new URL("https://chzzk.naver.com/clip-editor"),
    console: { warn(...args) { warnings.push(args); } } };
  vm.runInNewContext(script, env);
  function changeState(state) {
    ctx.state = state;
    ctx.dispatchEvent(new Event("statechange"));
  }
  return {
    create: env.ClipAudioEffects.create,
    isSupportedSource: env.ClipAudioEffects.isSupportedSource,
    sources, pannings, destination, document, window,
    warnings, contextOptions, contexts, changeState,
    resumeCalls: () => ctx.resumeCalls,
    closeCalls: () => ctx.closeCalls,
  };
}

test("editor panning uses playback latency hint, pans right, bypasses on dispose and reuses the source", () => {
  const { create, sources, pannings, destination, contextOptions } = setup();
  const video = makeVideo();
  const effect = create(video);
  assert.equal(contextOptions.length, 1);
  assert.equal(contextOptions[0]?.latencyHint, "playback");
  assert.equal(sources.length, 1);
  assert.equal(pannings.length, 1);
  assert.equal(pannings[0].pan.value, 0.55);
  assert.equal(sources[0].output, pannings[0]);
  assert.equal(pannings[0].output, destination);
  effect.dispose();
  assert.equal(sources[0].output, destination);
  assert.equal(pannings[0].output, null);
  const reopened = create(video);
  assert.equal(sources.length, 1);
  assert.equal(pannings.length, 2);
  assert.equal(sources[0].output, pannings[1]);
  assert.equal(pannings[1].output, destination);
  reopened.dispose();
  assert.equal(sources[0].output, destination);
});

test("only same-origin sources (including MSE blob:) and srcObject streams are supported", () => {
  const app = setup();
  assert.equal(app.isSupportedSource(makeVideo({ currentSrc: "blob:https://chzzk.naver.com/123" })), true);
  assert.equal(app.isSupportedSource(makeVideo({ currentSrc: "https://chzzk.naver.com/clip.mp4" })), true);
  assert.equal(app.isSupportedSource(makeVideo({ currentSrc: "", srcObject: {} })), true);
  assert.equal(app.isSupportedSource(makeVideo({ currentSrc: "" })), false);
  assert.equal(app.isSupportedSource(makeVideo({ currentSrc: "https://cdn.example/clip.mp4" })), false);
  assert.equal(app.isSupportedSource(makeVideo({
    currentSrc: "https://cdn.example/clip.mp4", crossOrigin: "anonymous",
  })), false);
  assert.throws(() => app.create(makeVideo({
    currentSrc: "https://cdn.example/clip.mp4", crossOrigin: "anonymous",
  })), /Web Audio/);
});

test("shared recovery remains active after bypass and closes on non-persisted pagehide", () => {
  const app = setup();
  const video = makeVideo();
  app.create(video).dispose();
  app.create(video).dispose();
  assert.equal(app.sources[0].output, app.destination);
  assert.equal(app.resumeCalls(), 0);
  assert.equal(app.closeCalls(), 0);

  app.document.visibilityState = "hidden";
  app.changeState("suspended");
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.resumeCalls(), 0);

  app.document.visibilityState = "visible";
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.resumeCalls(), 1);
  app.window.dispatchEvent(new Event("pageshow"));
  assert.equal(app.resumeCalls(), 2);
  app.document.dispatchEvent(new Event("pointerdown"));
  assert.equal(app.resumeCalls(), 3);
  app.document.dispatchEvent(new Event("keydown"));
  assert.equal(app.resumeCalls(), 4);
  app.changeState("running");
  app.changeState("suspended");
  assert.equal(app.resumeCalls(), 5);

  const hide = new Event("pagehide");
  hide.persisted = false;
  app.window.dispatchEvent(hide);
  assert.equal(app.closeCalls(), 1);
});

test("a disposed effect closes an unattached context and stops requesting recovery", () => {
  const app = setup("suspended");
  const effect = app.create(makeVideo());
  app.document.dispatchEvent(new Event("keydown"));
  assert.equal(app.resumeCalls(), 2);
  effect.dispose();
  assert.equal(app.closeCalls(), 1);
  app.document.dispatchEvent(new Event("keydown"));
  app.window.dispatchEvent(new Event("pageshow"));
  assert.equal(app.resumeCalls(), 2);
  app.changeState("running");
  assert.equal(app.sources.length, 0);
});

test("deferred activation re-checks origin even for a cached source node", () => {
  const app = setup("running");
  const video = makeVideo({ currentSrc: "blob:https://chzzk.naver.com/stream" });
  app.create(video).dispose();
  assert.equal(app.sources.length, 1);
  assert.equal(app.sources[0].output, app.destination);

  app.contexts[0].state = "suspended";
  const errors = [];
  app.create(video, { onError: error => errors.push(error) });
  video.currentSrc = "https://media.example/clip.mp4";
  app.changeState("running");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Web Audio/);
  assert.equal(app.sources[0].output, app.destination);
});

test("deferred activation cancels cleanly if playback state or canAttach fails before running", () => {
  for (const scenario of [
    { mutate: video => { video.paused = true; }, canAttach: () => true },
    { mutate: video => { video.readyState = 0; }, canAttach: () => true },
    { mutate: video => { video.isConnected = false; }, canAttach: () => true },
    { mutate: () => {}, canAttach: () => false },
  ]) {
    let allowed = true;
    const app = setup("suspended");
    const video = makeVideo();
    let cancelled = 0;
    let errored = 0;
    app.create(video, {
      canAttach: () => allowed,
      onCancel: () => { cancelled++; },
      onError: () => { errored++; },
    });
    scenario.mutate(video);
    allowed = scenario.canAttach();
    app.changeState("running");
    assert.equal(app.sources.length, 0);
    assert.equal(cancelled, 1);
    assert.equal(errored, 0);
    assert.equal(app.closeCalls(), 1);
  }
});
