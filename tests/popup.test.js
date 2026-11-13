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
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

async function harness(overrides = {}, options = {}) {
  const elements = new Map();
  const status = {
    isLive: true, videoFound: true, paused: false, seeking: false, adState: "unknown",
    playerLatency: 2, edgeDistance: 1.2, forwardBuffer: 1.2, margin: 0.6,
    autoEnabled: true, autoStart: 3, autoRate: 1.5, autoActive: false, autoReason: null,
    bufferAutoEnabled: false,
    ...overrides,
  };
  const calls = [];
  const writes = [];
  const stored = { margin: status.margin, startupEnabled: status.startupEnabled ?? true,
    autoEnabled: status.autoEnabled, autoStart: status.autoStart, autoRate: status.autoRate,
    bufferAutoEnabled: status.bufferAutoEnabled, ...options.stored };
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

test("automatic catch-up options apply independently on change", async () => {
  const app = await harness();
  const start = app.elements.get("auto-start");
  start.value = "4.2";
  start.emit("input");
  await app.refresh();
  assert.equal(start.value, "4.2");
  assert.equal(app.writes.length, 0);
  start.emit("change");
  const rate = app.elements.get("auto-rate");
  rate.value = "2";
  rate.emit("change");
  const enabled = app.elements.get("auto-enabled");
  enabled.checked = false;
  enabled.emit("change");
  await flush();
  assert.equal(app.stored.autoStart, 4.2);
  assert.equal(app.stored.autoRate, 2);
  assert.equal(app.stored.autoEnabled, false);
  assert.deepEqual(app.writes.map(Object.keys), [["autoStart"], ["autoRate"], ["autoEnabled"]]);
});

test("buffer values reject inverted targets while allowing the half-second gap", async () => {
  const app = await harness({ margin: 2, autoStart: 3 });
  const start = app.elements.get("auto-start");
  start.value = "2.4";
  start.emit("change");
  await flush();
  assert.equal(app.writes.length, 0);
  assert.equal(start.value, "3");
  start.value = "2.5";
  start.emit("change");
  const margin = app.elements.get("margin");
  margin.value = "2.1";
  margin.emit("change");
  await flush();
  assert.equal(app.stored.autoStart, 2.5);
  assert.equal(app.stored.margin, 2);
  assert.equal(app.writes.length, 1);
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

test("manual catch-up is disabled during stream preparation or ended playback", async () => {
  for (const state of [{ streamChanging: true }, { ended: true }]) {
    const app = await harness(state);
    assert.equal(app.elements.get("catch-up").disabled, true);
  }
});

test("options persist without a connected CHZZK tab", async () => {
  for (const options of [{ url: "about:newtab" }, { disconnected: true }]) {
    const app = await harness({}, options);
    const startup = app.elements.get("startup-enabled");
    startup.checked = false;
    startup.emit("change");
    const margin = app.elements.get("margin");
    margin.value = "0.2";
    margin.emit("change");
    await flush();
    assert.equal(app.stored.startupEnabled, false);
    assert.equal(app.stored.margin, 0.2);
  }
});

test("failed option writes restore the saved value and allow retry", async () => {
  const app = await harness();
  const start = app.elements.get("auto-start");
  app.rejectAutoSave();
  start.value = "4";
  start.emit("change");
  await flush();
  assert.equal(start.value, "3");
  assert.equal(app.writes.length, 0);
  app.rejectAutoSave(false);
  start.value = "4";
  start.emit("change");
  await flush();
  assert.equal(app.stored.autoStart, 4);
});

test("unreadable settings cannot be overwritten with defaults", async () => {
  const app = await harness({}, { failRead: true });
  for (const id of ["margin", "auto-start", "auto-rate", "buffer-auto-enabled", "startup-enabled"]) {
    app.elements.get(id).emit("change");
  }
  await flush();
  assert.equal(app.writes.length, 0);
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
  assert.match(live.elements.get("stream-status").textContent, /미지원/);
});

test("failed connection preference writes retain the previous selected mode", async () => {
  const app = await harness({}, { url: "about:newtab" });
  app.rejectAutoSave();
  app.elements.get("stream-hls").emit("click");
  await flush();
  assert.equal(app.elements.get("stream-auto")["aria-pressed"], "true");
  assert.equal(app.writes.length, 0);
});

test("catch-up action follows the metrics and related settings share one group", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const automaticStart = html.indexOf('id="auto-form"');
  const optimizerStart = html.indexOf('class="buffer-auto-settings"');
  const entryStart = html.indexOf('id="margin-form"');
  assert.ok(automaticStart >= 0 && automaticStart < optimizerStart && optimizerStart < entryStart);
  assert.match(html, /<section class="metrics"[\s\S]*?<\/section>\s*<button id="catch-up"/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.doesNotMatch(html, /guard-(?:form|count|step|max|enabled)|반복 끊김 대응|버퍼 증가분/);
  assert.match(html, /for="auto-enabled"[\s\S]*?<\/label>\s*<label class="toggle-row" for="buffer-auto-enabled">\s*<span>자동 최적화<\/span>/);
  const fields = html.slice(html.indexOf('class="auto-fields"'), optimizerStart);
  assert.match(fields, /id="auto-start"[\s\S]*id="margin"[\s\S]*id="auto-rate"/);
  const optimization = html.slice(optimizerStart, entryStart);
  assert.match(optimization, /id="buffer-status"/);
  assert.match(optimization, /버퍼 학습 초기화/);
});

test("optimization switches immediately and preserves the manual margin", async () => {
  const app = await harness({ margin: 2 }, { url: "about:newtab" });
  const toggle = app.elements.get("buffer-auto-enabled");
  toggle.checked = true;
  toggle.emit("change");
  await flush();
  assert.equal(app.stored.bufferAutoEnabled, true);
  assert.equal(app.elements.get("margin").disabled, true);
  const start = app.elements.get("auto-start");
  assert.equal(start.disabled, true);
  start.value = "2.2";
  start.emit("change");
  await flush();
  assert.equal(app.stored.autoStart, 3);
  toggle.checked = false;
  toggle.emit("change");
  await flush();
  assert.equal(app.stored.bufferAutoEnabled, false);
  assert.equal(app.elements.get("margin").disabled, false);
  assert.equal(app.elements.get("margin").value, "2");
});

test("legacy disabled optimization is preserved until the toggle changes", async () => {
  const app = await harness({}, { stored: { bufferAutoEnabled: undefined, bufferGuardEnabled: false } });
  const toggle = app.elements.get("buffer-auto-enabled");
  assert.equal(toggle.checked, false);
  assert.equal(app.writes.length, 0);
  toggle.checked = true;
  toggle.emit("change");
  await flush();
  assert.equal(app.stored.bufferAutoEnabled, true);
});

test("legacy flag changes are reevaluated while the new optimization preference is absent", async () => {
  const app = await harness({}, { stored: { bufferAutoEnabled: undefined, bufferGuardEnabled: false } });
  app.changeStorage({ bufferGuardEnabled: true });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, true);
  assert.equal(app.elements.get("margin").disabled, true);
  app.changeStorage({ bufferGuardEnabled: false });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, false);
  assert.equal(app.elements.get("margin").disabled, false);
});

test("removing the new optimization preference restores the live legacy fallback", async () => {
  const app = await harness({ bufferAutoEnabled: false }, { stored: { bufferGuardEnabled: true } });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, false);
  app.changeStorage({ bufferAutoEnabled: undefined });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, true);
  app.changeStorage({ bufferGuardEnabled: false });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, false);
  assert.equal(app.elements.get("margin").disabled, false);
});

test("saving other preferences preserves the disabled legacy fallback without creating a new flag", async () => {
  const app = await harness({}, { url: "about:newtab",
    stored: { bufferAutoEnabled: undefined, bufferGuardEnabled: false } });
  app.elements.get("stream-hls").emit("click");
  await flush();
  assert.equal(app.elements.get("buffer-auto-enabled").checked, false);
  assert.equal(app.elements.get("margin").disabled, false);
  assert.deepEqual(Object.keys(app.writes[0]), ["streamMode"]);
  assert.equal(app.stored.bufferAutoEnabled, undefined);
  app.changeStorage({ bufferGuardEnabled: true });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, true);
});

test("optimization learning state explains catch-up availability and reset is live-only", async () => {
  const app = await harness({ bufferAutoEnabled: true, margin: 0.6, effectiveMargin: 1.4,
    effectiveAutoStart: 3, bufferOptimization: { phase: "tracking", safe: true, sampleCount: 5,
      periodSeconds: 2, jitterSeconds: 0.3 } });
  assert.equal(app.elements.get("margin").value, "0.6");
  assert.match(app.elements.get("buffer-status").textContent, /학습 완료.*1\.4초.*주기 2\.0초.*변동 0\.3초/);
  assert.equal(app.elements.get("reset-buffer").disabled, false);
  assert.equal(app.elements.get("catch-up").disabled, false);
  app.elements.get("reset-buffer").emit("click");
  await flush();
  assert.equal(app.calls.some(call => call.type === "reset-buffer"), true);
  assert.match(app.elements.get("feedback").textContent, /보충 주기 학습을 초기화/);
  const offline = await harness({ bufferAutoEnabled: true }, { url: "about:newtab" });
  assert.equal(offline.elements.get("reset-buffer").disabled, true);
  assert.match(offline.elements.get("buffer-status").textContent, /방송 재생 중/);
  const manual = await harness({ bufferAutoEnabled: false, effectiveMargin: 1.4 });
  assert.equal(manual.elements.get("reset-buffer").disabled, true);
  for (const [phase, message] of [["learning", /버퍼 보충 주기 학습 중/],
    ["unstable", /보충 간격이 불안정/], ["tracking", /필요한 버퍼 여유가 줄어들 때까지 따라잡기 대기/]]) {
    const waiting = await harness({ bufferAutoEnabled: true,
      bufferOptimization: { phase, safe: false, sampleCount: 0 } });
    assert.equal(waiting.elements.get("catch-up").disabled, true);
    waiting.elements.get("catch-up").emit("click");
    await flush();
    assert.equal(waiting.calls.some(call => call.type === "catch-up"), false);
    assert.match(waiting.elements.get("buffer-status").textContent, message);
    assert.match(waiting.elements.get("feedback").textContent, message);
    assert.equal(waiting.elements.get("reset-buffer").disabled, false);
  }
});

test("safety level persists independently, follows external changes and restores failed saves", async () => {
  const app = await harness({ bufferAutoEnabled: true, margin: 2.5 }, { url: "about:newtab" });
  const level = app.elements.get("buffer-safety-level");
  assert.equal(level.value, "medium");
  assert.equal(level.disabled, false);
  assert.equal(app.elements.get("auto-rate-label").textContent, "최대 배속");
  level.value = "high";
  level.emit("change");
  await flush();
  assert.equal(app.stored.bufferSafetyLevel, "high");
  assert.equal(app.stored.margin, 2.5);
  assert.deepEqual(Object.keys(app.writes[0]), ["bufferSafetyLevel"]);
  app.rejectAutoSave();
  level.value = "low";
  level.emit("change");
  await flush();
  assert.equal(level.value, "high");
  app.changeStorage({ bufferSafetyLevel: "low" });
  assert.equal(level.value, "low");
  app.changeStorage({ bufferAutoEnabled: false });
  assert.equal(level.disabled, true);
  assert.equal(app.elements.get("auto-rate-label").textContent, "배속");
  app.changeStorage({ bufferAutoEnabled: true });
  assert.equal(level.value, "low");
});

test("popup reports the required reserve even when it exceeds the seek cap", async () => {
  const app = await harness({ bufferAutoEnabled: true, effectiveMargin: 3,
    bufferOptimization: { phase: "tracking", safe: false, requiredBuffer: 4.5 } });
  assert.match(app.elements.get("buffer-status").textContent, /4\.5초/);
  assert.equal(app.elements.get("catch-up").disabled, true);
});
