"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/clip-compat.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0";

// Separate native/isolated and page navigators model Firefox's Xray boundary.
// This harness cannot prove the real browser's injection timing or bridge behavior.
function run({ pathname = "/clip-editor", origin = "https://chzzk.naver.com",
  ua = firefox, frame = false, locked = false, rootReady = true,
  bridge = true, exporter = true, exportThrows = false } = {}) {
  const prototype = { platform: "Win32", vendor: "", hardwareConcurrency: 8 };
  Object.defineProperty(prototype, "userAgent", {
    get: () => ua, configurable: true, enumerable: true,
  });
  const navigator = Object.create(prototype);
  const pageNavigator = Object.create(prototype);
  if (locked) Object.defineProperty(pageNavigator, "userAgent", { value: ua, configurable: false });
  const page = { navigator: pageNavigator };
  page.top = frame ? {} : page;
  const window = {
    // Deliberately different from the isolated window: compare page objects only.
    top: page.top,
    wrappedJSObject: bridge ? page : undefined,
  };
  const attributes = new Map();
  const root = { setAttribute: (name, value) => attributes.set(name, value) };
  const document = { documentElement: rootReady ? root : null };
  const observers = [], exported = [], info = [], warnings = [], messages = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const context = { window, navigator, document, MutationObserver,
    location: { origin, pathname },
    browser: { runtime: { getManifest: () => manifest,
      onMessage: { addListener: listener => messages.push(listener) } } },
    console: { info: value => info.push(value), warn: (...values) => warnings.push(values) } };
  if (exporter) context.exportFunction = (fn, target) => {
    if (exportThrows) throw new TypeError("Mock export failure");
    const getter = (...args) => fn(...args);
    exported.push({ target, getter });
    return getter;
  };
  vm.runInNewContext(source, context);
  return { context, navigator, pageNavigator, window, document, exported, observers, info, warnings, messages,
    diagnostic: () => JSON.parse(attributes.get("data-chzzk-clip-compat") || "null") };
}

test("changes the page UA through an exported getter while the isolated navigator stays native", () => {
  const result = run();
  assert.match(result.pageNavigator.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(result.pageNavigator.userAgent, /Chrome\/128\.0\.0\.0/);
  assert.doesNotMatch(result.pageNavigator.userAgent, /Firefox|rv:|Gecko\/20100101/);
  assert.equal(result.navigator.userAgent, firefox);
  assert.equal(Object.hasOwn(result.navigator, "userAgent"), false);
  assert.equal(result.exported.length, 1);
  assert.equal(result.exported[0].target, result.window);
  assert.equal(Object.getOwnPropertyDescriptor(result.pageNavigator, "userAgent").get, result.exported[0].getter);
  assert.equal(result.pageNavigator.platform, "Win32");
  assert.equal(result.pageNavigator.vendor, "");
  assert.equal(result.pageNavigator.hardwareConcurrency, 8);
  assert.equal(result.info.length, 0);
  assert.equal(result.warnings.length, 0);

  const first = result.pageNavigator.userAgent;
  vm.runInNewContext(source, result.context);
  assert.equal(result.pageNavigator.userAgent, first);
  assert.equal(result.exported.length, 1);

});

test("live, VOD, lookalike paths and other origins keep the native page UA without changes", () => {
  for (const options of [
    { pathname: "/live/test" }, { pathname: "/video/123" }, { pathname: "/" },
    { pathname: "/clip-editor-extra" }, { pathname: "/clip-editor/nested" },
    { origin: "https://example.com" },
  ]) {
    const result = run(options);
    assert.equal(result.pageNavigator.userAgent, firefox);
    assert.equal(result.exported.length, 0);

  }
  assert.match(run({ pathname: "/clip-editor/" }).pageNavigator.userAgent, /Chrome\//);
});

test("subframes and unsupported UA formats keep their native UA", () => {
  const subframe = run({ frame: true });
  assert.equal(subframe.pageNavigator.userAgent, firefox);

  for (const ua of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Android 14; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0",
    "Firefox/158.0",
  ]) {
    const result = run({ ua });
    assert.equal(result.pageNavigator.userAgent, ua);

    assert.equal(result.exported.length, 0);
  }
});

test("patches the UA immediately without a DOM root or diagnostic observers", () => {
  const result = run({ rootReady: false });
  assert.match(result.pageNavigator.userAgent, /Chrome\//);
  assert.equal(result.observers.length, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(result.diagnostic(), null);
});

test("reports missing Firefox bridge APIs without falling back to an ineffective isolated getter", () => {
  for (const options of [{ bridge: false }, { exporter: false }]) {
    const result = run(options);
    assert.equal(result.pageNavigator.userAgent, firefox);
    assert.equal(Object.hasOwn(result.navigator, "userAgent"), false);

    assert.equal(result.warnings.length, 1);
  }
});

test("reports export or protected-property failures without stopping page initialization", () => {
  for (const options of [{ locked: true }, { exportThrows: true }]) {
    const result = run(options);
    assert.equal(result.pageNavigator.userAgent, firefox);
    assert.equal(result.info.length, 0);
    assert.equal(result.warnings.length, 1);

  }
});

test("manifest installs the Firefox bridge early in the isolated world without extra permissions", () => {
  const entries = manifest.content_scripts.filter(item => item.js.includes("src/clip-compat.js"));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].matches, ["https://chzzk.naver.com/clip-editor*"]);
  assert.equal(entries[0].run_at, "document_start");
  assert.equal(entries[0].world, "ISOLATED");
  assert.notEqual(entries[0].all_frames, true);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://chzzk.naver.com/*"]);
});
