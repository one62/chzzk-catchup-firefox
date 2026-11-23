"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/clip-audio-open.js"), "utf8");

function setup({ allowed = true, blocked = false } = {}) {
  class HTMLMediaElement {
    wrappedJSObject = this;
    isMuted = false;
    get muted() { return this.isMuted; }
    set muted(value) { this.isMuted = Boolean(value); }
  }
  const popup = blocked ? null : {};
  const calls = [];
  const page = { open(...args) { calls.push({ receiver: this, args }); return popup; } };
  const video = new HTMLMediaElement();
  const opened = [];
  const prevented = [];
  const location = new URL("https://chzzk.naver.com/live/test");
  const env = { window: { wrappedJSObject: page }, document: { baseURI: location.href }, location,
    HTMLMediaElement, exportFunction: fn => fn, queueMicrotask, URL, console };
  vm.runInNewContext(source, env);
  env.ClipAudioOpen.install(() => allowed, () => video, item => opened.push(item), item => prevented.push(item));

  function open(url, target = "chzzkClipEditor") {
    const features = "popup,width=800";
    assert.equal(page.open(url, target, features), popup);
    assert.equal(calls.at(-1).receiver, page);
    assert.deepEqual(calls.at(-1).args, [url, target, features]);
  }
  return { video, opened, prevented, open };
}

test("same-origin clip paths are recognized and only the first synchronous mute is prevented", () => {
  for (const url of ["/clip-editor?clip=1", "../clip-editor/#preview",
    "https://chzzk.naver.com/clip-editor/?clip=1"]) {
    const app = setup();
    app.open(url);
    assert.deepEqual(app.opened, [app.video]);
    assert.equal(app.video.muted, false);
    assert.equal(Object.hasOwn(app.video, "muted"), true);
    app.video.muted = true;
    assert.equal(app.video.muted, false);
    assert.deepEqual(app.prevented, [app.video]);
    assert.equal(Object.hasOwn(app.video, "muted"), false);
    app.video.muted = true;
    assert.equal(app.video.muted, true);
  }
});

test("other URLs, window names, disabled prevention, and blocked popups leave the setter alone", () => {
  function assertIgnored(app, url, target) {
    app.open(url, target);
    app.video.muted = true;
    assert.equal(app.video.muted, true);
    assert.deepEqual(app.opened, []);
    assert.deepEqual(app.prevented, []);
  }
  assertIgnored(setup(), "https://other.example/clip-editor");
  assertIgnored(setup(), "/clip-editor-extra");
  assertIgnored(setup(), "/clip-editor/nested");
  assertIgnored(setup(), "/clip-editor", "anotherWindow");
  assertIgnored(setup({ allowed: false }), "/clip-editor");
  assertIgnored(setup({ blocked: true }), "/clip-editor");
});

test("an unused guard expires at the next microtask", async () => {
  const app = setup();
  app.open("/clip-editor");
  await Promise.resolve();
  assert.equal(Object.hasOwn(app.video, "muted"), false);
  app.video.muted = true;
  assert.equal(app.video.muted, true);
  assert.deepEqual(app.prevented, []);
});

test("an already muted video is recorded and keeps its original setter", () => {
  const app = setup();
  app.video.muted = true;
  app.open("/clip-editor");
  assert.deepEqual(app.opened, [app.video]);
  assert.equal(Object.hasOwn(app.video, "muted"), false);
  app.video.muted = false;
  assert.equal(app.video.muted, false);
  assert.deepEqual(app.prevented, []);
});
