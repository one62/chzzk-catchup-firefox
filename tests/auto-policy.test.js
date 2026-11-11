"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/auto-policy.js");
const media = require("../src/media.js");

function state(overrides = {}) {
  return {
    isLive: true,
    videoFound: true,
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    adState: "unknown",
    edgeDistance: 4,
    forwardBuffer: 4,
    playbackRate: 1,
    currentTime: 90,
    margin: 0.6,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    margin: 0.6,
    rate: 1.5,
    originalRate: 1,
    startedAt: 1_000,
    lastProgressAt: 2_000,
    lastProgressPosition: 90,
    ...overrides,
  };
}

function ranges(entries) {
  return {
    length: entries.length,
    start: index => entries[index][0],
    end: index => entries[index][1],
  };
}

test("browser global and CommonJS expose the same policy API", () => {
  assert.equal(globalThis.ChzzkCatchupAutoPolicy, policy);
  assert.ok(Object.isFrozen(policy));
});

test("default automatic settings enable 1.5x at a 3-second continuous buffer", () => {
  assert.deepEqual(policy.normalizeSettings(), { autoEnabled: true, autoStart: 3, autoRate: 1.5 });
  assert.deepEqual(policy.normalizeSettings(null), { autoEnabled: true, autoStart: 3, autoRate: 1.5 });
  assert.deepEqual(policy.normalizeSettings({ autoEnabled: false, autoStart: "4.25", autoRate: "1.2" }), {
    autoEnabled: false, autoStart: 4.3, autoRate: 1.2,
  });
});

test("settings reject invalid values and maintain start-to-target separation", () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, 1.9, 30.1, "", "invalid", true, null]) {
    assert.equal(policy.normalizeSettings({ autoStart: invalid }).autoStart, 3);
  }
  for (const invalid of [NaN, Infinity, 1, 1.3, 3, "", "invalid", true, null]) {
    assert.equal(policy.normalizeSettings({ autoRate: invalid }).autoRate, 1.5);
  }
  assert.equal(policy.normalizeSettings({ autoEnabled: "false" }).autoEnabled, true);
  assert.equal(policy.normalizeSettings({ autoStart: 2 }, 3).autoStart, 3.5);
  assert.equal(policy.normalizeSettings({}, 3).autoStart, 3.5);
  assert.equal(policy.normalizeSettings({ autoStart: 2 }, 0.2).autoStart, 2);
  assert.equal(policy.normalizeSettings({ autoStart: 30 }).autoStart, 30);
});

test("start threshold is inclusive while the lower target prevents rapid restart", () => {
  assert.deepEqual(policy.startDecision(state({ forwardBuffer: 2.99 }), {}, 3_000), {
    start: false, reason: "below-threshold",
  });
  assert.deepEqual(policy.startDecision(state({ forwardBuffer: 3 }), {}, 3_000), {
    start: true, reason: "ready",
  });
  assert.equal(policy.startDecision(state({ forwardBuffer: 0.6 }), {}, 3_000).start, false);
  assert.equal(policy.startDecision(state({ margin: 3, forwardBuffer: 3.49 }),
    { autoStart: 2 }, 3_000).start, false);
  assert.equal(policy.startDecision(state({ margin: 3, forwardBuffer: 3.5 }),
    { autoStart: 2 }, 3_000).start, true);
});

test("stopped, disconnected, non-live, ad, and unready playback cannot begin", () => {
  const cases = [
    [{ isLive: false }, "not-live"], [{ videoFound: false }, "no-video"],
    [{ paused: true }, "paused"], [{ seeking: true }, "seeking"],
    [{ ended: true }, "ended"], [{ readyState: 2 }, "not-ready"],
    [{ readyState: NaN }, "not-ready"], [{ adState: "detected" }, "ad"],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(policy.startDecision(state(overrides), {}, 3_000), { start: false, reason });
  }
  assert.equal(policy.startDecision(state({ readyState: 3, adState: "unknown" }), {}, 3_000).start, true);
  assert.deepEqual(policy.startDecision(state(), { autoEnabled: false }, 3_000), {
    start: false, reason: "disabled",
  });
});

test("custom user playback rates are preserved and cooldown is inclusive", () => {
  for (const playbackRate of [0.5, 1.1, 1.5, 2, NaN, null]) {
    assert.deepEqual(policy.startDecision(state({ playbackRate }), {}, 3_000), {
      start: false, reason: "custom-rate",
    });
  }
  assert.equal(policy.startDecision(state({ playbackRate: 1.0005 }), {}, 3_000).start, true);
  assert.deepEqual(policy.startDecision(state(), {}, 2_999, 3_000), { start: false, reason: "cooldown" });
  assert.equal(policy.startDecision(state(), {}, 3_000, 3_000).start, true);
});

test("nonfinite or absent media and clock measurements cannot start", () => {
  for (const key of ["forwardBuffer", "currentTime"]) {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, -1]) {
      assert.deepEqual(policy.startDecision(state({ [key]: value }), {}, 3_000), {
        start: false, reason: "invalid-timing",
      });
    }
  }
  assert.equal(policy.startDecision(state(), {}, NaN).start, false);
  assert.equal(policy.startDecision(state(), {}, 3_000, Infinity).start, false);
});

test("automatic speed-up requires enough continuous forward buffer", () => {
  assert.deepEqual(policy.startDecision(state({ edgeDistance: 15, forwardBuffer: 0.69 }), {}, 3_000), {
    start: false, reason: "below-threshold",
  });
  assert.equal(policy.startDecision(state({ edgeDistance: 15, forwardBuffer: 2.99 }), {}, 3_000).start, false);
  assert.equal(policy.startDecision(state({ edgeDistance: 0.5, forwardBuffer: 3 }), {}, 3_000).start, true);
  assert.equal(policy.startDecision(state({ edgeDistance: null, forwardBuffer: 3 }), {}, 3_000).start, true);
  assert.equal(policy.startDecision(state({ margin: 2, forwardBuffer: 2.49 }), { autoStart: 2 }, 3_000).start, false);
  assert.equal(policy.startDecision(state({ margin: 2, forwardBuffer: 2.5 }), { autoStart: 2 }, 3_000).start, true);
});

test("disconnected future ranges do not provide continuous playback headroom", () => {
  const playback = media.snapshot({
    currentTime: 90,
    paused: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    seekable: ranges([[80, 120]]),
    buffered: ranges([[80, 91], [95, 120]]),
  });
  assert.equal(playback.edgeDistance, 30);
  assert.equal(playback.forwardBuffer, 1);
  assert.deepEqual(policy.startDecision(state(playback), {}, 3_000), {
    start: false, reason: "below-threshold",
  });

  const missingCurrentRange = media.snapshot({
    currentTime: 92,
    paused: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    seekable: ranges([[80, 120]]),
    buffered: ranges([[80, 91], [95, 120]]),
  });
  assert.deepEqual(policy.startDecision(state(missingCurrentRange), {}, 3_000), {
    start: false, reason: "invalid-timing",
  });
});

test("a valid continuous buffer remains available when seekable ranges are absent", () => {
  const playback = media.snapshot({
    currentTime: 90,
    paused: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    seekable: ranges([]),
    buffered: ranges([[80, 94]]),
  });
  assert.equal(playback.edgeDistance, null);
  assert.equal(playback.forwardBuffer, 4);
  assert.deepEqual(policy.startDecision(state(playback), {}, 3_000), {
    start: true, reason: "ready",
  });
  assert.deepEqual(policy.activeDecision(state(playback), session(), 3_000), {
    stop: false, reason: "catching-up",
  });
});

test("active catch-up stops at its target or before exhausting the buffer", () => {
  assert.deepEqual(policy.activeDecision(state({ edgeDistance: 20, forwardBuffer: 0.6 }), session(), 3_000), {
    stop: true, reason: "target-reached",
  });
  assert.equal(policy.activeDecision(state({ forwardBuffer: 0.4 }), session(), 3_000).stop, true);
  assert.deepEqual(policy.activeDecision(state({ edgeDistance: 2, forwardBuffer: 0.6 }), session({ margin: 0.2 }), 3_000), {
    stop: true, reason: "low-buffer",
  });
  assert.deepEqual(policy.activeDecision(state({ edgeDistance: 2, forwardBuffer: 0.61 }), session(), 3_000), {
    stop: false, reason: "catching-up",
  });
  assert.equal(policy.activeDecision(state({ edgeDistance: 4, forwardBuffer: 2 }), session({ margin: 2 }), 3_000).stop, true);
  assert.equal(policy.activeDecision(state({ edgeDistance: 0.1, forwardBuffer: 4 }), session(), 3_000).stop, false);
  assert.equal(policy.activeDecision(state({ edgeDistance: null, forwardBuffer: 4 }), session(), 3_000).stop, false);
});

test("active catch-up stops on playback interruption or missing measurements", () => {
  for (const overrides of [
    { isLive: false }, { videoFound: false }, { paused: true }, { seeking: true },
    { ended: true }, { readyState: 2 }, { adState: "detected" },
    { forwardBuffer: NaN }, { currentTime: Infinity },
  ]) {
    assert.equal(policy.activeDecision(state(overrides), session(), 3_000).stop, true);
  }
  assert.equal(policy.activeDecision(state({ adState: "unknown" }), session(), 3_000).stop, false);
});

test("active catch-up has no duration limit but stops when playback does not progress", () => {
  assert.deepEqual(policy.activeDecision(state(), session({ lastProgressAt: 31_000 }), 31_000), {
    stop: false, reason: "catching-up",
  });
  assert.equal(policy.activeDecision(state(), session({ lastProgressAt: 61_000 }), 61_000).stop, false);
  assert.deepEqual(policy.activeDecision(state(), session(), 6_000), { stop: true, reason: "no-progress" });
  assert.equal(policy.activeDecision(state(), session(), 5_999).stop, false);
});

test("invalid sessions stop safely and policy decisions never mutate inputs", () => {
  for (const overrides of [
    { margin: NaN }, { margin: 0 }, { margin: 4 }, { startedAt: null },
    { lastProgressAt: Infinity }, { startedAt: 4_000 }, { lastProgressAt: 4_000 },
  ]) {
    assert.deepEqual(policy.activeDecision(state(), session(overrides), 3_000), {
      stop: true, reason: "invalid-session",
    });
  }
  const playback = Object.freeze(state());
  const settings = Object.freeze({ autoEnabled: true, autoStart: 3, autoRate: 1.5, margin: 0.6 });
  const active = Object.freeze(session());
  assert.equal(policy.startDecision(playback, settings, 3_000).start, true);
  assert.equal(policy.activeDecision(playback, active, 3_000).stop, false);
  assert.equal(playback.currentTime, 90);
  assert.equal(playback.playbackRate, 1);
});

test("adaptive speed tapers with surplus and never exceeds the selected maximum", () => {
  assert.equal(policy.adaptiveRate(1, 1, 2), 1);
  assert.equal(policy.adaptiveRate(0.5, 1, 2), 1);
  assert.equal(policy.adaptiveRate(NaN, 1, 2), 1);
  const rates = [0.1, 0.5, 1, 2, 8].map(extra => policy.adaptiveRate(2 + extra, 2, 1.5));
  assert.ok(rates.every(rate => rate > 1 && rate <= 1.5));
  assert.deepEqual([...rates].sort((a, b) => a - b), rates);
  assert.equal(rates.at(-1), 1.5);
});
