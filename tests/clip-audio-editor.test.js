"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const script = fs.readFileSync(require.resolve("../src/clip-audio-editor.js"), "utf8");

test("editor lifecycle notifies its DOM opener without sending preview data", () => {
  const messages = [];
  const listeners = {};
  const origin = "https://chzzk.naver.com";
  vm.runInNewContext(script, {
    location: { pathname: "/clip-editor", origin },
    window: {
      opener: { postMessage: (message, targetOrigin) => messages.push([message.type, message.open, targetOrigin]) },
      addEventListener: (key, fn) => { listeners[key] = fn; },
    },
  });
  listeners.pagehide();
  listeners.pageshow();
  assert.deepEqual(messages, [
    ["chzzk-clip-audio-editor", true, origin],
    ["chzzk-clip-audio-editor", false, origin],
    ["chzzk-clip-audio-editor", true, origin],
  ]);
});
