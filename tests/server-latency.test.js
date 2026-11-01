"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../src/server-latency.js");

const BASE = Date.parse("2026-10-25T00:00:00Z");
const ORIGIN = "https://chzzk.naver.com";
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function response(overrides = {}) {
  const headers = { date: "Sun, 25 Oct 2026 00:00:00 GMT", ...overrides.headers };
  return { ok: true, redirected: false, ...overrides,
    headers: { get: name => headers[name.toLowerCase()] ?? null } };
}

function cue(ingest = BASE - 3000, overrides = {}) {
  return { startTime: 9, endTime: 12,
    value: { info: "com.navercorp.nmss.timestamp",
      data: new TextEncoder().encode(JSON.stringify({ "ingest-utc": ingest })) }, ...overrides };
}

function video(overrides = {}) {
  return { isConnected: true, duration: Infinity, currentTime: 10,
    textTracks: [{ kind: "metadata", mode: "hidden", activeCues: [cue()] }], ...overrides };
}

function harness() {
  let time = 0, nextTimer = 1;
  const requests = [], timers = new Map();
  const location = { origin: ORIGIN, pathname: "/live/test-channel" };
  const clock = create({ now: () => time, location, nonce: () => "test-nonce",
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  function advance(milliseconds) {
    const until = time + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    time = until;
  }
  async function synchronize(element = video(), delay = 200, result = response()) {
    assert.equal(clock.read(element), null);
    await flush();
    assert.ok(requests.length, "a live media clock request should start");
    advance(delay);
    requests.at(-1).resolve(result);
    await flush();
    return element;
  }
  return { clock, requests, location, advance, synchronize, setTime: value => { time = value; } };
}

test("uses response Date, half-second precision and RTT instead of the PC clock", async () => {
  const app = harness();
  const element = await app.synchronize();
  assert.equal(app.clock.read(element), 2.6);
  const request = app.requests[0];
  const url = new URL(request.url, ORIGIN);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, app.location.pathname);
  assert.ok(url.search.includes("test-nonce"));
  assert.equal(request.options.method, "HEAD");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  const originalNow = Date.now;
  Date.now = () => { throw new Error("PC wall time must not be read"); };
  try {
    app.advance(1000);
    element.currentTime += 1;
    assert.equal(app.clock.read(element), 2.6);
  } finally { Date.now = originalNow; }
});

test("refreshes independently every thirty seconds without delaying the cached measurement", async () => {
  const app = harness();
  const element = await app.synchronize();
  app.advance(29000);
  app.clock.read(element);
  assert.equal(app.requests.length, 1);
  app.advance(1200);
  assert.equal(typeof app.clock.read(element), "number");
  await flush();
  assert.equal(app.requests.length, 2);
  app.clock.read(element);
  assert.equal(app.requests.length, 2);
  app.advance(200);
  app.requests[1].resolve(response({ headers: { date: "Sun, 25 Oct 2026 00:00:30 GMT" } }));
  await flush();
  assert.equal(app.clock.read(element), 32.6);
});

test("failed refresh retains a fresh clock but expires after ninety seconds", async () => {
  const app = harness();
  const element = await app.synchronize();
  app.advance(31000);
  assert.equal(typeof app.clock.read(element), "number");
  await flush();
  app.requests[1].reject(new Error("offline"));
  await flush();
  assert.equal(typeof app.clock.read(element), "number");
  app.advance(60000);
  assert.equal(app.clock.read(element), null);
});

test("failed synchronization retries with a cooldown and never falls back to player latency", async () => {
  const app = harness();
  const element = video();
  app.clock.read(element);
  await flush();
  app.requests[0].reject(new Error("offline"));
  await flush();
  assert.equal(app.clock.read(element), null);
  app.advance(9000);
  app.clock.read(element);
  assert.equal(app.requests.length, 1);
  app.advance(1100);
  app.clock.read(element);
  await flush();
  assert.equal(app.requests.length, 2);
});

test("missing, invalid, cached and unsuccessful response timestamps remain unavailable", async () => {
  for (const result of [response({ headers: { date: null } }), response({ headers: { date: "invalid" } }),
    response({ headers: { age: "1" } }), response({ headers: { age: "invalid" } }),
    response({ ok: false }), response({ redirected: true }),
    response({ url: "https://another.test/live/test-channel" }),
    response({ url: `${ORIGIN}/live/another-channel` })]) {
    const app = harness();
    const element = await app.synchronize(video(), 200, result);
    assert.equal(app.clock.read(element), null);
  }
  const app = harness();
  const element = await app.synchronize(video(), 200, response({ headers: { age: "0" } }));
  assert.equal(app.clock.read(element), 2.6);
});

test("slow and timed out responses cannot establish or later revive a clock", async () => {
  const slow = harness();
  const element = await slow.synchronize(video(), 1501);
  assert.equal(slow.clock.read(element), null);
  const timed = harness();
  timed.clock.read(element);
  await flush();
  timed.advance(2100);
  assert.equal(timed.requests[0].options.signal.aborted, true);
  timed.requests[0].resolve(response());
  await flush();
  assert.equal(timed.clock.read(element), null);
});

test("channel changes discard pending responses and synchronize the new page", async () => {
  const app = harness();
  const element = video();
  app.clock.read(element);
  await flush();
  app.location.pathname = "/live/another-channel";
  assert.equal(app.clock.read(element), null);
  await flush();
  assert.equal(app.requests.length, 2);
  app.requests[0].resolve(response());
  await flush();
  assert.equal(app.clock.read(element), null);
  app.advance(200);
  app.requests[1].resolve(response());
  await flush();
  assert.equal(app.clock.read(element), 2.6);
});

test("reset aborts pending work and prevents stale results after page suspension", async () => {
  const app = harness();
  const element = video();
  app.clock.read(element);
  await flush();
  app.clock.reset();
  assert.equal(app.requests[0].options.signal.aborted, true);
  app.requests[0].resolve(response());
  await flush();
  assert.equal(app.clock.read(element), null);
  await flush();
  assert.equal(app.requests.length, 2);
});

test("metadata uses the current cue's ingest time and media position without changing playback", async () => {
  const app = harness();
  const element = await app.synchronize();
  const original = { currentTime: element.currentTime, duration: element.duration,
    playbackRate: element.playbackRate, paused: element.paused };
  element.textTracks.unshift({ kind: "subtitles", mode: "showing", activeCues: [cue(BASE)] });
  assert.equal(app.clock.read(element), 2.6);
  assert.deepEqual({ currentTime: element.currentTime, duration: element.duration,
    playbackRate: element.playbackRate, paused: element.paused }, original);
  element.currentTime = 11;
  assert.equal(app.clock.read(element), 1.6);
});

test("disabled metadata tracks become hidden while unavailable cues stay unknown", async () => {
  const app = harness();
  const element = video({ textTracks: [{ kind: "metadata", mode: "disabled", activeCues: null }] });
  await app.synchronize(element);
  assert.equal(app.clock.read(element), null);
  assert.equal(element.textTracks[0].mode, "hidden");
  element.textTracks[0].activeCues = [cue()];
  assert.equal(app.clock.read(element), 2.6);
});

test("newest valid active metadata wins and malformed cues do not hide valid timing", async () => {
  const app = harness();
  const element = await app.synchronize();
  element.textTracks[0].activeCues = [
    cue(BASE - 10000, { startTime: 8 }),
    cue(BASE - 3000),
    cue(BASE - 1000, { startTime: 9.5,
      value: { info: "com.navercorp.nmss.timestamp", data: new Uint8Array([0xff]) } }),
  ];
  assert.equal(app.clock.read(element), 2.6);
});

test("finite-duration live media still uses its current ingest metadata", async () => {
  const app = harness();
  const element = await app.synchronize(video({ duration: 120 }));
  assert.equal(app.clock.read(element), 2.6);
});

test("non-live pages stay unavailable without starting a clock request", async () => {
  const app = harness();
  const element = await app.synchronize();
  app.location.pathname = "/video/test";
  assert.equal(app.clock.read(element), null);
  await flush();
  assert.equal(app.requests.length, 1);
  app.advance(100000);
  assert.equal(app.clock.read(element), null);
  await flush();
  assert.equal(app.requests.length, 1);
});

test("invalid metadata, positions and disconnected elements never become valid latency", async () => {
  const invalidCues = [cue(BASE - 3000, { startTime: 11 }), cue(BASE - 3000, { endTime: 9 }),
    cue(BASE - 3000, { value: { info: "other", data: new Uint8Array() } }),
    cue(BASE - 3000, { value: { info: "com.navercorp.nmss.timestamp", data: new TextEncoder().encode("not JSON") } }),
    cue("123"), cue(null), cue(-1), cue(BASE + 10000), cue(BASE - 86401000)];
  const app = harness();
  const element = await app.synchronize();
  for (const invalid of invalidCues) {
    element.textTracks[0].activeCues = [invalid];
    assert.equal(app.clock.read(element), null);
  }
  element.textTracks[0].activeCues = [cue()];
  for (const changes of [{ currentTime: NaN }, { currentTime: Infinity }, { currentTime: -1 },
    { isConnected: false }, { textTracks: [] }]) {
    assert.equal(app.clock.read({ ...element, ...changes }), null);
  }
});
