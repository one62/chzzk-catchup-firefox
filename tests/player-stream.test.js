"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/player-stream.js");
function fixture(options = {}) {
  const video = { isConnected: true, paused: false, seeking: false, ended: false, readyState: 4 };
  const old = { id: "old", kind: "main", label: "1080p", width: 1920, height: 1080 };
  const p2p = { id: "p2p", kind: "low-latency-p2p", label: "1080p" };
  const ll = { id: "ll", kind: "low-latency", label: "1080p", width: 1920, height: 1080 };
  const abr = { id: "abr", kind: "low-latency", label: "ABR" };
  const tracks = [old, p2p, abr, ll];
  let selected = old, partHandler, offCount = 0, time = 0;
  for (const t of tracks) Object.defineProperty(t, "selected", {
    get: () => t === selected,
    set: value => { if (value) { selected = t; options.onSelect?.(t, video); } },
  });
  const hls = { lowLatencyMode: true, currentLevel: 0,
    levels: [{ details: { partTarget: 1, partHoldBack: 3, canBlockReload: true } }],
    on: (_event, cb) => { partHandler = cb; }, off: () => { offCount++; },
  };
  const player = { videoTracks: tracks, srcObject: { data: { media: [{ path: "https://cdn.test/private?token=secret" }] } },
    _corePlayer: { player: { video, _mediaController: { getHlsInstance: () => hls } } } };
  const window = { __player: options.react ? null : player };
  if (options.react) video.parentElement = { "__reactFiber$test": { memoizedState: { memoizedState: player } } };
  const controller = ChzzkCatchupPlayerStream.create({ document: {}, window, now: () => time,
    delay: async ms => { time += options.delayMs ?? ms; options.onDelay?.(player, tracks, video); } });
  return { controller, player, video, tracks, old, ll, hls, window,
    emitPart: data => partHandler?.("hlsFragBuffered", data), offCount: () => offCount };
}
test("discovers official facade from live React hooks without a debug global", () => {
  const f = fixture({ react: true });
  const result = f.controller.inspect(f.video);
  assert.equal(result.available, true);
  assert.equal(result.selectedKind, "main");
  assert.equal(result.tracks.some(track => track.kind === "low-latency"), true);
  assert.doesNotMatch(JSON.stringify(result), /private|token|secret/);
});
test("selects matching non-P2P low-latency quality without restarting an existing selection", async () => {
  const f = fixture();
  const result = await f.controller.change(f.video);
  assert.equal(result.ok, true);
  assert.equal(f.ll.selected, true);
  assert.equal((await f.controller.change(f.video)).reason, "already-selected");
  assert.equal(f.ll.selected, true);
});
test("partial playback is confirmed only after an actual part-buffered event", () => {
  const f = fixture();
  assert.equal(f.controller.inspect(f.video).hls.bufferedPartCount, 0);
  f.emitPart({ frag: {} });
  assert.equal(f.controller.inspect(f.video).hls.bufferedPartCount, 0);
  f.emitPart({ part: { index: 0 } });
  assert.equal(f.controller.inspect(f.video).hls.bufferedPartCount, 1);
  f.controller.destroy();
  assert.equal(f.offCount(), 1);
});
test("failed playback restores only the still-owned selection", async () => {
  const f = fixture({ onSelect: (track, video) => { if (track.kind === "low-latency") video.readyState = 1; } });
  const result = await f.controller.change(f.video);
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(f.old.selected, true);
});
test("external selection during switch is preserved", async () => {
  const f = fixture({ onDelay: (_player, tracks) => { tracks[1].selected = true; } });
  assert.equal((await f.controller.change(f.video)).reason, "selection-changed");
  assert.equal(f.tracks[1].selected, true);
});
test("source replacement and unavailable players cannot mutate another playback", async () => {
  const f = fixture({ onDelay: player => { player.srcObject = { data: { media: [] } }; } });
  assert.equal((await f.controller.change(f.video)).reason, "player-changed");
  f.video.isConnected = false;
  assert.equal((await f.controller.change(f.video)).reason, "player-unavailable");
});
test("paused and rewind playback refuse trial and concurrent switches are refused", async () => {
  const f = fixture();
  f.video.paused = true;
  assert.equal((await f.controller.change(f.video)).reason, "not-playing");
  f.video.paused = false;
  f.player.srcObject.data.meta = { liveRewind: true };
  assert.equal((await f.controller.change(f.video)).reason, "not-playing");
  f.player.srcObject.data.meta = {};
  const pending = f.controller.change(f.video);
  assert.equal((await f.controller.change(f.video)).reason, "busy");
  assert.equal((await pending).ok, true);
});

test("delayed callbacks time out against elapsed time instead of reporting a stale success", async () => {
  let callbacks = 0;
  const f = fixture({ delayMs: 16000, onDelay: () => callbacks++ });
  const result = await f.controller.change(f.video);
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(callbacks, 1);
  assert.equal(f.old.selected, true);
});

test("page teardown invalidates pending switches without restoring over later selections", async () => {
  const f = fixture();
  const pending = f.controller.change(f.video);
  f.controller.destroy();
  f.tracks[1].selected = true;
  assert.equal((await pending).reason, "player-changed");
  assert.equal(f.tracks[1].selected, true);
  assert.equal((await f.controller.change(f.video)).ok, true);
});

test("HLS can be selected again with matching quality and unsupported kinds never mutate tracks", async () => {
  const f = fixture();
  await f.controller.change(f.video, "low-latency");
  assert.equal((await f.controller.change(f.video, "main")).ok, true);
  assert.equal(f.old.selected, true);
  assert.equal((await f.controller.change(f.video, "arbitrary")).reason, "invalid-kind");
  assert.equal(f.old.selected, true);
  f.player.videoTracks = [f.ll];
  f.ll.selected = true;
  assert.equal((await f.controller.change(f.video, "main")).reason, "track-unavailable");
  assert.equal(f.ll.selected, true);
});

test("failed HLS switch restores the previous LL-HLS selection", async () => {
  const f = fixture({ onSelect: (track, video) => { video.readyState = track.kind === "main" ? 1 : 4; } });
  f.ll.selected = true;
  const result = await f.controller.change(f.video, "main");
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(f.ll.selected, true);
});
