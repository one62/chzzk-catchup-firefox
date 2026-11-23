"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const script = fs.readFileSync(require.resolve("../src/clip-audio-relay.js"), "utf8");

function port(name) {
  function event() {
    return { addListener(fn) { this.send = fn; } };
  }
  return { name, onDisconnect: event(),
    disconnect() { this.closed = true; }
  };
}

test("relay connects the editor only to its opening tab and closes the partner port", () => {
  let connect;
  const calls = [];
  const live = port("clip-audio-live");
  vm.runInNewContext(script, { browser: {
    runtime: { onConnect: { addListener(fn) { connect = fn; } } },
    tabs: { connect(id, opts) { calls.push([id, opts.frameId, opts.name]); return live; } }
  } });
  const editor = port("clip-audio-editor");
  editor.sender = { frameId: 0, url: "https://chzzk.naver.com/clip-editor?test", tab: { openerTabId: 47 } };
  connect(editor);
  assert.deepEqual(calls, [[47, 0, "clip-audio-live"]]);
  editor.onDisconnect.send();
  assert.ok(live.closed);
  const direct = port("clip-audio-editor");
  direct.sender = { ...editor.sender, tab: {} };
  connect(direct);
  assert.ok(direct.closed);
  assert.equal(calls.length, 1);
});
