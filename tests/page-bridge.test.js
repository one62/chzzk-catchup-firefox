"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "../src/page-bridge.js"), "utf8");
test("MAIN bridge validates origin/actions and returns only its adapter result", async () => {
  const listeners = [], messages = [], video = {}, preview = {}, calls = [];
  let pagehide;
  const window = { addEventListener: (type, callback) => {
    if (type === "message") listeners.push(callback);
    if (type === "pagehide") pagehide = callback;
  }, postMessage: message => messages.push(message),
  __getLiveInfo: () => { throw new Error("PC clock based player API must not be called"); } };
  const location = { pathname: "/live/test", origin: "https://chzzk.naver.com" };
  let clockResets = 0;
  vm.runInNewContext(source, { window, location,
    document: { querySelectorAll: () => [preview, video] }, ChzzkCatchupServerLatency: { create: () => ({
      read: value => value === video ? 2.3 : null, reset() { clockResets++; },
    }) }, ChzzkCatchupPlayerStream: { create: () => ({
      inspect: value => { calls.push(value); return { available: true }; },
      change: async (value, restore) => { calls.push(restore); return { ok: true, reason: "selected" }; }, destroy() {},
    }) } });
  const request = { namespace: "chzzk-catchup-stream-request", token: "test", requestId: 1, videoIndex: 1, action: "inspect" };
  const emit = async (data, origin = "https://chzzk.naver.com") => {
    for (const listener of listeners) await listener({ data, origin, source: window });
  };
  await emit(request, "https://evil.test");
  await emit({ ...request, action: "load-url" });
  assert.equal(messages.length, 0);
  await emit(request);
  assert.equal(calls[0], video);
  assert.equal(messages[0].stream.available, true);
  await emit({ ...request, action: "restore" });
  assert.equal(calls.length, 1);
  await emit({ ...request, action: "switch", kind: "external-url" });
  assert.equal(calls.length, 1);
  await emit({ ...request, action: "switch", kind: "main" });
  assert.equal(calls[1], "main");
  await emit({ ...request, action: "switch", kind: "low-latency" });
  assert.equal(calls[2], "low-latency");
  const latencyRequest = { namespace: "chzzk-catchup-latency-request", token: "test", requestId: 2, videoIndex: 1 };
  await emit(latencyRequest, "https://evil.test");
  await emit({ ...latencyRequest, videoIndex: -1 });
  await emit({ ...latencyRequest, videoIndex: undefined });
  assert.equal(messages.length, 3);
  await emit(latencyRequest);
  assert.equal(messages.at(-1).latency, 2.3);
  await emit({ ...latencyRequest, videoIndex: 0 });
  assert.equal(messages.at(-1).latency, null);
  location.pathname = "/video/test";
  await emit(latencyRequest);
  assert.equal(messages.at(-1).latency, null);
  pagehide();
  assert.equal(clockResets, 1);
});
