"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../src/buffer-optimizer.js");

function stream(optimizer, options = {}) {
  let now = options.now ?? 0, time = options.time ?? 100, edge = time + (options.buffer ?? 6);
  let nextArrival = now + (options.period ?? 2000), rate = options.rate ?? 1;
  const period = options.period ?? 2000;
  function state(extra = {}) {
    return { currentTime: time, forwardBuffer: Math.max(0, edge - time), playbackRate: rate, readyState: 4, waiting: false, ...extra };
  }
  optimizer.observe(state(), now);
  function advance(milliseconds, settings = {}) {
    const end = now + milliseconds;
    while (now < end) {
      const step = Math.min(250, end - now);
      now += step;
      time += settings.frozen ? 0 : step / 1000 * rate;
      if (settings.arrivals !== false && now >= nextArrival) {
        edge += settings.amount ?? period / 1000;
        nextArrival += settings.period ?? period;
      }
      optimizer.observe(state(settings.extra), now);
    }
  }
  return { advance, state, get now() { return now; }, get time() { return time; },
    set rate(value) { rate = value; }, status: (...args) => optimizer.status(now, ...args) };
}

test("automatic startup waits for six real arrival intervals and ignores the manual margin", () => {
  const optimizer = create(), source = stream(optimizer);
  assert.deepEqual(optimizer.status(0), { margin: 0.6, phase: "learning", sampleCount: 0,
    periodSeconds: null, jitterSeconds: null, remainingSeconds: null, safe: false });
  source.advance(12000);
  assert.equal(source.status().sampleCount, 5);
  assert.equal(source.status().safe, false);
  source.advance(2000);
  const status = source.status(2.9);
  assert.equal(status.phase, "tracking");
  assert.equal(status.sampleCount, 6);
  assert.equal(status.periodSeconds, 2);
  assert.equal(status.remainingSeconds, 2);
  assert.equal(status.margin, 2.4);
  assert.equal(status.safe, true);
  assert.equal(source.status(0.2).margin, status.margin);
  assert.equal(source.status(0.2, false).margin, 0.2);
  assert.equal(source.status(0.2, false).phase, "manual");
});

test("phase within a refill cycle and requested playback rate both affect the reserve", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(14000);
  assert.equal(source.status(0.6, true, 1.2, true).margin, 2.4);
  assert.equal(source.status(0.6, true, 1.5, true).safe, true);
  assert.equal(source.status(0.6, true, 1.5, true).margin, 2.5);
  // A user-selected rate is retained after a seek and needs a full interval.
  assert.equal(source.status(0.6, true, 1.5).safe, false);
  source.advance(1500);
  assert.equal(source.status().remainingSeconds, 0.5);
  assert.equal(source.status().margin, 0.9);
  assert.equal(source.status(0.6, true, 1.5, true).margin, 1);
  assert.equal(source.status(0.6, true, 1.5).margin, 1.3);
  source.advance(250);
  assert.equal(source.status().margin, 0.6);
});

test("rate consumption does not create arrivals when the buffered endpoint is unchanged", () => {
  const optimizer = create(), source = stream(optimizer, { rate: 1.25 });
  source.advance(14000);
  assert.equal(source.status().sampleCount, 6);
  assert.equal(source.status().periodSeconds, 2);
  source.advance(500, { arrivals: false });
  assert.equal(source.status().sampleCount, 6);
  assert.equal(source.status().phase, "tracking");
});

test("jitter increases margin, delayed arrivals lose confidence, and regular refills recover", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(14000);
  source.advance(2250, { arrivals: false });
  source.advance(250); // A refill arrives half a second late.
  assert.equal(source.status().periodSeconds, 2);
  assert.equal(source.status().jitterSeconds, 0.5);
  assert.equal(source.status().margin, 2.8);
  source.advance(2000, { arrivals: false });
  source.advance(1250, { arrivals: false });
  assert.equal(source.status().phase, "unstable");
  assert.equal(source.status().safe, false);
  source.advance(250);
  assert.equal(source.status().phase, "unstable");
  source.advance(22000);
  assert.equal(source.status().phase, "tracking");
});

test("irregular or insufficient incoming media never establishes a trusted cadence", () => {
  const irregular = create(), source = stream(irregular, { buffer: 40 });
  source.advance(14000, { amount: 0.1 });
  assert.equal(source.status().phase, "unstable");
  assert.equal(source.status().safe, false);
  const slow = create(), slowSource = stream(slow, { period: 4000 });
  slowSource.advance(28000);
  assert.equal(slowSource.status().phase, "tracking");
  assert.equal(slowSource.status().margin, 3);
  assert.equal(slowSource.status().safe, false);
});

test("one confirmed stall raises reserve once and short cancelled waiting does not", () => {
  const optimizer = create(), source = stream(optimizer);
  optimizer.begin(0);
  source.advance(249);
  optimizer.cancel();
  assert.equal(source.status().margin, 0.6);
  optimizer.begin(source.now);
  source.advance(250);
  assert.equal(source.status().margin, 1.1);
  optimizer.begin(source.now);
  source.advance(1000);
  assert.equal(source.status().margin, 1.1);
  optimizer.cancel();
  optimizer.begin(source.now);
  source.advance(250);
  assert.equal(source.status().margin, 1.6);
});

test("waiting without a current range counts once and playing observes before cancellation", () => {
  const optimizer = create();
  optimizer.observe({ waiting: true }, 0);
  optimizer.observe({ waiting: true }, 250);
  optimizer.observe({ waiting: true }, 500);
  assert.equal(optimizer.status(500).margin, 1.1);
  optimizer.cancel();
  optimizer.begin(1000);
  optimizer.observe({ currentTime: 10, forwardBuffer: 3, playbackRate: 1, readyState: 4 }, 1250);
  optimizer.cancel();
  assert.equal(optimizer.status(1250).margin, 1.6);
});

test("confirmed reserve decays slowly only after a sustained stable learning period", () => {
  const optimizer = create(), source = stream(optimizer);
  optimizer.begin(0);
  source.advance(250);
  optimizer.cancel();
  source.advance(17750);
  const raised = source.status().margin;
  assert.equal(raised, 2.9);
  source.advance(20000);
  assert.equal(source.status().margin, raised);
  source.advance(20000);
  assert.ok(source.status().margin < raised);
  assert.ok(source.status().margin > 2.4);
  source.advance(100000);
  assert.equal(source.status().margin, 2.4);
});

test("suspend breaks arrival chains while retaining protection; reset clears everything", () => {
  const optimizer = create(), source = stream(optimizer);
  optimizer.begin(0); source.advance(250); optimizer.cancel();
  source.advance(13750);
  assert.equal(source.status().phase, "tracking");
  optimizer.suspend();
  assert.equal(source.status().sampleCount, 0);
  assert.equal(source.status().margin, 1.1);
  assert.equal(source.status().phase, "learning");
  source.advance(2000);
  assert.equal(source.status().sampleCount, 0);
  optimizer.reset();
  assert.equal(source.status().margin, 0.6);
  assert.equal(source.status().safe, false);
});

test("repeated status and duplicate observations are read-only", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(14000);
  const before = source.status();
  for (let index = 0; index < 20; index++) {
    optimizer.observe(source.state(), source.now);
    assert.deepEqual(source.status(), before);
    optimizer.status(source.now + 50000);
    assert.deepEqual(source.status(), before);
  }
});

test("changed buffered endpoints sharing a clock timestamp cannot reuse the old phase", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(15750);
  assert.equal(source.status().phase, "tracking");
  const state = source.state();
  optimizer.observe({ ...state, forwardBuffer: state.forwardBuffer + 2 }, source.now);
  assert.equal(source.status().safe, false);
  assert.equal(source.status().sampleCount, 0);
});

test("missing data, backwards clocks, long timer gaps and seeks require relearning", () => {
  for (const change of [
    (optimizer, source) => optimizer.observe({ ...source.state(), forwardBuffer: null }, source.now + 250),
    (optimizer, source) => optimizer.observe(source.state(), source.now - 250),
    (optimizer, source) => optimizer.observe({ ...source.state(), currentTime: source.time + 3 }, source.now + 3000),
    (optimizer, source) => optimizer.observe({ ...source.state(), currentTime: source.time + 10 }, source.now + 250),
    (optimizer, source) => optimizer.observe({ ...source.state(), forwardBuffer: 0 }, source.now + 250),
  ]) {
    const optimizer = create(), source = stream(optimizer);
    source.advance(14000);
    change(optimizer, source);
    assert.equal(optimizer.status(source.now + 250).safe, false);
    assert.equal(optimizer.status(source.now + 250).sampleCount, 0);
  }
});

test("stale predictions and frozen playheads cannot retain tracking confidence", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(14000);
  assert.equal(optimizer.status(source.now + 2000).phase, "unstable");
  source.advance(1250, { frozen: true, arrivals: false });
  assert.equal(source.status().phase, "unstable");
  assert.equal(source.status().sampleCount, 0);
  source.advance(750, { frozen: true });
  assert.equal(source.status().safe, false);
});

test("refilling an old endpoint after regression is excluded from arrival samples", () => {
  const optimizer = create(), source = stream(optimizer);
  source.advance(14000);
  const state = source.state(), edge = state.currentTime + state.forwardBuffer;
  for (let index = 1; index <= 8; index++) {
    const now = source.now + index * 250;
    const time = state.currentTime + index * 0.25;
    const nextEdge = edge - 2 + index * 0.2;
    optimizer.observe({ ...state, currentTime: time, forwardBuffer: nextEdge - time }, now);
  }
  assert.equal(optimizer.status(source.now + 2000).sampleCount, 0);
  assert.equal(optimizer.status(source.now + 2000).safe, false);
});
