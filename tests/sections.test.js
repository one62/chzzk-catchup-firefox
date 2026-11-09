"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../popup/sections.js"), "utf8");

test("fold and enable switches are independent and restored in a new popup", async () => {
  const saved = {};
  const api = {
    storage: { local: { get: async defaults => ({ ...defaults, ...saved }),
      set: async values => Object.assign(saved, values) } },
    runtime: { sendMessage: async ({ enabled }) => { saved.clipEnabled = enabled; } },
  };
  async function open() {
    const elements = {};
    const document = { getElementById(id) {
      return elements[id] ??= { firstElementChild: {}, addEventListener(type, fn) { this[type] = fn; },
        setAttribute(name, value) { this[name] = value; } };
    } };
    vm.runInNewContext(source, { browser: api, document });
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
