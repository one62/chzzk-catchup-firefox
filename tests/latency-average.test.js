"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../src/latency-average.js");

test("averages only measurements in the most recent five seconds", () => {
  const average = create();
  [2, 4, 3, 5, 1, 2].forEach((value, index) => average.add(value, index * 1000, 100000 + index * 1000));
  assert.deepEqual(average.get(5000), { value: 3, sampleCount: 5, windowSeconds: 5 });
  assert.equal(average.get(5500).value, 3);
});

test("startup uses available samples and duplicate timestamps replace rather than overweight", () => {
  const average = create();
  assert.equal(average.get(0).value, null);
  average.add(2, 0, 100000);
  average.add(4, 0, 100000);
  assert.equal(average.get(0).value, 4);
  assert.equal(average.get(0).sampleCount, 1);
  average.add(2, 1000, 101000);
  assert.equal(average.get(1000).value, 3);
});

test("stale or invalid data immediately becomes unknown and never revives old samples", () => {
  for (const invalid of [null, NaN, Infinity, -1, 86401]) {
    const average = create();
    average.add(3, 0, 100000);
    average.add(invalid, 1000, 101000);
    assert.equal(average.get(1000).value, null);
    average.add(1, 2000, 102000);
    assert.equal(average.get(2000).value, 1);
  }
  const stale = create();
  stale.add(3, 0, 100000);
  assert.equal(stale.get(2500).value, 3);
  assert.equal(stale.get(2501).value, null);
  stale.add(1, 3000, 103000);
  assert.equal(stale.get(3000).value, 1);
});

test("clock corrections, regressing monotonic time and measurement gaps start a new average", () => {
  for (const [now, wall] of [[1000, 103950], [-1, 101000], [3000, 103000]]) {
    const average = create();
    average.add(2, 0, 100000);
    average.add(5, now, wall);
    assert.equal(average.get(now).value, 5);
    assert.equal(average.get(now).sampleCount, 1);
  }
});

test("reset removes old playback measurements and storage is bounded", () => {
  const average = create();
  for (let index = 0; index < 1000; index++) average.add(index % 2, index, 100000 + index);
  assert.equal(average.get(999).sampleCount, 64);
  average.reset();
  assert.equal(average.get(999).value, null);
});
