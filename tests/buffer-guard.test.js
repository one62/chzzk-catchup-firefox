"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/playback-policy.js");
const { create } = require("../src/buffer-guard.js");

test("playback preferences validate bounded values and label only known connections", () => {
  const defaults = policy.normalize();
  assert.equal(defaults.streamMode, "auto");
  assert.equal(defaults.bufferGuardEnabled, true);
  assert.equal(defaults.bufferGuardCount, 2);
  assert.equal(defaults.bufferGuardStep, 0.2);
  assert.equal(defaults.bufferGuardMax, 3);
  assert.deepEqual(policy.normalize({ streamMode: "other", bufferGuardCount: 1.5,
    bufferGuardStep: NaN, bufferGuardMax: 4 }), defaults);
  assert.equal(policy.normalize({ streamMode: "hls" }).streamMode, "hls");
  assert.equal(policy.connectionLabel("main"), "HLS");
  assert.equal(policy.connectionLabel("low-latency-p2p"), "LL-HLS · P2P");
  assert.equal(policy.connectionLabel(null), "연결 확인 중");
  assert.equal(policy.matchesMode("main", "llhls"), false);
  assert.equal(policy.matchesMode("low-latency-p2p", "auto"), true);
});

test("only repeated distinct stalls lasting at least 250ms raise the margin", () => {
  const guard = create(), settings = policy.normalize();
  guard.begin(0);
  assert.equal(guard.tick(249, 0.6, settings), null);
  guard.cancel();
  guard.begin(1000);
  assert.equal(guard.tick(1250, 0.6, settings), null);
  guard.begin(1300); // Duplicate waiting events in one interruption.
  assert.equal(guard.tick(1500, 0.6, settings), null);
  guard.cancel();
  guard.begin(2000);
  assert.deepEqual(guard.tick(2250, 0.6, settings), { from: 0.6, to: 0.8, count: 2, windowSeconds: 60 });
  assert.equal(guard.tick(6000, 0.6, settings), null);
  assert.equal(guard.margin(0.6, settings), 0.8);
});

test("stalls expire after 60 seconds and cancellation does not become a stall", () => {
  const guard = create(), settings = policy.normalize();
  guard.begin(0); guard.tick(250, 0.6, settings); guard.cancel();
  guard.begin(60001);
  assert.equal(guard.tick(60251, 0.6, settings), null);
  guard.cancel(); guard.begin(61000); guard.cancel();
  assert.equal(guard.tick(62000, 0.6, settings), null);
  assert.equal(guard.margin(0.6, settings), 0.6);
});

test("increments respect the cap, never reduce a larger base, and reset or disable cleanly", () => {
  const guard = create(), settings = policy.normalize({ bufferGuardStep: 1, bufferGuardMax: 1.2 });
  for (const now of [0, 1000]) {
    guard.begin(now); guard.tick(now + 250, 0.6, settings); guard.cancel();
  }
  assert.equal(guard.margin(0.6, settings), 1.2);
  for (const now of [2000, 3000]) {
    guard.begin(now); assert.equal(guard.tick(now + 250, 0.6, settings), null); guard.cancel();
  }
  assert.equal(guard.margin(2, settings), 2);
  assert.equal(guard.margin(0.6, { ...settings, bufferGuardEnabled: false }), 0.6);
  guard.reset();
  assert.equal(guard.margin(0.6, settings), 0.6);
});
