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
  let windowResized;
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
    window: {
      addEventListener(type, listener) { if (type === "resize") windowResized = listener; },
      removeEventListener() {},
    },
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
  chatTop = 699;
  frame();
  assert.equal(fittedHeight, "240px");
  chatTop = 461;
  windowResized();
  frame();
  assert.equal(fittedHeight, "240px");
  chatTop = 459;
  windowResized();
  frame();
  assert.equal(fittedHeight, "241px");
  chatTop = 700;
  windowResized();
  frame();
  assert.equal(fittedHeight, undefined);
  chatTop = 750;
  windowResized();
  frame();
  assert.equal(fittedHeight, undefined);
  storageChanged({ chatLayoutEnabled: { newValue: false } }, "local");
  assert.equal(enabled, false);
});

test("replay chat is measured when its log changes, without refitting for ordinary messages", async () => {
  let onMutation;
  let observedAttributeOptions;
  let frame;
  let fittedHeight;
  const observedSizes = new Set();
  const player = {};
  const layout = { scrollTop: 0, querySelector: () => player };
  const aside = {
    id: "vod-aside",
    parentElement: layout,
    closest: selector => selector === "#layout-body" ? layout : aside,
    getBoundingClientRect: () => ({ top: 350 }),
  };
  let logAttached = false;
  let logRole = "log";
  const log = {
    closest: () => aside,
    matches: selector => selector === '[role="log"]' && logRole === "log",
  };
  const wrapper = { querySelector: selector => log.matches(selector) ? log : null };
  const message = { matches: () => false, querySelector: () => null };

  vm.runInNewContext(source, {
    browser: { storage: {
      local: { get: async defaults => ({ ...defaults, chatLayoutEnabled: true }) },
      onChanged: { addListener() {} },
    } },
    document: {
      querySelector: selector => selector.includes('#vod-aside:has([role="log"])') &&
        logAttached && logRole === "log" ? aside : null,
      addEventListener() {},
      documentElement: {
        clientHeight: 800,
        style: {
          setProperty(name, value) { fittedHeight = value; },
          removeProperty() { fittedHeight = undefined; },
        },
        toggleAttribute() {},
      },
    },
    window: { addEventListener() {} },
    ResizeObserver: class {
      observe(target) { observedSizes.add(target); }
      disconnect() { observedSizes.clear(); }
    },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe(root, options) { observedAttributeOptions = options; }
    },
    requestAnimationFrame(callback) { frame = callback; return 1; },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
  });
  function runFrame() {
    assert.ok(frame, "a new measurement is scheduled");
    const callback = frame;
    frame = undefined;
    callback();
  }
  function changeChildren(target, addedNodes, removedNodes) {
    onMutation([{ type: "childList", target, addedNodes, removedNodes }]);
  }
  function changeRole(target, oldValue) {
    onMutation([{ type: "attributes", attributeName: "role", target, oldValue }]);
  }

  await Promise.resolve();
  assert.ok(observedAttributeOptions.attributeFilter.includes("role"));
  assert.equal(observedAttributeOptions.attributeOldValue, true);
  runFrame();
  assert.equal(fittedHeight, undefined);
  assert.equal(observedSizes.size, 0);

  logAttached = true;
  changeChildren(aside, [wrapper], []);
  runFrame();
  assert.equal(fittedHeight, "450px");
  assert.deepEqual([...observedSizes], [layout, player]);

  changeChildren(log, [message], [message]);
  assert.equal(frame, undefined);
  changeRole({ closest: () => aside, matches: () => false }, "listitem");
  assert.equal(frame, undefined);

  logAttached = false;
  changeChildren(aside, [], [wrapper]);
  runFrame();
  assert.equal(fittedHeight, undefined);
  assert.equal(observedSizes.size, 0);

  logAttached = true;
  logRole = null;
  changeChildren(aside, [log], []);
  assert.equal(frame, undefined);
  logRole = "log";
  changeRole(log, null);
  runFrame();
  assert.equal(fittedHeight, "450px");
  logRole = null;
  changeRole(log, "log");
  runFrame();
  assert.equal(fittedHeight, undefined);
});
