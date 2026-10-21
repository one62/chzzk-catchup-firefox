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
    assert.equal(app.elements.has("export-log"), false);
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
  app.elements.get("buffer-auto-form").emit("submit");
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

test("buffer optimization replaces guard controls directly below automatic catch-up", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const automaticEnd = html.indexOf("</form>", html.indexOf('id="auto-form"'));
  const optimizerStart = html.indexOf('id="buffer-auto-form"');
  assert.ok(automaticEnd < optimizerStart);
  assert.ok(optimizerStart < html.indexOf('id="margin-form"'));
  assert.match(html.slice(automaticEnd + 7, optimizerStart), /^\s*<form $/);
  assert.doesNotMatch(html, /guard-(?:form|count|step|max|enabled)|반복 끊김 대응|버퍼 증가분/);
  const optimization = html.slice(optimizerStart, html.indexOf("</form>", optimizerStart));
  assert.match(optimization, /id="buffer-status"/);
  assert.match(optimization, /버퍼 학습 초기화/);
});

test("optimization toggle locks manual input immediately and saves independently outside CHZZK", async () => {
  const app = await harness({ autoEnabled: false }, { url: "about:newtab" });
  const toggle = app.elements.get("buffer-auto-enabled");
  toggle.checked = true;
  toggle.emit("input");
  assert.equal(app.elements.get("margin").disabled, true);
  assert.equal(app.elements.get("startup-enabled").disabled, false);
  assert.equal(app.stored.bufferAutoEnabled, false);
  assert.equal(app.writes.length, 0);
  app.changeStorage({ autoRate: 1.2 });
  await app.refresh();
  assert.equal(toggle.checked, true);
  assert.equal(app.elements.get("save-buffer-auto").disabled, false);
  app.elements.get("buffer-auto-form").emit("submit");
  await flush();
  assert.deepEqual(Object.keys(app.writes[0]), ["bufferAutoEnabled"]);
  assert.equal(app.stored.bufferAutoEnabled, true);
  assert.equal(app.stored.autoEnabled, false);
  assert.equal(app.elements.get("save-buffer-auto").disabled, true);
});

test("optimization disables manual input while preserving startup preference saves", async () => {
  for (const options of [{}, { url: "about:newtab" }, { disconnected: true }]) {
    const app = await harness({ bufferAutoEnabled: true, margin: 2.8, autoStart: 2 }, options);
    assert.equal(app.elements.get("margin").disabled, true);
    assert.equal(app.elements.get("startup-enabled").disabled, false);
    app.elements.get("margin").value = "invalid";
    app.elements.get("margin").emit("input");
    app.elements.get("startup-enabled").checked = false;
    app.elements.get("startup-enabled").emit("input");
    assert.equal(app.elements.get("save-margin").disabled, false);
    app.elements.get("margin-form").emit("submit");
    await flush();
    assert.deepEqual(Object.keys(app.writes[0]), ["startupEnabled"]);
    assert.equal(app.stored.startupEnabled, false);
    assert.equal(app.stored.margin, 2.8);
    assert.equal(app.stored.autoStart, 2);
    assert.equal(app.elements.get("margin").value, "2.8");
  }
});

test("a draft optimization toggle also prevents programmatic writes to disabled manual input", async () => {
  const app = await harness({ margin: 0.9 });
  app.elements.get("buffer-auto-enabled").checked = true;
  app.elements.get("buffer-auto-enabled").emit("input");
  app.elements.get("margin").value = "0.2";
  app.elements.get("margin").emit("input");
  app.elements.get("startup-enabled").checked = false;
  app.elements.get("startup-enabled").emit("input");
  app.elements.get("margin-form").emit("submit");
  await flush();
  assert.deepEqual(Object.keys(app.writes[0]), ["startupEnabled"]);
  assert.equal(app.stored.margin, 0.9);
  assert.equal(app.stored.bufferAutoEnabled, false);
});

test("disabling optimization unlocks the preserved manual margin only after saving", async () => {
  const app = await harness({ bufferAutoEnabled: true, margin: 0.9, effectiveMargin: 2.1 });
  const toggle = app.elements.get("buffer-auto-enabled");
  toggle.checked = false;
  toggle.emit("input");
  assert.equal(app.elements.get("margin").disabled, true);
  assert.equal(app.stored.bufferAutoEnabled, true);
  app.elements.get("buffer-auto-form").emit("submit");
  await flush();
  assert.equal(app.elements.get("margin").disabled, false);
  assert.equal(app.elements.get("margin").value, "0.9");
  assert.equal(app.stored.margin, 0.9);
  assert.match(app.elements.get("buffer-status").textContent, /수동 남길 버퍼 0\.9초/);
});

test("failed optimization saves retain the saved mode and retryable draft", async () => {
  for (const previous of [true, false]) {
    const app = await harness({ bufferAutoEnabled: previous }, { url: "about:newtab" });
    app.rejectAutoSave();
    app.elements.get("buffer-auto-enabled").checked = !previous;
    app.elements.get("buffer-auto-enabled").emit("input");
    app.elements.get("buffer-auto-form").emit("submit");
    await flush();
    await app.refresh();
    assert.equal(app.stored.bufferAutoEnabled, previous);
    assert.equal(app.elements.get("buffer-auto-enabled").checked, !previous);
    assert.equal(app.elements.get("margin").disabled, true);
    assert.equal(app.elements.get("save-buffer-auto").disabled, false);
    assert.match(app.elements.get("feedback").textContent, /저장하지 못/);
  }
});

test("failed startup saves under optimization preserve manual values and retryable startup draft", async () => {
  const app = await harness({ bufferAutoEnabled: true, margin: 2.8, autoStart: 2 }, { url: "about:newtab" });
  app.rejectAutoSave();
  app.elements.get("startup-enabled").checked = false;
  app.elements.get("startup-enabled").emit("input");
  app.elements.get("margin").value = "invalid";
  app.elements.get("margin-form").emit("submit");
  await flush();
  assert.equal(app.stored.startupEnabled, true);
  assert.equal(app.stored.margin, 2.8);
  assert.equal(app.elements.get("startup-enabled").checked, false);
  assert.equal(app.elements.get("save-margin").disabled, false);
});

test("optimized mode saves user automatic start threshold independently of manual margin", async () => {
  const app = await harness({ bufferAutoEnabled: true, margin: 3, autoStart: 2 });
  assert.equal(app.elements.get("auto-start").value, "2");
  app.elements.get("auto-start").value = "2.2";
  app.elements.get("auto-start").emit("input");
  assert.equal(app.elements.get("save-auto").disabled, false);
  app.elements.get("auto-form").emit("submit");
  await flush();
  assert.equal(app.stored.autoStart, 2.2);
  for (const start of ["1.9", "30.1", "invalid"]) {
    app.elements.get("auto-start").value = start;
    app.elements.get("auto-start").emit("input");
    assert.equal(app.elements.get("save-auto").disabled, true);
  }
});

test("legacy disabled guard preferences keep optimization disabled until explicitly changed", async () => {
  const app = await harness({}, { stored: { bufferAutoEnabled: undefined, bufferGuardEnabled: false } });
  assert.equal(app.elements.get("buffer-auto-enabled").checked, false);
  assert.equal(app.elements.get("margin").disabled, false);
  app.elements.get("buffer-auto-enabled").checked = true;
  app.elements.get("buffer-auto-enabled").emit("input");
  app.elements.get("buffer-auto-form").emit("submit");
  await flush();
  assert.equal(app.stored.bufferAutoEnabled, true);
  assert.equal(app.stored.bufferGuardEnabled, false);
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
