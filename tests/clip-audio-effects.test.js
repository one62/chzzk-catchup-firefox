"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const script = fs.readFileSync(require.resolve("../src/clip-audio-effects.js"), "utf8");

function setup(initialState = "running") {
  const filters = [];
  const sources = [];
  const pannings = [];
  const warnings = [];
  let ctx;
  function node(properties = {}) {
    return { ...properties, connect(target) { this.output = target; return target; },
      disconnect() { this.output = null; } };
  }
  const destination = node();
  class Context extends EventTarget {
    state = initialState;
    destination = destination;
    resumeCalls = 0;
    constructor() { super(); ctx = this; }
    resume() { this.resumeCalls++; return Promise.resolve(); }
    createMediaElementSource() {
      const source = node();
      sources.push(source);
      return source;
    }
    createBiquadFilter() {
      const filter = node({ frequency: {}, Q: {} });
      filters.push(filter);
      return filter;
    }
    createGain() { return node({ gain: {} }); }
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
    location: new URL("https://chzzk.naver.com/live/test"),
    console: { warn(...args) { warnings.push(args); } } };
  vm.runInNewContext(script, env);
  function changeState(state) {
    ctx.state = state;
    ctx.dispatchEvent(new Event("statechange"));
  }
  return { create: env.ClipAudioEffects.create, filters, sources, pannings, destination, document, window,
    warnings, changeState, resumeCalls: () => ctx.resumeCalls };
}

test("the bundled effect applies two low-pass filters, one high-pass filter and 80% gain", () => {
  const { create, filters, sources, pannings, destination } = setup();
  const video = {};
  const effect = create(video, { useEffect: true });
  assert.deepEqual(filters.map(filter => [filter.type, filter.frequency.value]), [
    ["lowpass", 2750], ["highpass", 460], ["lowpass", 2500],
  ]);
  assert.equal(sources[0].output, filters[0]);
  assert.equal(filters[0].output, filters[1]);
  assert.equal(filters[1].output, filters[2]);
  const gain = filters[2].output;
  assert.equal(gain.gain.value, 0.8);
  assert.equal(gain.output, destination);
  effect.dispose();
  assert.equal(sources[0].output, destination);
  assert.equal(gain.output, null);
  const panOnly = create(video, { usePan: true });
  assert.equal(sources.length, 1);
  assert.equal(filters.length, 3);
  assert.equal(sources[0].output, pannings[0]);
  assert.equal(pannings[0].pan.value, 0.55);
  assert.equal(pannings[0].output, destination);
  panOnly.dispose();
  const reopened = create(video, { useEffect: true, usePan: true });
  assert.equal(sources[0].output, filters[3]);
  assert.equal(filters[5].output.output, pannings[1]);
  reopened.dispose();
  assert.equal(sources[0].output, destination);
});

test("shared recovery remains active after an attached source is bypassed", () => {
  const app = setup();
  const video = {};
  app.create(video, { usePan: true }).dispose();
  app.create(video, { useEffect: true }).dispose();
  assert.equal(app.sources[0].output, app.destination);
  assert.equal(app.resumeCalls(), 0);

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
});

test("a disposed effect stops requesting recovery if it never attached a source", () => {
  const app = setup("suspended");
  const effect = app.create({}, { usePan: true });
  app.document.dispatchEvent(new Event("keydown"));
  assert.equal(app.resumeCalls(), 2);
  effect.dispose();
  app.document.dispatchEvent(new Event("keydown"));
  app.window.dispatchEvent(new Event("pageshow"));
  assert.equal(app.resumeCalls(), 2);
  app.changeState("running");
  assert.equal(app.sources.length, 0);
});

test("deferred activation checks the current media origin before attaching a source", () => {
  const app = setup("suspended");
  const video = { currentSrc: "blob:https://chzzk.naver.com/stream" };
  const effect = app.create(video, { usePan: true });
  assert.equal(app.sources.length, 0);

  video.currentSrc = "https://media.example/live.mp4";
  app.changeState("running");
  assert.equal(app.sources.length, 0);
  assert.match(app.warnings[0][1].message, /Web Audio/);
  effect.dispose();
});
