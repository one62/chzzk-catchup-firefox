"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../src/chat-layout.js"), "utf8");

test("chat placement follows the inclusive viewport threshold and live settings", async () => {
  let storageChanged;
  let enabled;
  let viewportWidth = 1000;
  let viewportChanged;
  let frame;
  let fittedHeight;
  let chatTop = 350;
  const player = {};
  const layout = { scrollTop: 100, querySelector: () => player };
  const chat = {
    parentElement: layout,
    closest: () => layout,
    getBoundingClientRect: () => ({ top: chatTop }),
  };
  vm.runInNewContext(source, {
    browser: { storage: {
      local: { get: async defaults => defaults },
      onChanged: { addListener: listener => { storageChanged = listener; } },
    } },
    document: {
      querySelector: () => chat,
      addEventListener() {},
      removeEventListener() {},
      documentElement: {
        clientHeight: 800,
        style: {
          setProperty(name, value) { fittedHeight = value; },
          removeProperty() { fittedHeight = undefined; },
        },
        toggleAttribute(name, active) {
          assert.equal(name, "data-chzzk-catchup-chat-below");
          enabled = active;
        },
      },
    },
    window: { addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(callback) { frame = callback; return 1; },
    cancelAnimationFrame() {},
    matchMedia(query) {
      const threshold = Number(/^\(max-width: (\d+)px\)$/.exec(query)[1]);
      return {
        get matches() { return viewportWidth <= threshold; },
        addEventListener(type, listener) { viewportChanged = listener; },
        removeEventListener(type, listener) {
          assert.equal(viewportChanged, listener);
          viewportChanged = undefined;
        },
      };
    },
  });
  await Promise.resolve();
  assert.equal(enabled, false);
  storageChanged({ chatLayoutEnabled: { newValue: true } }, "local");
  assert.equal(enabled, true);
  frame();
  assert.equal(fittedHeight, "350px");
  viewportWidth = 1001;
  viewportChanged();
  assert.equal(enabled, false);
  assert.equal(fittedHeight, undefined);
  storageChanged({ chatLayoutWidth: { newValue: 1100 } }, "local");
  assert.equal(enabled, true);
  chatTop = 750;
  frame();
  assert.equal(fittedHeight, undefined);
  storageChanged({ chatLayoutEnabled: { newValue: false } }, "local");
  assert.equal(enabled, false);
});
