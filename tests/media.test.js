"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const media = require("../src/media.js");

function timeRanges(values) {
  return {
    length: values.length,
    start: (index) => values[index][0],
    end: (index) => values[index][1],
  };
}

function video(overrides = {}) {
  return {
    currentTime: 90,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    seekable: timeRanges([[0, 100]]),
    buffered: timeRanges([[88, 95]]),
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: 2, totalVideoFrames: 100 }),
    ...overrides,
  };
}

test("browser global and CommonJS expose the same calculation API", () => {
  assert.equal(globalThis.ChzzkCatchupMedia, media);
});

test("range reads ignore nonfinite, empty, reversed, and invalidated ranges", () => {
  const ranges = timeRanges([[1, 4], [NaN, 9], [5, Infinity], [8, 8], [10, 9], [20, 22]]);
  const originalStart = ranges.start;
  ranges.start = (index) => {
    if (index === 0) throw new Error("source replaced");
    return originalStart(index);
  };
  assert.deepEqual(media.readRanges(ranges), [[20, 22]]);
  assert.deepEqual(media.readRanges(null), []);
  assert.deepEqual(media.readRanges({ length: Infinity }), []);
});

test("margin normalization rounds valid values and rejects invalid values", () => {
  assert.equal(media.normalizeMargin("0.65"), 0.7);
  assert.equal(media.normalizeMargin(0.2), 0.2);
  assert.equal(media.normalizeMargin(3), 3);
  for (const invalid of [NaN, Infinity, -1, 0.1, 3.1, "", "invalid", true, null]) {
    assert.equal(media.normalizeMargin(invalid), 0.6);
  }
  assert.equal(media.normalizeMargin(NaN, 1.24), 1.2);
  assert.equal(media.normalizeMargin(NaN, Infinity), 0.6);
});

test("snapshot measures only continuous buffered data at the current position", () => {
  const state = media.snapshot(video({
    currentTime: 12,
    seekable: timeRanges([[0, 15], [20, 30]]),
    buffered: timeRanges([[10, 15], [20, 30]]),
  }));
  assert.equal(state.edgeDistance, 18);
  assert.equal(state.forwardBuffer, 3);
  assert.equal(state.droppedFrames, 2);
  assert.equal(state.totalFrames, 100);

  assert.equal(media.snapshot(video({
    currentTime: 18,
    buffered: timeRanges([[10, 15], [20, 30]]),
  })).forwardBuffer, null);
  assert.equal(media.snapshot(video({
    currentTime: 15,
    buffered: timeRanges([[10, 15], [20, 30]]),
  })).forwardBuffer, null);
});

test("snapshot returns null for unavailable numeric measurements", () => {
  const state = media.snapshot(video({
    currentTime: NaN,
    readyState: Infinity,
    playbackRate: NaN,
    seekable: timeRanges([[NaN, Infinity]]),
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: Infinity, totalVideoFrames: NaN }),
  }));
  assert.equal(state.currentTime, null);
  assert.equal(state.readyState, null);
  assert.equal(state.playbackRate, null);
  assert.equal(state.edgeDistance, null);
  assert.equal(state.forwardBuffer, null);
  assert.equal(state.droppedFrames, null);
  assert.equal(state.totalFrames, null);
  assert.equal(media.snapshot(video({ getVideoPlaybackQuality() { throw new Error("unavailable"); } })).droppedFrames, null);
});

test("normal catch-up plans a 0.6-second margin without mutating playback", () => {
  const element = video();
  const before = { currentTime: element.currentTime, playbackRate: element.playbackRate, paused: element.paused };
  assert.deepEqual(media.planCatchUp(element, 0.6), {
    ok: true,
    target: 94.4,
    from: 90,
    edge: 95,
    margin: 0.6,
    source: "buffered",
    skipSeconds: 94.4 - 90,
  });
  assert.deepEqual({ currentTime: element.currentTime, playbackRate: element.playbackRate, paused: element.paused }, before);
});

test("catch-up remains inside the current continuous buffer instead of crossing a gap", () => {
  const plan = media.planCatchUp(video({
    currentTime: 12,
    seekable: timeRanges([[0, 15], [20, 30]]),
    buffered: timeRanges([[10, 15], [20, 30]]),
  }), 0.6);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 14.4);
  assert.equal(plan.edge, 15);
  assert.equal(plan.source, "buffered");
  assert.equal(plan.skipSeconds, 14.4 - 12);
});

test("catch-up uses the current buffer whether seekable is missing or points farther ahead", () => {
  for (const seekable of [timeRanges([]), timeRanges([[0, Infinity], [NaN, 100]]), timeRanges([[0, 120]])]) {
    const plan = media.planCatchUp(video({
      seekable,
      buffered: timeRanges([[80, 85], [90, 100]]),
    }), 0.6);
    assert.equal(plan.ok, true);
    assert.equal(plan.source, "buffered");
    assert.equal(plan.target, 99.4);
    assert.equal(plan.margin, 0.6);
  }
});

test("a missing current buffer or its exhausted end cannot jump to future buffered or seekable ranges", () => {
  for (const currentTime of [15, 18, 30]) {
    const plan = media.planCatchUp(video({
      currentTime,
      seekable: timeRanges([[0, 40]]),
      buffered: timeRanges([[10, 15], [20, 30]]),
    }), 0.6);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /연속.*버퍼/);
  }
});

test("a margin wider than the current range never seeks backward", () => {
  for (const currentTime of [12, 12.1, 12.25]) {
    const element = video({
      currentTime,
      seekable: timeRanges([[0, 100]]),
      buffered: timeRanges([[12, 12.3], [20, 100]]),
    });
    const plan = media.planCatchUp(element, 0.6);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /목표 위치/);
    assert.equal(element.currentTime, currentTime);
  }
});

test("paused, ended, seeking, or unready media cannot trigger catch-up", () => {
  for (const overrides of [{ paused: true }, { ended: true }, { seeking: true }, { readyState: 1 }, { readyState: NaN }]) {
    const result = media.planCatchUp(video(overrides), 0.6);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  }
});

test("nonfinite current position or no valid media ranges cannot trigger catch-up", () => {
  for (const currentTime of [NaN, Infinity, -Infinity]) {
    assert.equal(media.planCatchUp(video({ currentTime }), 0.6).ok, false);
  }
  assert.equal(media.planCatchUp(video({ seekable: timeRanges([]), buffered: timeRanges([[0, NaN]]) }), 0.6).ok, false);
});

test("catch-up never moves backwards or seeks again from its target", () => {
  for (const currentTime of [94.4, 94.8, 95, 99.4, 100, 101]) {
    assert.equal(media.planCatchUp(video({ currentTime }), 0.6).ok, false);
  }
  assert.equal(media.snapshot(video({ currentTime: 101 })).edgeDistance, 0);
});

test("buffer-only reads match snapshots without fetching frame statistics", () => {
  const current = video({ buffered: timeRanges([[88, 95], [97, 110]]) });
  const expected = media.snapshot(current).forwardBuffer;
  let qualityReads = 0;
  current.getVideoPlaybackQuality = () => { qualityReads++; return {}; };
  assert.equal(media.forwardBuffer(current), expected);
  assert.equal(qualityReads, 0);
  current.currentTime = 96;
  assert.equal(media.forwardBuffer(current), null);
  assert.equal(media.forwardBuffer(null), null);
});
