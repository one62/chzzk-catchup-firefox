"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../popup/site-access.js"), "utf8");

async function harness(granted = false, request = async () => true) {
  const button = { disabled: false, textContent: "", addEventListener: (_, fn) => { button.click = fn; } };
  const status = { textContent: "" };
  const calls = [];
  const events = {};
  vm.runInNewContext(source, {
    document: { getElementById: id => id === "grant-chzzk-access" ? button : status },
    browser: { permissions: {
      contains: async scope => { calls.push(["contains", scope]); return granted; },
      request: scope => {
        calls.push(["request", scope]);
        return Promise.resolve(request()).then(value => { granted = value; return value; });
      },
      onAdded: { addListener: fn => { events.added = fn; } },
      onRemoved: { addListener: fn => { events.removed = fn; } },
    } },
  });
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  await flush();
  return { button, status, calls, events, flush, setGranted: value => { granted = value; } };
}

test("opening the popup only checks access; a click requests the declared CHZZK origin", async () => {
  const app = await harness();
  assert.equal(app.calls.filter(([type]) => type === "request").length, 0);
  assert.equal(app.button.disabled, false);
  app.button.click();
  app.button.click();
  const requests = app.calls.filter(([type]) => type === "request");
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests[0][1]), JSON.stringify({ origins: ["https://chzzk.naver.com/*"] }));
  await app.flush();
  assert.equal(app.button.disabled, true);
  assert.match(app.button.textContent, /허용됨/);
  assert.match(app.status.textContent, /새로고침/);
});

test("existing access remains visible and revocation enables the grant button again", async () => {
  const app = await harness(true);
  assert.equal(app.button.disabled, true);
  assert.match(app.button.textContent, /허용됨/);
  app.setGranted(false);
  app.events.removed();
  await app.flush();
  assert.equal(app.button.disabled, false);
  assert.equal(app.button.textContent, "치지직 접근 허용");
});

test("denied or failed access requests allow retry and show only a concise result", async () => {
  for (const request of [async () => false, async () => { throw new Error("private details"); }]) {
    const app = await harness(false, request);
    app.button.click();
    await app.flush();
    assert.equal(app.button.disabled, false);
    assert.match(app.status.textContent, /허용되지|요청 실패/);
    assert.doesNotMatch(app.status.textContent, /private/);
  }
});

test("an unresolved permission prompt stays pending without a second request", async () => {
  const app = await harness(false, () => new Promise(() => {}));
  app.button.click();
  await app.flush();
  assert.equal(app.button.disabled, true);
  app.button.click();
  assert.equal(app.calls.filter(([type]) => type === "request").length, 1);
});
