"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const script = fs.readFileSync(require.resolve("../src/clip-audio-effects.js"), "utf8");

test("the bundled effect applies two low-pass filters, one high-pass filter and 80% gain", () => {
  const filters = [];
  const sources = [];
  const pannings = [];
  function node(properties = {}) {
    return { ...properties, connect(target) { this.output = target; return target; },
      disconnect() { this.output = null; } };
  }
  const destination = node();
  class Context extends EventTarget {
    state = "running";
    destination = destination;
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
  const env = { AudioContext: Context, document: new EventTarget() };
  vm.runInNewContext(script, env);
  const video = {};
  const effect = env.ClipAudioEffects.create(video, { useEffect: true });
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
  const panOnly = env.ClipAudioEffects.create(video, { usePan: true });
  assert.equal(sources.length, 1);
  assert.equal(filters.length, 3);
  assert.equal(sources[0].output, pannings[0]);
  assert.equal(pannings[0].pan.value, 0.55);
  assert.equal(pannings[0].output, destination);
  panOnly.dispose();
  const reopened = env.ClipAudioEffects.create(video, { useEffect: true, usePan: true });
  assert.equal(sources[0].output, filters[3]);
  assert.equal(filters[5].output.output, pannings[1]);
  reopened.dispose();
  assert.equal(sources[0].output, destination);
});
