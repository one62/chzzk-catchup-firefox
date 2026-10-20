"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const mediaSource = fs.readFileSync(path.join(__dirname, "../src/media.js"), "utf8");
const autoPolicySource = fs.readFileSync(path.join(__dirname, "../src/auto-policy.js"), "utf8");
const latencyAverageSource = fs.readFileSync(path.join(__dirname, "../src/latency-average.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
const REMOTE_MEDIA_URL = "https://cdn.example.test/live.m3u8?private-token=do-not-export";

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, data = {}) {
    for (const callback of [...(this.listeners.get(name) || [])]) {
      callback({ type: name, currentTarget: this, ...data });
    }
  }
}

class Element extends Events {
  constructor() {
    super();
    this.isConnected = true;
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.box = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
    this.markers = [];
  }
  getBoundingClientRect() { return this.box; }
  querySelectorAll() { return this.markers; }
  closest() { return this.player || null; }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  appendChild(element) {
    element.parentElement?.removeChild(element);
    this.children.push(element);
    element.parentElement = this;
    return element;
  }
  removeChild(element) {
    this.children = this.children.filter((child) => child !== element);
    element.parentElement = null;
  }
  remove() { this.parentElement?.removeChild(this); this.isConnected = false; }
  attachShadow() {
    const elements = new Map();
    return {
      innerHTML: "",
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
      querySelectorAll() { return []; },
    };
  }
}

function ranges(values) {
  return { length: values.length, start: (index) => values[index][0], end: (index) => values[index][1] };
}

function makeVideo(overrides = {}) {
  const element = new Element();
  Object.assign(element, {
    paused: false, seeking: false, ended: false, readyState: 4,
    seekable: ranges([[0, 100]]), buffered: ranges([[88, 100]]),
    src: REMOTE_MEDIA_URL, currentSrc: REMOTE_MEDIA_URL,
    seekWrites: [], rateWrites: [], playCalls: 0,
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: 2, totalVideoFrames: 100 }),
    play() { this.playCalls += 1; return Promise.resolve(); },
  });
  let currentTime = 90;
  let playbackRate = 1;
  Object.defineProperties(element, {
    currentTime: {
      get: () => currentTime,
      set: (value) => { element.seekWrites.push(value); currentTime = value; },
    },
    playbackRate: {
      get: () => playbackRate,
      set: (value) => { element.rateWrites.push(value); playbackRate = value; },
    },
  });
  // Advance decoded playback without simulating a user seek or script write.
  element.elapse = (seconds) => { currentTime += seconds; };
  Object.assign(element, overrides);
  element.seekWrites.length = 0;
  element.rateWrites.length = 0;
  element.player = new Element();
  element.player.appendChild(element);
  return element;
}

async function harness(overrides = {}, savedSettings = { autoEnabled: false }) {
  let now = Date.parse("2026-10-14T00:00:00Z");
  const initialTime = now;
  let wallOffset = 0;
  let nextTimer = 1;
  let messageListener;
  let storageListener;
  let labelOptions;
  let indicatorOptions;
  const labelCalls = { updates: 0, destroys: 0 };
  const indicatorCalls = { updates: 0, destroys: 0 };
  const timers = new Map();
  const element = makeVideo(overrides);
  const document = new Events();
  document.videos = [element];
  document.body = new Element();
  document.documentElement = { clientWidth: 1280, clientHeight: 720 };
  document.fullscreenElement = null;
  document.hidden = false;
  document.querySelectorAll = (selector) => selector === "video" ? document.videos : [];
  document.getElementById = (id) => document.body.children.find((child) => child.id === id) || null;
  document.createElement = () => new Element();
  const window = new Events();
  const postedMessages = [];
  let streamSnapshot = { available: true, sourceId: 1, selectedKind: "main", tracks: [{ kind: "main" }] };
  function respondStream(request, response) {
    window.emit("message", { source: window, origin: location.origin,
      data: { namespace: "chzzk-catchup-stream-response", token: request.token,
        requestId: request.requestId, ...response } });
  }
  window.postMessage = (message) => {
    postedMessages.push(message);
    if (message.namespace === "chzzk-catchup-stream-request" && message.action === "inspect") {
      respondStream(message, { ok: true, stream: streamSnapshot });
    }
  };
  const location = { pathname: "/live/channel-id", origin: "https://chzzk.naver.com" };
  // Existing automatic-speed tests opt out of the independent entry seek.
  const storage = { margin: 0.6, startupEnabled: false, bufferGuardEnabled: false, ...savedSettings };

  function schedule(callback, delay, interval = false) {
    const id = nextTimer++;
    timers.set(id, { callback, at: now + delay, interval: interval ? delay : 0 });
    return id;
  }
  function advance(milliseconds) {
    const until = now + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
    }
    now = until;
  }

  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now + wallOffset])); }
    static now() { return now + wallOffset; }
  }
  const context = vm.createContext({
    window, document, location, Date: ClockDate,
    performance: { now: () => now - initialTime },
    crypto: { randomUUID: () => `test-id-${nextTimer++}` },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: (id) => timers.delete(id),
    ChzzkCatchupLabel: {
      create: (options) => {
        labelOptions = options;
        return {
          update: () => { labelCalls.updates += 1; },
          destroy: () => { labelCalls.destroys += 1; },
        };
      },
    },
    ChzzkCatchupRateIndicator: {
      create: (options) => {
        indicatorOptions = options;
        return {
          update: () => { indicatorCalls.updates += 1; },
          destroy: () => { indicatorCalls.destroys += 1; },
        };
      },
    },
    browser: {
      runtime: {
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        getManifest: () => ({ version: "0.1.0-test" }),
      },
      storage: {
        local: {
          get: (defaults) => Promise.resolve({ ...defaults, ...storage }),
        },
        onChanged: { addListener: (listener) => { storageListener = listener; } },
      },
    },
  });
  vm.runInContext(mediaSource, context, { filename: "src/media.js" });
  vm.runInContext(autoPolicySource, context, { filename: "src/auto-policy.js" });
  vm.runInContext(latencyAverageSource, context, { filename: "src/latency-average.js" });
  for (const name of ["playback-policy", "buffer-guard"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${name}.js`), "utf8"), context);
  }
  vm.runInContext(contentSource, context, { filename: "src/content.js" });
  await Promise.resolve();
  return {
    video: element, document, location, window, postedMessages, advance, storage, labelCalls, indicatorCalls,
    setStream(value) { streamSnapshot = { ...streamSnapshot, ...value }; },
    respondSwitch(response) {
      if (response.stream) streamSnapshot = response.stream;
      respondStream(postedMessages.findLast(message => message.action === "switch"), response);
    },
    respondStream,
    labelVideo: () => labelOptions?.getVideo(),
    labelLatency: () => labelOptions?.getLatency(),
    labelBuffer: () => labelOptions?.getBuffer(),
    labelConnection: () => labelOptions?.getConnection(),
    indicatorState: () => indicatorOptions?.getState(),
    indicatorVideo: () => indicatorOptions?.getVideo(),
    setWallOffset: (offset) => { wallOffset = offset; },
    respondLatency(value) {
      const request = postedMessages.at(-1);
      window.emit("message", {
        source: window, origin: location.origin,
        data: { namespace: "chzzk-catchup-latency-response", token: request.token,
          requestId: request.requestId, latency: value },
      });
    },
    changeStorage(values) {
      const changes = {};
      for (const [key, newValue] of Object.entries(values)) {
        changes[key] = { oldValue: storage[key], newValue };
        storage[key] = newValue;
      }
      storageListener?.(changes, "local");
    },
    send(type, details = {}) { return messageListener({ namespace: "chzzk-catchup", type, ...details }); },
  };
}

test("LL-HLS automatically takes priority without popup actions then enables the same extension speed policy", async () => {
  const app = await harness({}, {});
  app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  app.advance(250);
  assert.equal(app.postedMessages.filter(message => message.action === "switch").length, 1);
  assert.equal(app.video.playbackRate, 1);
  app.respondSwitch({ ok: true, reason: "selected", stream: { available: true, sourceId: 1,
    selectedKind: "low-latency", tracks: [{ kind: "main" }], hls: { partTarget: 1 }, rawPlayer: { url: REMOTE_MEDIA_URL } } });
  await Promise.resolve();
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  const status = (await app.send("get-status")).status;
  assert.equal(status.stream.hls.partTarget, 1);
  assert.equal(status.stream.rawPlayer, undefined);
  assert.equal((await app.send("switch-llhls")).ok, false);
  assert.equal((await app.send("start-measurement")).ok, false);
});

test("existing LL-HLS and LL-HLS P2P keep their track without another switch", async () => {
  for (const selectedKind of ["low-latency", "low-latency-p2p"]) {
    const app = await harness({}, {});
    app.setStream({ selectedKind, tracks: [{ kind: "main" }, { kind: "low-latency" }] });
    app.advance(2000);
    assert.equal(app.postedMessages.some(message => message.action === "switch"), false);
    assert.equal(app.video.playbackRate, 1.5);
  }
});

test("failed LL-HLS switching backs off then retries and a new source clears the backoff", async () => {
  const app = await harness();
  app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  app.advance(250);
  app.respondSwitch({ ok: false, reason: "switch-failed", restored: true });
  await Promise.resolve();
  app.advance(59000);
  assert.equal(app.postedMessages.filter(message => message.action === "switch").length, 1);
  app.advance(1000);
  assert.equal(app.postedMessages.filter(message => message.action === "switch").length, 2);
  app.respondSwitch({ ok: false, reason: "switch-failed", restored: true });
  await Promise.resolve();
  app.setStream({ sourceId: 2 });
  app.advance(1250);
  assert.equal(app.postedMessages.filter(message => message.action === "switch").length, 3);
});

test("paused playback and visible advertisements cannot automatically switch tracks", async () => {
  const paused = await harness({ paused: true });
  paused.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  paused.advance(2000);
  assert.equal(paused.postedMessages.some(message => message.action === "switch"), false);
  const ad = await harness();
  ad.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  ad.video.player.markers.push(new Element());
  ad.advance(2000);
  assert.equal(ad.postedMessages.some(message => message.action === "switch"), false);
});

test("runtime catch-up performs one exact seek and confirms only after seeked", async () => {
  const app = await harness();
  const initial = await app.send("get-status");
  assert.equal(initial.status.margin, 0.6);
  assert.equal(initial.status.edgeDistance, 10);
  assert.equal(initial.status.videoFound, true);

  const requested = await app.send("catch-up");
  assert.equal(requested.ok, true);
  assert.deepEqual(app.video.seekWrites, [99.4]);
  assert.equal(requested.status.seeking, true);
  assert.equal(requested.status.lastResult.completed, false);
  assert.equal(app.video.playCalls, 0);
  assert.deepEqual(app.video.rateWrites, []);

  const duplicate = await app.send("catch-up");
  assert.equal(duplicate.ok, false);
  assert.equal(app.video.seekWrites.length, 1);
  app.video.emit("seeked");
  const completed = await app.send("get-status");
  assert.equal(completed.status.seeking, false);
  assert.equal(completed.status.lastResult.completed, true);
});

test("paused media, visible ad markers, and an already reached target block seek", async () => {
  const paused = await harness({ paused: true });
  assert.equal((await paused.send("catch-up")).ok, false);
  assert.deepEqual(paused.video.seekWrites, []);
  assert.equal(paused.video.playCalls, 0);

  const advertised = await harness();
  advertised.video.player.markers = [new Element()];
  assert.equal((await advertised.send("get-status")).status.adState, "detected");
  assert.equal((await advertised.send("catch-up")).ok, false);
  assert.deepEqual(advertised.video.seekWrites, []);

  const ahead = await harness({ currentTime: 99.8 });
  assert.equal((await ahead.send("catch-up")).ok, false);
  assert.equal(ahead.video.currentTime, 99.8);
  assert.deepEqual(ahead.video.seekWrites, []);
});

test("a five-second seek timeout remains unconfirmed", async () => {
  const app = await harness();
  await app.send("catch-up");
  app.advance(4999);
  assert.equal((await app.send("get-status")).status.seeking, true);
  app.advance(1);
  const state = (await app.send("get-status")).status;
  assert.equal(state.seeking, false);
  assert.equal(state.lastResult.completed, false);
  assert.equal((await app.send("get-log")).log.samples.some((sample) => sample.type === "catch-up-timeout"), true);
});

test("seeked at a different position cannot confirm the requested target", async () => {
  const app = await harness();
  await app.send("catch-up");
  app.video.currentTime = 97.4;
  app.video.emit("seeked");
  const state = (await app.send("get-status")).status;
  assert.equal(state.seeking, false);
  assert.equal(state.lastResult.completed, false);
  assert.equal(state.lastResult.actualCurrentTime, 97.4);
  assert.equal(state.lastResult.targetDistance, -2);
  const sample = (await app.send("get-log")).log.samples.find((entry) => entry.type === "catch-up-seeked");
  assert.equal(sample.actualCurrentTime, 97.4);
  assert.equal(sample.targetDistance, -2);
});

test("no persistent catch-up overlay is added to the page or native fullscreen video", async () => {
  const app = await harness();
  assert.deepEqual(app.document.body.children, []);
  assert.equal(app.labelVideo(), app.video);
  app.document.fullscreenElement = app.video;
  await app.send("get-status");
  assert.deepEqual(app.video.children, []);
  assert.deepEqual(app.document.body.children, []);
  assert.ok(app.labelCalls.updates > 0);
});

test("SPA navigation away from a live channel prevents seeking", async () => {
  const app = await harness();
  app.location.pathname = "/video/replay-id";
  const result = await app.send("catch-up");
  assert.equal(result.ok, false);
  assert.equal(result.status.isLive, false);
  assert.equal(result.status.videoFound, false);
  assert.deepEqual(app.video.seekWrites, []);
});

test("source changes and player replacement cancel pending confirmation", async () => {
  const emptied = await harness();
  await emptied.send("catch-up");
  emptied.video.emit("emptied");
  emptied.video.emit("seeked");
  const cancelled = (await emptied.send("get-status")).status;
  assert.equal(cancelled.seeking, false);
  assert.equal(cancelled.lastResult.completed, false);
  assert.equal((await emptied.send("get-log")).log.samples.some((sample) => sample.type === "catch-up-source-changed"), true);

  const replaced = await harness();
  await replaced.send("catch-up");
  const nextVideo = makeVideo();
  replaced.document.videos = [nextVideo];
  const replacedState = (await replaced.send("get-status")).status;
  assert.equal(replacedState.lastResult.completed, false);
  assert.equal(replacedState.currentTime, 90);
  assert.equal(replacedState.seeking, false);
  replaced.video.emit("seeked");
  assert.equal((await replaced.send("get-status")).status.lastResult.completed, false);
  assert.deepEqual(nextVideo.seekWrites, []);
});

test("diagnostic export caps samples and excludes remote media URLs and queries", async () => {
  const app = await harness();
  app.advance(1205 * 1000);
  const result = await app.send("get-log");
  assert.equal(result.log.samples.length, 1200);
  assert.equal(result.log.samples.every((sample) => sample.type === "sample"), true);
  assert.equal(result.log.path, "/live/channel-id");
  const serialized = JSON.stringify(result.log);
  assert.equal(serialized.includes(REMOTE_MEDIA_URL), false);
  assert.equal(serialized.includes("private-token"), false);
  assert.equal(serialized.includes("https://"), false);
  await app.send("clear-log");
  assert.equal((await app.send("get-log")).log.samples.length, 0);
});

test("automatic catch-up defaults on and changes speed without seeking", async () => {
  const app = await harness({}, {});
  assert.equal((await app.send("get-status")).status.autoEnabled, true);
  app.advance(250);
  const state = (await app.send("get-status")).status;
  assert.equal(state.autoStart, 3);
  assert.equal(state.autoRate, 1.5);
  assert.equal(state.autoActive, true);
  assert.equal(app.video.playbackRate, 1.5);
  assert.deepEqual(app.video.rateWrites, [1.5]);
  assert.deepEqual(app.video.seekWrites, []);
  assert.equal(app.video.playCalls, 0);
});

test("automatic catch-up starts at the configured buffer threshold and restores normal speed at the goal", async () => {
  const app = await harness({ currentTime: 97.1 }, { autoEnabled: true });
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  app.video.seekable = ranges([[0, 100.2]]);
  app.video.buffered = ranges([[88, 100.2]]);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  assert.equal((await app.send("get-status")).status.autoActive, true);
  app.video.elapse(2.6);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.deepEqual(app.video.seekWrites, []);
});

test("automatic catch-up does not start on paused, unready, low-buffer, ad, or custom-rate playback", async () => {
  for (const overrides of [
    { paused: true }, { readyState: 2 }, { buffered: ranges([[88, 90.65]]) },
    { playbackRate: 1.2 },
  ]) {
    const app = await harness(overrides, { autoEnabled: true });
    app.advance(1_000);
    assert.equal((await app.send("get-status")).status.autoActive, false);
    assert.deepEqual(app.video.rateWrites, []);
    assert.deepEqual(app.video.seekWrites, []);
  }
  const ad = await harness({}, { autoEnabled: true });
  ad.video.player.markers = [new Element()];
  ad.advance(250);
  assert.equal((await ad.send("get-status")).status.autoActive, false);
  assert.deepEqual(ad.video.rateWrites, []);
});

test("an external playback-rate change is preserved during and after automatic catch-up", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  app.video.playbackRate = 1.2;
  app.video.emit("ratechange");
  app.advance(250);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  assert.equal(app.video.playbackRate, 1.2);
  assert.deepEqual(app.video.rateWrites, [1.5, 1.2]);
  app.window.emit("unload");
  assert.equal(app.video.playbackRate, 1.2);
  assert.deepEqual(app.video.rateWrites, [1.5, 1.2]);
});

test("owned automatic speed is restored on waiting, pauses, seeks, source changes, and unload", async () => {
  for (const event of ["waiting", "pause", "seeking", "emptied", "loadedmetadata", "error", "ended"]) {
    const app = await harness({}, { autoEnabled: true });
    app.advance(250);
    assert.equal(app.video.playbackRate, 1.5, `started before ${event}`);
    if (event === "pause") app.video.paused = true;
    if (event === "seeking") app.video.seeking = true;
    if (event === "ended") app.video.ended = true;
    app.video.emit(event);
    assert.equal(app.video.playbackRate, 1, `restored after ${event}`);
    assert.equal((await app.send("get-status")).status.autoActive, false);
    assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  }
  const unloaded = await harness({}, { autoEnabled: true });
  unloaded.advance(250);
  unloaded.window.emit("unload");
  assert.equal(unloaded.video.playbackRate, 1);
  assert.equal(unloaded.labelCalls.destroys, 1);
  const writes = unloaded.video.rateWrites.slice();
  unloaded.advance(30_000);
  assert.deepEqual(unloaded.video.rateWrites, writes);
});

test("BFCache pagehide restores speed and suspends automatic catch-up until pageshow", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  app.window.emit("pagehide", { persisted: true });
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  app.advance(30_000);
  assert.equal(app.video.playbackRate, 1);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.equal(app.labelCalls.destroys, 0);
  app.window.emit("pageshow", { persisted: true });
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  assert.equal((await app.send("get-status")).status.autoActive, true);
  assert.deepEqual(app.video.rateWrites, [1.5, 1, 1.5]);
  assert.deepEqual(app.video.seekWrites, []);
});

test("a reused media element with a reset timeline is not mistaken for a user rewind", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.video.emit("waiting");
  app.video.emit("emptied");
  app.video.currentTime = 10;
  app.video.seekable = ranges([[0, 20]]);
  app.video.buffered = ranges([[8, 20]]);
  app.video.emit("loadedmetadata");
  app.video.seeking = true;
  app.video.emit("seeking");
  app.video.seeking = false;
  app.video.emit("seeked");
  app.video.emit("playing");
  app.advance(30_000);
  assert.equal(app.video.playbackRate, 1.5);
  assert.equal((await app.send("get-status")).status.autoActive, true);
  assert.deepEqual(app.video.rateWrites, [1.5, 1, 1.5]);
  assert.deepEqual(app.video.seekWrites, [10]);
});

test("a real user rewind stays protected when the same element loads another source", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.video.currentTime = 80;
  app.video.seeking = true;
  app.video.emit("seeking");
  app.video.seeking = false;
  app.video.emit("seeked");
  app.video.emit("emptied");
  app.video.currentTime = 10;
  app.video.seekable = ranges([[0, 20]]);
  app.video.buffered = ranges([[8, 20]]);
  app.video.emit("loadedmetadata");
  app.video.emit("playing");
  app.advance(30_000);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
});

test("buffer exhaustion restores normal speed before playback has to stall", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.video.buffered = ranges([[88, 90.6]]);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.deepEqual(app.video.seekWrites, []);
});

test("lack of progress stops automatic speed and a cooldown prevents immediate restarting", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.advance(3_750);
  assert.equal(app.video.playbackRate, 1.5);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  const stopped = (await app.send("get-status")).status;
  assert.equal(stopped.autoActive, false);
  assert.equal(stopped.lastAutoStop.reason, "no-progress");
  assert.equal(stopped.lastAutoStop.durationSeconds, 4);
  app.advance(14_750);
  assert.equal(app.video.playbackRate, 1);
  assert.match((await app.send("get-status")).status.autoReason, /4초 동안 재생 위치/);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  assert.deepEqual(app.video.rateWrites, [1.5, 1, 1.5]);
});

test("steady buffer replenishment while playback advances does not end automatic speed after four seconds", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  for (let index = 0; index < 8; index++) {
    app.video.elapse(1.5);
    app.video.buffered = ranges([[88, app.video.currentTime + 10]]);
    app.video.seekable = ranges([[0, app.video.currentTime + 10]]);
    app.advance(1000);
    assert.equal(app.video.playbackRate, 1.5, `second ${index + 1}`);
  }
  assert.equal((await app.send("get-log")).log.samples.some(
    sample => sample.type === "auto-stopped" && sample.reason === "no-progress"), false);
});

test("a network stalled event does not stop healthy buffered playback or latch a waiting state", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.video.emit("stalled");
  assert.equal(app.video.playbackRate, 1.5);
  app.video.elapse(0.4);
  app.advance(250);
  assert.equal(app.indicatorState().active, true);
  // The network event happened before activation as well: no playing event
  // needs to fire again if decoded playback was never interrupted.
  const before = await harness({}, { autoEnabled: true });
  before.video.emit("stalled");
  before.advance(250);
  assert.equal(before.video.playbackRate, 1.5);
});

test("a network stall still stops automatic speed when playback data is actually insufficient", async () => {
  for (const shortage of ["readiness", "buffer"]) {
    const app = await harness({}, { autoEnabled: true });
    app.advance(250);
    if (shortage === "readiness") app.video.readyState = 2;
    else app.video.buffered = ranges([[88, app.video.currentTime + 0.5]]);
    app.video.emit("stalled");
    app.advance(250);
    assert.equal(app.video.playbackRate, 1);
    const stopped = (await app.send("get-status")).status;
    assert.equal(stopped.lastAutoStop.reason, shortage === "readiness" ? "not-ready" : "target-reached");
    app.video.readyState = 4;
    app.video.buffered = ranges([[88, app.video.currentTime + 10]]);
    // No synthetic playing event: restoring ready data is sufficient after
    // cooldown, because stalled never meant decoded playback had stopped.
    app.advance(15000);
    assert.equal(app.video.playbackRate, 1.5);
  }
});

test("shrinking buffer while decoded playback is frozen does not count as playback progress", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  for (let index = 0; index < 4; index++) {
    app.video.buffered = ranges([[88, 99 - index]]);
    app.advance(1000);
  }
  assert.equal(app.video.currentTime, 90);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.lastAutoStop.reason, "no-progress");
});

test("PC clock corrections do not shorten the automatic session or its restart cooldown", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.setWallOffset(-2950);
  app.video.elapse(0.4);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  app.setWallOffset(60000);
  app.video.elapse(0.4);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  app.video.buffered = ranges([[88, app.video.currentTime + 0.5]]);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  app.setWallOffset(120000);
  app.video.buffered = ranges([[88, app.video.currentTime + 10]]);
  app.advance(14750);
  assert.equal(app.video.playbackRate, 1);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
});

test("measurable playback advancement refreshes the no-progress deadline", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.advance(3_500);
  app.video.elapse(0.4);
  app.advance(250);
  app.advance(3_750);
  assert.equal(app.video.playbackRate, 1.5);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
});

test("healthy automatic playback stays uninterrupted past 60 seconds and still stops at the buffer goal", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  for (let index = 0; index < 60; index += 1) {
    app.video.elapse(1.5);
    app.video.buffered = ranges([[88, app.video.currentTime + 10]]);
    app.video.seekable = ranges([[0, app.video.currentTime + 10]]);
    app.advance(1000);
    assert.equal(app.video.playbackRate, 1.5, `second ${index + 1}`);
  }
  assert.equal((await app.send("get-status")).status.autoActive, true);
  assert.deepEqual(app.video.rateWrites, [1.5]);
  assert.equal((await app.send("get-log")).log.samples.some(sample => sample.type === "auto-stopped"), false);
  app.video.buffered = ranges([[88, app.video.currentTime + 0.5]]);
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
  const stopped = (await app.send("get-status")).status;
  assert.equal(stopped.autoActive, false);
  assert.equal(stopped.lastAutoStop.reason, "target-reached");
  assert.equal(stopped.lastAutoStop.durationSeconds, 60.25);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.deepEqual(app.video.seekWrites, []);
});

test("manual immediate catch-up stops owned speed before seeking", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  const result = await app.send("catch-up");
  assert.equal(result.ok, true);
  assert.equal(app.video.playbackRate, 1);
  assert.equal(result.status.autoActive, false);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.deepEqual(app.video.seekWrites, [99.4]);
  app.video.emit("seeked");
  app.advance(250);
  assert.equal(app.video.playbackRate, 1);
});

test("user rewind remains in DVR mode and automatic speed does not undo it after a cooldown", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.video.currentTime = 80;
  app.video.seeking = true;
  app.video.emit("seeking");
  assert.equal(app.video.playbackRate, 1);
  app.video.seeking = false;
  app.video.emit("seeked");
  app.advance(30_000);
  assert.equal(app.video.playbackRate, 1);
  assert.equal((await app.send("get-status")).status.autoActive, false);
  assert.deepEqual(app.video.rateWrites, [1.5, 1]);
  assert.deepEqual(app.video.seekWrites, [80]);
  app.video.buffered = ranges([[78, 100]]);
  await app.send("catch-up");
  app.video.emit("seeked");
  app.video.seekable = ranges([[0, 104]]);
  app.video.buffered = ranges([[80, 104]]);
  app.advance(15_250);
  assert.equal(app.video.playbackRate, 1.5);
});

test("SPA channel changes and replacement players release previous speed ownership and DVR state", async () => {
  const changed = await harness({}, { autoEnabled: true });
  changed.advance(250);
  changed.location.pathname = "/video/replay-id";
  changed.advance(250);
  assert.equal(changed.video.playbackRate, 1);
  assert.equal((await changed.send("get-status")).status.autoActive, false);

  const replaced = await harness({}, { autoEnabled: true });
  replaced.advance(250);
  const next = makeVideo();
  replaced.document.videos = [next];
  await replaced.send("get-status");
  assert.equal(replaced.video.playbackRate, 1);
  assert.equal(next.playbackRate, 1);
  replaced.advance(250);
  assert.equal(next.playbackRate, 1.5);

  const rewound = await harness({}, { autoEnabled: true });
  rewound.advance(250);
  rewound.video.currentTime = 80;
  rewound.video.seeking = true;
  rewound.video.emit("seeking");
  rewound.video.seeking = false;
  rewound.video.emit("seeked");
  rewound.document.videos = [makeVideo()];
  await rewound.send("get-status");
  rewound.advance(250);
  assert.equal(rewound.document.videos[0].playbackRate, 1.5);

  const channel = await harness({}, { autoEnabled: true });
  channel.advance(250);
  channel.video.currentTime = 80;
  channel.video.seeking = true;
  channel.video.emit("seeking");
  channel.video.seeking = false;
  channel.video.emit("seeked");
  channel.video.buffered = ranges([[78, 100]]);
  channel.location.pathname = "/live/other-channel";
  channel.advance(250);
  assert.equal(channel.video.playbackRate, 1.5);
});

test("synced setting changes release owned speed and adopt the new margin-safe start threshold", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  app.changeStorage({ autoEnabled: false, margin: 3, autoStart: 2, autoRate: 1.2 });
  const state = (await app.send("get-status")).status;
  assert.equal(state.autoEnabled, false);
  assert.equal(state.autoStart, 3.5);
  assert.equal(state.autoRate, 1.2);
  assert.equal(state.margin, 3);
  assert.equal(state.autoActive, false);
  assert.equal(app.video.playbackRate, 1);
});

test("the native-control label receives only fresh player latency and never substitutes edge distance", async () => {
  const app = await harness();
  assert.equal(app.labelLatency(), null);
  const request = app.postedMessages.at(-1);
  app.window.emit("message", {
    source: app.window, origin: app.location.origin,
    data: { namespace: "chzzk-catchup-latency-response", token: request.token,
      requestId: request.requestId, latency: 2.25 },
  });
  assert.equal(app.labelLatency(), 2.25);
  assert.equal((await app.send("get-status")).status.playerLatency, 2.25);
  app.advance(2_501);
  assert.equal(app.labelLatency(), null);
  assert.equal((await app.send("get-status")).status.playerLatency, null);
  assert.equal((await app.send("get-status")).status.edgeDistance, 10);
});

test("label and popup use the recent average while diagnostic samples preserve the raw measurement", async () => {
  const app = await harness();
  app.respondLatency(2);
  app.advance(1000);
  app.respondLatency(4);
  assert.equal(app.labelLatency(), 3);
  let state = (await app.send("get-status")).status;
  assert.equal(state.playerLatency, 3);
  assert.equal(state.playerLatencyRaw, 4);
  assert.equal(state.latencySampleCount, 2);
  assert.equal(state.latencyWindowSeconds, 5);
  app.advance(1000);
  const log = (await app.send("get-log")).log;
  assert.equal(log.samples.at(-1).playerLatency, 3);
  assert.equal(log.samples.at(-1).playerLatencyRaw, 4);
  app.respondLatency(null);
  state = (await app.send("get-status")).status;
  assert.equal(state.playerLatency, null);
  assert.equal(state.playerLatencyRaw, null);
  assert.equal(state.latencySampleCount, 0);
});

test("seek, waiting, source changes and channel changes discard the previous latency average", async () => {
  for (const event of ["seeking", "seeked", "waiting", "playing", "pause", "ratechange", "emptied", "loadedmetadata"]) {
    const app = await harness();
    app.respondLatency(6);
    app.video.emit(event);
    assert.equal(app.labelLatency(), null, event);
    // Ignore responses requested before the reset; accept only a new request.
    app.respondLatency(6);
    assert.equal(app.labelLatency(), null, event);
    app.advance(1000);
    app.respondLatency(2);
    assert.equal(app.labelLatency(), 2, event);
  }
  const channel = await harness();
  channel.respondLatency(6);
  channel.location.pathname = "/live/other-channel";
  await channel.send("get-status");
  assert.equal(channel.labelLatency(), null);
  const replacement = await harness();
  replacement.respondLatency(6);
  replacement.document.videos = [makeVideo()];
  await replacement.send("get-status");
  assert.equal(replacement.labelLatency(), null);
});

test("PC time correction resets the average without making old samples appear fresh", async () => {
  const app = await harness();
  app.respondLatency(2);
  app.advance(1000);
  app.setWallOffset(2950);
  app.respondLatency(5);
  assert.equal(app.labelLatency(), 5);
  assert.equal((await app.send("get-status")).status.latencySampleCount, 1);
  app.setWallOffset(-60000);
  app.advance(2501);
  assert.equal(app.labelLatency(), null);
  assert.equal((await app.send("get-status")).status.playerLatencyRaw, null);
});

test("rate indicator follows only the automatic session and is cleaned up on page lifecycle", async () => {
  const app = await harness({}, { autoEnabled: true });
  assert.equal(app.indicatorState().active, false);
  app.respondLatency(4);
  app.advance(250);
  assert.equal(app.indicatorState().active, true);
  assert.equal(app.indicatorState().rate, 1.5);
  assert.equal(app.labelLatency(), null);
  app.advance(750);
  app.respondLatency(3);
  assert.equal(app.labelLatency(), 3);
  app.video.playbackRate = 1.2;
  app.video.emit("ratechange");
  assert.equal(app.indicatorState().active, false);
  assert.equal(app.labelLatency(), null);
  app.window.emit("pagehide");
  assert.equal(app.indicatorVideo(), null);
  app.window.emit("unload");
  assert.equal(app.indicatorCalls.destroys, 1);
  assert.equal(app.labelCalls.destroys, 1);
});

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function progress(app, seconds = 1.5) {
  for (let i = 0; i < seconds * 4; i++) {
    app.video.elapse(0.25);
    app.advance(250);
    await flush();
  }
}

test("entry catch-up uses the saved 0.2-second margin once, independently of automatic speed", async () => {
  const app = await harness({}, { startupEnabled: true, margin: 0.2, autoEnabled: false });
  app.advance(250);
  assert.deepEqual(app.video.seekWrites, []);
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [99.8]);
  assert.equal(app.video.playCalls, 0);
  assert.equal(app.video.playbackRate, 1);
  app.video.emit("seeked");
  app.video.buffered = ranges([[88, 120]]);
  await progress(app, 5);
  assert.deepEqual(app.video.seekWrites, [99.8]);
  const requests = (await app.send("get-log")).log.samples.filter(s => s.type === "catch-up-request");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].trigger, "startup");
  assert.equal((await app.send("get-status")).status.startupPending, false);
});

test("entry catch-up defaults on when no preference exists and can be disabled", async () => {
  const defaults = await harness({}, { startupEnabled: undefined, autoEnabled: false });
  await progress(defaults);
  assert.deepEqual(defaults.video.seekWrites, [99.4]);
  const disabled = await harness({}, { startupEnabled: false, autoEnabled: false });
  await progress(disabled);
  assert.deepEqual(disabled.video.seekWrites, []);
});

test("entry catch-up waits for LL-HLS switching and its new playback, without owning native speed", async () => {
  const app = await harness({}, { startupEnabled: true, margin: 0.2 });
  app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  app.advance(250);
  await progress(app, 2);
  assert.deepEqual(app.video.seekWrites, []);
  assert.equal((await app.send("catch-up")).ok, false);
  app.video.elapse(-20);
  app.video.emit("seeking");
  app.video.emit("seeked");
  app.respondSwitch({ ok: true, stream: { available: true, sourceId: 2,
    selectedKind: "low-latency", tracks: [{ kind: "main" }], busy: false } });
  await flush();
  app.video.buffered = ranges([[68, 100]]);
  app.video.playbackRate = 1.1;
  app.video.rateWrites.length = 0;
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [99.8]);
  assert.deepEqual(app.video.rateWrites, []);
});

test("entry catch-up resumes on the original stream after a failed LL-HLS attempt", async () => {
  const app = await harness({}, { startupEnabled: true });
  app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  app.advance(250);
  app.respondSwitch({ ok: false, reason: "switch-failed", restored: true });
  await flush();
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [99.4]);
});

test("entry catch-up waits through pause, ads, unready and missing-buffer states", async () => {
  for (const reason of ["paused", "ad", "unready", "buffer"]) {
    const app = await harness({}, { startupEnabled: true, autoEnabled: false });
    if (reason === "paused") app.video.paused = true;
    if (reason === "ad") app.video.player.markers = [new Element()];
    if (reason === "unready") app.video.readyState = 2;
    if (reason === "buffer") app.video.buffered = ranges([]);
    await progress(app, 2);
    assert.deepEqual(app.video.seekWrites, [], reason);
    assert.equal(app.video.playCalls, 0);
    app.video.paused = false;
    app.video.readyState = 4;
    app.video.player.markers = [];
    app.video.buffered = ranges([[88, 100]]);
    app.video.emit("playing");
    await progress(app);
    assert.deepEqual(app.video.seekWrites, [99.4], reason);
  }
});

test("a manual position change or immediate catch-up consumes the pending entry seek", async () => {
  for (const action of ["rewind", "forward", "catch-up"]) {
    const app = await harness({}, { startupEnabled: true, autoEnabled: false });
    app.advance(250);
    if (action === "catch-up") await app.send("catch-up");
    else {
      app.video.currentTime = action === "rewind" ? 89 : 94;
      app.video.emit("seeking");
    }
    app.video.emit("seeked");
    await progress(app, 3);
    assert.equal(app.video.seekWrites.length, 1, action);
    assert.equal((await app.send("get-status")).status.startupPending, false);
  }
});

test("entry catch-up does not jump gaps or seek backwards when already close", async () => {
  const app = await harness({ buffered: ranges([[88, 94], [96, 120]]) },
    { startupEnabled: true, autoEnabled: false, margin: 0.2 });
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [93.8]);
  const close = await harness({}, { startupEnabled: true, autoEnabled: false, margin: 0.6 });
  for (let i = 0; i < 8; i++) {
    close.video.elapse(0.25);
    close.video.buffered = ranges([[88, close.video.currentTime + 0.4]]);
    close.advance(250);
    await flush();
  }
  assert.deepEqual(close.video.seekWrites, []);
  assert.equal((await close.send("get-status")).status.startupPending, false);
  close.video.buffered = ranges([[88, 120]]);
  await progress(close, 2);
  assert.deepEqual(close.video.seekWrites, []);
});

test("entry seek re-arms for a new channel but not source reload, replacement or BFCache", async () => {
  const app = await harness({}, { startupEnabled: true, autoEnabled: false });
  await progress(app);
  app.video.emit("seeked");
  app.video.buffered = ranges([[88, 120]]);
  app.video.emit("loadedmetadata");
  await progress(app);
  app.window.emit("pagehide");
  app.window.emit("pageshow");
  await progress(app);
  assert.equal(app.video.seekWrites.length, 1);
  const replacement = makeVideo();
  app.document.videos = [replacement];
  await app.send("get-status");
  for (let i = 0; i < 8; i++) {
    replacement.elapse(0.25);
    app.advance(250);
    await flush();
  }
  assert.deepEqual(replacement.seekWrites, []);
  app.location.pathname = "/live/next-channel";
  for (let i = 0; i < 8; i++) {
    replacement.elapse(0.25);
    app.advance(250);
    await flush();
  }
  assert.deepEqual(replacement.seekWrites, [99.4]);
});

test("channel changes release pending stream requests and ignore stale responses", async () => {
  const app = await harness();
  app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
  app.advance(250);
  const oldRequest = app.postedMessages.findLast(m => m.action === "switch");
  app.location.pathname = "/live/next-channel";
  app.advance(250);
  await flush();
  const newRequest = app.postedMessages.findLast(m => m.action === "switch");
  assert.notEqual(oldRequest.requestId, newRequest.requestId);
  assert.equal((await app.send("get-status")).status.streamChanging, true);
  app.respondStream(oldRequest, { ok: true, stream: { selectedKind: "low-latency", sourceId: 99 } });
  await flush();
  assert.equal((await app.send("get-status")).status.streamChanging, true);
  app.respondStream(newRequest, { ok: true, stream: { selectedKind: "low-latency", sourceId: 2 } });
  await flush();
  const state = (await app.send("get-status")).status;
  assert.equal(state.streamChanging, false);
  assert.equal(state.stream.sourceId, 2);
});

test("native initial positioning before playback does not cancel the entry seek", async () => {
  const app = await harness({ currentTime: 0, readyState: 1, buffered: ranges([]) },
    { startupEnabled: true, autoEnabled: false });
  app.video.emit("loadedmetadata");
  app.video.currentTime = 90;
  app.video.emit("seeking");
  app.video.emit("seeked");
  app.video.readyState = 4;
  app.video.buffered = ranges([[88, 100]]);
  app.video.emit("playing");
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [90, 99.4]);
});

test("settings changes from the popup update an open player and stop owned speed", async () => {
  const app = await harness({}, { autoEnabled: true });
  app.advance(250);
  assert.equal(app.video.playbackRate, 1.5);
  app.changeStorage({ autoEnabled: false, autoStart: 4, autoRate: 1.2, margin: 0.2 });
  const state = (await app.send("get-status")).status;
  assert.equal(state.autoActive, false);
  assert.equal(state.autoEnabled, false);
  assert.equal(state.autoStart, 4);
  assert.equal(state.autoRate, 1.2);
  assert.equal(state.autoStopBuffer, 0.6);
  assert.equal(app.video.playbackRate, 1);
  await app.send("catch-up");
  assert.deepEqual(app.video.seekWrites, [99.8]);
});

test("stored entry preference takes effect in the current pending visit", async () => {
  const app = await harness();
  app.changeStorage({ margin: 0.2, startupEnabled: true });
  await progress(app);
  assert.deepEqual(app.video.seekWrites, [99.8]);
  app.video.emit("seeked");
  app.changeStorage({ startupEnabled: false });
  app.changeStorage({ startupEnabled: true });
  app.video.buffered = ranges([[88, 120]]);
  await progress(app);
  assert.equal(app.video.seekWrites.length, 1);
});

test("LL-HLS and P2P use the configured buffer threshold, rate and stop floor", async () => {
  for (const selectedKind of ["low-latency", "low-latency-p2p"]) {
    const app = await harness({ buffered: ranges([[88, 92.9]]) },
      { autoEnabled: true, autoRate: 1.2, autoStart: 3, margin: 0.2 });
    app.setStream({ selectedKind });
    app.advance(250);
    assert.equal(app.video.playbackRate, 1);
    assert.match(app.labelConnection(), /LL-HLS/);
    app.video.buffered = ranges([[88, 93]]);
    app.advance(250);
    assert.equal(app.video.playbackRate, 1.2);
    app.video.buffered = ranges([[88, 90.59]]);
    app.advance(250);
    assert.equal(app.video.playbackRate, 1);
    assert.equal((await app.send("get-status")).status.lastAutoStop.reason, "low-buffer");
  }
});

test("HLS preference switches away from LL-HLS and is retained on the next channel", async () => {
  const app = await harness({}, { streamMode: "hls", autoEnabled: false });
  const tracks = [{ kind: "main" }, { kind: "low-latency" }];
  app.setStream({ selectedKind: "low-latency", tracks });
  app.advance(250);
  assert.equal(app.postedMessages.findLast(m => m.action === "switch").kind, "main");
  app.respondSwitch({ ok: true, stream: { available: true, sourceId: 1, selectedKind: "main", tracks } });
  await flush();
  await progress(app, 2);
  assert.equal(app.postedMessages.filter(m => m.action === "switch").length, 1);
  assert.equal(app.labelConnection(), "HLS");
  app.location.pathname = "/live/other";
  app.setStream({ selectedKind: "low-latency", sourceId: 2 });
  app.advance(250);
  assert.equal(app.postedMessages.findLast(m => m.action === "switch").kind, "main");
});

test("unavailable selected transport keeps playback and preference without repeated switch requests", async () => {
  const app = await harness({}, { streamMode: "hls" });
  app.setStream({ selectedKind: "low-latency", tracks: [{ kind: "low-latency" }] });
  await progress(app, 3);
  assert.equal(app.postedMessages.some(m => m.action === "switch"), false);
  const state = (await app.send("get-status")).status;
  assert.equal(state.streamMode, "hls");
  assert.equal(state.connectionLabel, "LL-HLS");
});

test("a preference change during switching applies the latest choice after completion", async () => {
  const app = await harness();
  const tracks = [{ kind: "main" }, { kind: "low-latency" }];
  app.setStream({ tracks });
  app.advance(250);
  app.changeStorage({ streamMode: "hls" });
  app.respondSwitch({ ok: true, stream: { available: true, sourceId: 1, selectedKind: "low-latency", tracks } });
  await flush();
  app.advance(250);
  const requests = app.postedMessages.filter(m => m.action === "switch");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].kind, "main");
});

async function buffering(app, duration = 300) {
  app.video.emit("waiting");
  app.advance(duration);
  await flush();
  app.video.emit("playing");
}

test("repeated buffering raises only this broadcast's effective margin and automatic start threshold", async () => {
  const app = await harness({}, { bufferGuardEnabled: true, bufferGuardStep: 1,
    bufferGuardMax: 3, autoEnabled: false, autoStart: 2 });
  app.advance(1250);
  await buffering(app);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.6);
  await buffering(app);
  let state = (await app.send("get-status")).status;
  assert.equal(state.margin, 0.6);
  assert.equal(state.effectiveMargin, 1.6);
  assert.equal(state.effectiveAutoStart, 2.1);
  assert.equal(app.storage.margin, 0.6);
  await app.send("catch-up");
  assert.deepEqual(app.video.seekWrites, [98.4]);
  app.video.emit("seeked");
  const log = (await app.send("get-log")).log;
  assert.equal(log.samples.filter(s => s.type === "buffer-increased").length, 1);
  app.location.pathname = "/live/new-broadcast";
  state = (await app.send("get-status")).status;
  assert.equal(state.effectiveMargin, 0.6);
});

test("buffer protection ignores network stalled events, short interruptions and duplicate waiting", async () => {
  const app = await harness({}, { bufferGuardEnabled: true, autoEnabled: false });
  app.advance(1250);
  app.video.emit("stalled"); app.advance(500); app.video.emit("stalled");
  await buffering(app, 100); await buffering(app, 100);
  app.video.emit("waiting"); app.advance(300);
  app.video.emit("waiting"); app.advance(1000);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.6);
  app.video.emit("playing");
  await buffering(app);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.8);
});

test("pause, seek, advertisements, switching and page suspension cannot increase the buffer", async () => {
  for (const reason of ["pause", "seek", "ad", "switch", "pagehide"]) {
    const app = await harness({}, { bufferGuardEnabled: true, autoEnabled: false });
    app.advance(1250);
    if (reason === "pause") { app.video.paused = true; app.video.emit("pause"); }
    if (reason === "seek") { app.video.seeking = true; app.video.emit("seeking"); }
    if (reason === "ad") app.video.player.markers = [new Element()];
    if (reason === "switch") {
      app.setStream({ tracks: [{ kind: "main" }, { kind: "low-latency" }] });
      app.advance(1000); await flush(); app.advance(250);
    }
    if (reason === "pagehide") app.window.emit("pagehide");
    await buffering(app); await buffering(app);
    assert.equal((await app.send("get-status")).status.effectiveMargin, 0.6, reason);
  }
});

test("buffer adjustment can be reset or disabled and uses the configured cap", async () => {
  const app = await harness({}, { bufferGuardEnabled: true, bufferGuardMax: 0.9, autoEnabled: false });
  app.advance(1250);
  for (let i = 0; i < 8; i++) await buffering(app);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.9);
  assert.equal((await app.send("reset-buffer")).status.effectiveMargin, 0.6);
  app.advance(1250);
  await buffering(app); await buffering(app);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.8);
  app.changeStorage({ bufferGuardEnabled: false });
  app.advance(1250);
  await buffering(app); await buffering(app);
  assert.equal((await app.send("get-status")).status.effectiveMargin, 0.6);
});
