"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/playback-policy.js");

test("automatic buffer preference migrates the legacy switch while explicit new choices win", () => {
  assert.deepEqual(policy.normalize(), { streamMode: "auto", bufferAutoEnabled: true });
  assert.equal(policy.normalize({ bufferGuardEnabled: false }).bufferAutoEnabled, false);
  assert.equal(policy.normalize({ bufferGuardEnabled: true }).bufferAutoEnabled, true);
  assert.equal(policy.normalize({ bufferAutoEnabled: false, bufferGuardEnabled: true }).bufferAutoEnabled, false);
  assert.equal(policy.normalize({ bufferAutoEnabled: true, bufferGuardEnabled: false }).bufferAutoEnabled, true);
  for (const value of [null, undefined, "false", 0]) {
    assert.equal(policy.normalize({ bufferAutoEnabled: value }).bufferAutoEnabled, true);
  }
  assert.deepEqual(policy.normalize(null), policy.normalize());
  assert.deepEqual(policy.normalize({ bufferGuardCount: 5, bufferGuardMax: 0.2 }), policy.normalize());
});

test("connection preferences accept and describe only supported modes", () => {
  assert.equal(policy.normalize({ streamMode: "hls" }).streamMode, "hls");
  assert.equal(policy.normalize({ streamMode: "other" }).streamMode, "auto");
  assert.equal(policy.connectionLabel("main"), "HLS");
  assert.equal(policy.connectionLabel("low-latency-p2p"), "LL-HLS · P2P");
  assert.equal(policy.connectionLabel(null), "연결 확인 중");
  assert.equal(policy.matchesMode("main", "llhls"), false);
  assert.equal(policy.matchesMode("low-latency-p2p", "auto"), true);
});
