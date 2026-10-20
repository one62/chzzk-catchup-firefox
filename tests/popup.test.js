"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");

class Element {
  constructor(value = "") {
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.classList = { toggle() {}, remove() {} };
  }
  setAttribute(name, value) { this[name] = value; }
  get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  emit(event) { this.listeners.get(event)?.({ preventDefault() {} }); }
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function harness(overrides = {}, options = {}) {
  const elements = new Map();
  const status = {
    isLive: true, videoFound: true, paused: false, seeking: false, adState: "unknown",
    playerLatency: 2, edgeDistance: 1.2, forwardBuffer: 1.2, margin: 0.6,
    autoEnabled: true, autoStart: 3, autoRate: 1.5, autoActive: false, autoReason: null,
    ...overrides,
  };
  const calls = [];
  const writes = [];
  const stored = { margin: status.margin, startupEnabled: status.startupEnabled ?? true,
    autoEnabled: status.autoEnabled, autoStart: status.autoStart, autoRate: status.autoRate };
  let storageListener;
  function changeStorage(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: stored[key], newValue: value };
    }
    Object.assign(stored, values);
    Object.assign(status, values);
    storageListener?.(changes, "local");
  }
  let timer;
  let rejectAutoSave = false;
  for (const id of ["margin", "auto-start", "auto-rate"]) {
    elements.set(id, new Element({ margin: "0.6", "auto-start": "3", "auto-rate": "1.5" }[id]));
  }
  const context = vm.createContext({
    URL, Date,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    setInterval(callback) { timer = callback; return 1; },
    clearInterval() {},
    browser: {
      storage: {
        local: {
          get: async () => {
            if (options.failRead) throw new Error("storage unavailable");
            return { ...stored };
          },
          set: async values => {
            if (rejectAutoSave) throw new Error("storage unavailable");
            writes.push(values);
            changeStorage(values);
          },
        },
        onChanged: { addListener: listener => { storageListener = listener; } },
      },
      tabs: {
        query: async () => [{ id: 7, url: options.url ?? "https://chzzk.naver.com/live/channel-id" }],
        sendMessage: async (_tabId, request) => {
          calls.push(request);
          if (options.disconnected) throw new Error("no content script");
          return { ok: true, status: { ...status } };
        },
      },
    },
  });
  for (const name of ["media", "auto-policy", "playback-policy"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${name}.js`), "utf8"), context);
  }
  vm.runInContext(popupSource, context, { filename: "popup/popup.js" });
  await flush();
  return {
    elements, status, calls, writes, stored, changeStorage,
    async refresh() { timer(); await flush(); },
    rejectAutoSave(value = true) { rejectAutoSave = value; },
  };
}

test("popup has no LL-HLS trial or 60-second measurement controls", async () => {
  const app = await harness({ stream: { selectedKind: "low-latency" } });
  assert.match(app.elements.get("current-connection").textContent, /LL-HLS/);
  for (const id of ["switch-llhls", "restore-stream", "start-measurement", "export-measurement"]) {
    assert.equal(app.elements.has(id), false);
  }
});

test("popup preserves unsaved automatic settings across status refreshes", async () => {
  const app = await harness();
  const start = app.elements.get("auto-start");
  const rate = app.elements.get("auto-rate");
  start.value = "5";
  start.emit("input");
  rate.value = "1.2";
  rate.emit("input");
  app.changeStorage({ autoStart: 4, autoRate: 2, margin: 0.8 });
  await app.refresh();
  assert.equal(start.value, "5");
  assert.equal(rate.value, "1.2");
  assert.equal(app.elements.get("margin").value, "0.8");
  assert.equal(app.elements.get("save-auto").disabled, false);
  assert.equal(app.writes.length, 0);
});

test("automatic settings apply together only after explicit form save", async () => {
  const app = await harness();
  app.elements.get("auto-enabled").checked = false;
  app.elements.get("auto-enabled").emit("input");
  app.elements.get("auto-start").value = "4.5";
  app.elements.get("auto-start").emit("input");
  app.elements.get("auto-rate").value = "1.2";
  app.elements.get("auto-rate").emit("input");
  assert.equal(app.writes.length, 0);
  app.elements.get("auto-form").emit("submit");
  await flush();
  const request = app.writes[0];
  assert.equal(request.autoEnabled, false);
  assert.equal(request.autoStart, 4.5);
  assert.equal(request.autoRate, 1.2);
  assert.equal(app.elements.get("save-auto").disabled, true);
  app.changeStorage({ autoStart: 6 });
  await app.refresh();
  assert.equal(app.elements.get("auto-start").value, "6");
});

test("a rejected save keeps pending settings visible and available to retry", async () => {
  const app = await harness();
  app.rejectAutoSave();
  app.elements.get("auto-start").value = "5";
  app.elements.get("auto-start").emit("input");
  app.elements.get("auto-form").emit("submit");
  await flush();
  await app.refresh();
  assert.equal(app.status.autoStart, 3);
  assert.equal(app.elements.get("auto-start").value, "5");
  assert.equal(app.elements.get("save-auto").disabled, false);
  assert.match(app.elements.get("feedback").textContent, /저장/);
});

test("both settings forms reject inverted targets while allowing the exact half-second gap", async () => {
  const app = await harness({ margin: 2.5 });
  const start = app.elements.get("auto-start");
  start.value = "2.9";
  start.emit("input");
  assert.equal(app.elements.get("save-auto").disabled, true);
  app.elements.get("auto-form").emit("submit");
  await flush();
  assert.equal(app.writes.length, 0);
  start.value = "3";
  start.emit("input");
  assert.equal(app.elements.get("save-auto").disabled, false);

  const margin = app.elements.get("margin");
  margin.value = "2.6";
  margin.emit("input");
  assert.equal(app.elements.get("save-margin").disabled, true);
  app.elements.get("margin-form").emit("submit");
  await flush();
  assert.equal(app.writes.length, 0);
  margin.value = "2.5";
  margin.emit("input");
  assert.equal(app.elements.get("save-margin").disabled, false);
  start.value = "31";
  start.emit("input");
  assert.equal(app.elements.get("save-auto").disabled, true);
  start.value = "3";
  start.emit("input");
  app.elements.get("auto-rate").value = "3";
  app.elements.get("auto-rate").emit("input");
  assert.equal(app.elements.get("save-auto").disabled, true);
});

test("active feedback reports the current rate and an unavailable latency stays separate from edge distance", async () => {
  const app = await harness({ autoActive: true, playbackRate: 1.5, playerLatency: null, edgeDistance: 4 });
  assert.equal(app.elements.get("player-latency").textContent, "—");
  assert.equal(app.elements.get("edge-distance").textContent, "4.00 초");
  assert.match(app.elements.get("feedback").textContent, /1\.5배속.*0\.6초/);
});

test("popup uses the actual automatic stop threshold for a 0.2-second margin", async () => {
  const app = await harness({ autoActive: true, margin: 0.2, autoStopBuffer: 0.6 });
  assert.match(app.elements.get("feedback").textContent, /종료 기준 0\.6초/);
  assert.doesNotMatch(app.elements.get("feedback").textContent, /0\.2초/);
});

test("entry preference and margin stay unsaved until their shared form is saved", async () => {
  const app = await harness({ startupEnabled: true });
  const toggle = app.elements.get("startup-enabled");
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  toggle.emit("input");
  app.elements.get("margin").value = "0.2";
  app.elements.get("margin").emit("input");
  await app.refresh();
  assert.equal(toggle.checked, false);
  assert.equal(app.elements.get("margin").value, "0.2");
  assert.equal(app.writes.length, 0);
  app.elements.get("margin-form").emit("submit");
  await flush();
  const saved = app.writes[0];
  assert.equal(saved.startupEnabled, false);
  assert.equal(saved.margin, 0.2);
  assert.equal(app.elements.get("save-margin").disabled, true);
});

test("manual catch-up is disabled during stream preparation or ended playback", async () => {
  for (const state of [{ streamChanging: true }, { ended: true }]) {
    const app = await harness(state);
    assert.equal(app.elements.get("catch-up").disabled, true);
  }
});

test("all settings can be saved outside CHZZK or before the content script connects", async () => {
  for (const options of [{ url: "https://example.com/" }, { url: "about:newtab" }, { disconnected: true }]) {
    const app = await harness({}, options);
    assert.equal(app.elements.get("catch-up").disabled, true);
    assert.equal(app.elements.get("export-log").disabled, true);
    assert.equal(app.elements.get("margin").disabled, false);
    assert.equal(app.elements.get("auto-enabled").disabled, false);
    app.elements.get("margin").value = "0.2";
    app.elements.get("margin").emit("input");
    app.elements.get("startup-enabled").checked = false;
    app.elements.get("startup-enabled").emit("input");
    app.elements.get("margin-form").emit("submit");
    await flush();
    assert.equal(app.stored.margin, 0.2);
    assert.equal(app.stored.startupEnabled, false);
    app.elements.get("auto-start").value = "4";
    app.elements.get("auto-start").emit("input");
    app.elements.get("auto-rate").value = "1.2";
    app.elements.get("auto-rate").emit("input");
    app.elements.get("auto-enabled").checked = false;
    app.elements.get("auto-form").emit("submit");
    await flush();
    assert.equal(app.stored.autoStart, 4);
    assert.equal(app.stored.autoRate, 1.2);
    assert.equal(app.stored.autoEnabled, false);
    await app.refresh();
    assert.match(app.elements.get("feedback").textContent, /저장했어요/);
    assert.equal(app.calls.every(call => call.type === "get-status"), true);
  }
});

test("failed standalone margin saves preserve stored values and allow retry", async () => {
  const app = await harness({}, { url: "about:newtab" });
  app.rejectAutoSave();
  app.elements.get("margin").value = "0.2";
  app.elements.get("margin").emit("input");
  app.elements.get("startup-enabled").checked = false;
  app.elements.get("startup-enabled").emit("input");
  app.elements.get("margin-form").emit("submit");
  await flush();
  assert.equal(app.stored.margin, 0.6);
  assert.equal(app.stored.startupEnabled, true);
  assert.equal(app.elements.get("save-margin").disabled, false);
  assert.equal(app.elements.get("margin").value, "0.2");
  assert.match(app.elements.get("feedback").textContent, /저장하지 못/);
});

test("unreadable settings cannot be overwritten with defaults", async () => {
  const app = await harness({}, { failRead: true, url: "about:newtab" });
  assert.equal(app.elements.get("margin").disabled, true);
  assert.equal(app.elements.get("auto-enabled").disabled, true);
  app.elements.get("margin-form").emit("submit");
  app.elements.get("auto-form").emit("submit");
  await flush();
  assert.equal(app.writes.length, 0);
  assert.match(app.elements.get("feedback").textContent, /설정을 읽지 못/);
});

test("transport preference buttons work outside CHZZK and keep actual connection separate", async () => {
  const offline = await harness({}, { url: "about:newtab" });
  offline.elements.get("stream-hls").emit("click");
  await flush();
  assert.equal(offline.stored.streamMode, "hls");
  assert.equal(offline.elements.get("stream-hls")["aria-pressed"], "true");
  assert.equal(offline.elements.get("current-connection").textContent, "—");
  const live = await harness({ stream: { available: true, selectedKind: "low-latency",
    tracks: [{ kind: "low-latency" }] } });
  live.elements.get("stream-hls").emit("click");
  await flush();
  assert.equal(live.elements.get("current-connection").textContent, "LL-HLS");
  assert.match(live.elements.get("stream-status").textContent, /제공되지 않아/);
});

test("failed connection preference writes retain the previous selected mode", async () => {
  const app = await harness({}, { url: "about:newtab" });
  app.rejectAutoSave();
  app.elements.get("stream-hls").emit("click");
  await flush();
  assert.equal(app.elements.get("stream-auto")["aria-pressed"], "true");
  assert.equal(app.writes.length, 0);
});

test("buffer guard preferences validate, preserve drafts and save without a live tab", async () => {
  const app = await harness({}, { url: "about:newtab" });
  app.elements.get("guard-count").value = "1";
  app.elements.get("guard-count").emit("input");
  app.elements.get("guard-form").emit("submit");
  await flush();
  assert.equal(app.writes.length, 0);
  app.elements.get("guard-count").value = "3";
  app.elements.get("guard-step").value = "0.4";
  app.elements.get("guard-max").value = "2";
  app.elements.get("guard-enabled").checked = false;
  await app.refresh();
  assert.equal(app.elements.get("guard-count").value, "3");
  app.elements.get("guard-form").emit("submit");
  await flush();
  assert.equal(app.stored.bufferGuardEnabled, false);
  assert.equal(app.stored.bufferGuardCount, 3);
  assert.equal(app.stored.bufferGuardStep, 0.4);
  assert.equal(app.stored.bufferGuardMax, 2);
  assert.equal(app.writes[0].streamMode, undefined);
  assert.equal(app.elements.get("save-guard").disabled, true);
});

test("effective buffer is shown separately from the saved base and reset is live-only", async () => {
  const app = await harness({ margin: 0.6, effectiveMargin: 1.4, effectiveAutoStart: 3 });
  assert.equal(app.elements.get("margin").value, "0.6");
  assert.match(app.elements.get("buffer-status").textContent, /1\.4초/);
  assert.equal(app.elements.get("reset-buffer").disabled, false);
  app.elements.get("reset-buffer").emit("click");
  await flush();
  assert.equal(app.calls.some(call => call.type === "reset-buffer"), true);
  const offline = await harness({}, { url: "about:newtab" });
  assert.equal(offline.elements.get("reset-buffer").disabled, true);
});
