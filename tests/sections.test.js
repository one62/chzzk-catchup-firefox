"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../popup/sections.js"), "utf8");

test("clip editor panning depends on the parent switch and restores its saved choice", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const body = html.slice(html.indexOf('id="clip-body"'), html.indexOf('aria-labelledby="chatLayout-title"'));
  const keys = [...body.matchAll(/id="([\w-]+)" type="checkbox"/g)].map(match => match[1]);
  assert.deepEqual(keys, ["clip-keep-live-audio", "clip-editor-audio-pan"]);
  assert.match(body, /id="clip-editor-pan-left"/);
  assert.match(body, /id="clip-editor-pan-right"/);
  const saved = {};
  let listener;
  let fail = false;
  const browser = { storage: {
    local: {
      get: async () => ({ ...saved }),
      set: async values => {
        if (fail) throw new Error("storage unavailable");
        Object.assign(saved, values);
        listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), "local");
      },
    },
    onChanged: { addListener(fn) { listener = fn; } },
  } };
  async function open() {
    const elements = {};
    const document = { getElementById(id) {
      return elements[id] ??= {
        addEventListener(type, fn) { this[type] = fn; },
        setAttribute(name, value) { this[name] = value; },
      };
    } };
    vm.runInNewContext(source, { document, browser, window: { addEventListener() {} } });
    await new Promise(setImmediate);
    return elements;
  }
  let ui = await open();
  const [parent, pan] = keys;
  const left = "clip-editor-pan-left";
  const right = "clip-editor-pan-right";
  assert.equal(ui[parent].checked, false);
  assert.equal(ui[pan].disabled, true);
  assert.equal(ui[left].disabled, true);
  assert.equal(ui[right].disabled, true);
  assert.equal(ui[left]["aria-pressed"], "false");
  assert.equal(ui[right]["aria-pressed"], "true");
  async function change(key, enabled) {
    const input = ui[key];
    input.checked = enabled;
    await input.change();
  }
  await change(parent, true);
  assert.equal(ui[pan].disabled, false);
  assert.equal(ui[left].disabled, false);
  assert.equal(ui[right].disabled, false);
  await change(pan, true);
  await ui[left].click();
  assert.equal(ui[left]["aria-pressed"], "true");
  assert.equal(ui[right]["aria-pressed"], "false");
  ui = await open();
  assert.equal(ui[parent].checked, true);
  assert.equal(ui[pan].checked, true);
  assert.equal(ui[left]["aria-pressed"], "true");
  assert.equal(ui[right]["aria-pressed"], "false");
  fail = true;
  await ui[right].click();
  assert.equal(ui[left]["aria-pressed"], "true");
  assert.match(ui["feature-note"].textContent, /저장하지 못했습니다/);
  await change(parent, false);
  assert.equal(ui[parent].checked, true);
  assert.match(ui["feature-note"].textContent, /저장하지 못했습니다/);
  fail = false;
  await change(parent, false);
  assert.equal(ui[pan].disabled, true);
  assert.equal(ui[left].disabled, true);
  assert.equal(saved.clipEditorAudioPan, true);
  assert.equal(saved.clipEditorAudioPanSide, "left");
  await change(parent, true);
  assert.equal(ui[pan].checked, true);
  assert.equal(ui[pan].disabled, false);
  assert.equal(ui[left].disabled, false);
  assert.equal(ui[left]["aria-pressed"], "true");
});

test("fold and enable switches are independent and restored in a new popup", async () => {
  const saved = {};
  const api = {
    storage: { local: { get: async defaults => ({ ...defaults, ...saved }),
      set: async values => Object.assign(saved, values) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async ({ enabled }) => { saved.clipEnabled = enabled; } },
  };
  async function open() {
    const elements = {};
    const document = { getElementById(id) {
      return elements[id] ??= { firstElementChild: {}, addEventListener(type, fn) { this[type] = fn; },
        setAttribute(name, value) { this[name] = value; } };
    } };
    vm.runInNewContext(source, { browser: api, document, window: { addEventListener() {} } });
    await Promise.resolve();
    return elements;
  }
  let ui = await open();
  assert.equal(ui["catchup-body"].hidden, false);
  assert.equal(ui["chatLayout-body"].disabled, true);
  assert.equal(ui["chat-width"].value, 1000);
  await ui["catchup-fold"].click();
  assert.equal(ui["catchup-body"].disabled, false);
  ui["clip-enabled"].checked = false;
  await ui["clip-enabled"].change();
  ui["chatLayout-enabled"].checked = true;
  await ui["chatLayout-enabled"].change();
  ui["chat-width"].valueAsNumber = 960;
  ui["chat-width"].change();
  await new Promise(setImmediate);
  ui = await open();
  assert.equal(ui["catchup-fold"]["aria-expanded"], "false");
  assert.equal(ui["catchup-enabled"].checked, true);
  assert.equal(ui["clip-body"].hidden, false);
  assert.equal(ui["clip-body"].disabled, true);
  assert.equal(ui["chatLayout-body"].disabled, false);
  assert.equal(ui["chat-width"].value, 960);
  ui["chat-width"].valueAsNumber = 0;
  ui["chat-width"].change();
  await new Promise(setImmediate);
  assert.equal(saved.chatLayoutWidth, 960);
  assert.equal(ui["chat-width"].value, 960);
});

test("section settings retry and preserve changes newer than the initial snapshot", async () => {
  const elements = {};
  const document = { getElementById(id) {
    return elements[id] ??= { addEventListener() {}, setAttribute(name, value) { this[name] = value; } };
  } };
  let reads = 0;
  let retry;
  let resolveRead;
  let listener;
  const api = { storage: {
    local: { get: defaults => ++reads === 1 ? Promise.reject(new Error("storage unavailable"))
      : new Promise(resolve => { resolveRead = () => resolve(defaults); }) },
    onChanged: { addListener(callback) { listener = callback; } },
  } };
  vm.runInNewContext(source, {
    browser: api, document, window: { addEventListener() {} },
    setTimeout(callback) { retry = callback; },
  });
  await new Promise(setImmediate);
  assert.equal(elements["catchup-enabled"].disabled, true);
  assert.match(elements["feature-note"].textContent, /다시 시도/);
  retry();
  listener({ catchupEnabled: { newValue: false }, chatLayoutWidth: { newValue: 800 } }, "local");
  resolveRead();
  await new Promise(setImmediate);
  assert.equal(elements["catchup-enabled"].disabled, false);
  assert.equal(elements["catchup-enabled"].checked, false);
  assert.equal(elements["catchup-body"].disabled, true);
  assert.equal(elements["chat-width"].value, 800);
  assert.equal(elements["feature-note"].textContent, "");
  listener({ catchupEnabled: { newValue: true } }, "local");
  assert.equal(elements["catchup-body"].disabled, false);
});
