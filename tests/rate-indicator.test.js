"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../src/rate-indicator.js");

// Native-player DOM fixture. Rendering/fullscreen geometry needs Firefox QA.
class Element {
  constructor(tag, document, className = "") {
    this.tagName = tag;
    this.ownerDocument = document;
    this.className = className;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.textContent = "";
  }
  get isConnected() {
    return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(node) {
    node.remove();
    this.children.push(node);
    node.parentElement = this;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  matches(selector) { return this.className.split(/\s+/).includes(selector.slice(1)); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(playerClass = "pzp-pc") {
  const document = { createElement: (tag) => new Element(tag, document) };
  document.body = document.createElement("body");
  const player = new Element("div", document, playerClass);
  document.body.appendChild(player);
  const video = document.createElement("video");
  Object.assign(video, { playbackRate: 1.5, paused: false, ended: false, seeking: false, readyState: 4 });
  player.appendChild(video);
  let currentVideo = video;
  let state = { active: true, rate: 1.5 };
  const options = { getVideo: () => currentVideo, getState: () => state };
  const indicator = create(options);
  return { document, player, video, indicator, options,
    setVideo: (value) => { currentVideo = value; },
    setState: (value) => { state = value; },
    indicators: () => document.body.querySelectorAll(".chzzk-catchup-rate-indicator") };
}

test("automatic catchup mounts a passive rate indicator in the native player", () => {
  const f = fixture();
  f.indicator.update();
  assert.equal(f.indicators().length, 1);
  const indicator = f.indicators()[0];
  assert.equal(indicator.parentElement, f.player);
  assert.equal(indicator.textContent, ">> 1.5×");
  assert.equal(indicator.attributes["aria-hidden"], "true");
  assert.match(indicator.style.cssText, /position:absolute;right:20px;bottom:64px/);
  assert.match(indicator.style.cssText, /pointer-events:none/);
  assert.equal(f.player.style.cssText, undefined);
});

test("updates reuse one indicator and reflect the owned rate", () => {
  const f = fixture();
  f.indicator.update();
  const original = f.indicators()[0];
  for (let i = 0; i < 5; i += 1) f.indicator.update();
  assert.equal(f.indicators().length, 1);
  assert.equal(f.indicators()[0], original);
  f.setState({ active: true, rate: 2 });
  f.video.playbackRate = 2;
  f.indicator.update();
  assert.equal(original.textContent, ">> 2×");
});

test("inactive catchup and externally changed rates remove the indicator", () => {
  const f = fixture();
  f.indicator.update();
  f.setState({ active: false, rate: 1.5 });
  f.indicator.update();
  assert.equal(f.indicators().length, 0);
  f.setState({ active: true, rate: 1.5 });
  f.indicator.update();
  f.video.playbackRate = 2;
  f.indicator.update();
  assert.equal(f.indicators().length, 0);
  f.video.playbackRate = NaN;
  f.indicator.update();
  assert.equal(f.indicators().length, 0);
});

test("paused, ended, seeking, and insufficient-ready videos do not show speeding", () => {
  for (const [property, value] of [["paused", true], ["ended", true], ["seeking", true], ["readyState", 2]]) {
    const f = fixture();
    f.indicator.update();
    f.video[property] = value;
    f.indicator.update();
    assert.equal(f.indicators().length, 0, property);
  }
});

test("invalid ownership state and normal playback never mount an indicator", () => {
  for (const state of [null, {}, { active: false, rate: 2 }, { active: true, rate: 1 },
    { active: true, rate: 0 }, { active: true, rate: NaN }, { active: true, rate: "1.5" }]) {
    const f = fixture();
    f.setState(state);
    f.indicator.update();
    assert.equal(f.indicators().length, 0);
  }
});

test("null or disconnected videos remove a mounted indicator", () => {
  const f = fixture();
  f.indicator.update();
  f.setVideo(null);
  f.indicator.update();
  assert.equal(f.indicators().length, 0);
  f.setVideo(f.video);
  f.indicator.update();
  f.video.remove();
  f.indicator.update();
  assert.equal(f.indicators().length, 0);
  f.player.appendChild(f.video);
  f.indicator.update();
  const old = f.indicators()[0];
  f.player.remove();
  f.indicator.update();
  assert.equal(old.parentElement, null);
});

test("replacement video in the same player and replacement player remove the old indicator", () => {
  const f = fixture();
  f.indicator.update();
  const old = f.indicators()[0];
  const replacement = f.document.createElement("video");
  Object.assign(replacement, { playbackRate: 1.5, paused: false, ended: false, seeking: false, readyState: 4 });
  f.player.appendChild(replacement);
  f.setVideo(replacement);
  f.indicator.update();
  assert.equal(old.parentElement, null);
  assert.equal(f.indicators().length, 1);
  const second = f.indicators()[0];
  const player = new Element("div", f.document, "pzp-pc");
  f.document.body.appendChild(player);
  player.appendChild(replacement);
  f.indicator.update();
  assert.equal(second.parentElement, null);
  assert.equal(f.indicators()[0].parentElement, player);
});

test("removed indicator is replaced and duplicate factories keep one indicator", () => {
  const f = fixture();
  f.indicator.update();
  const initial = f.indicators()[0];
  initial.remove();
  f.indicator.update();
  assert.equal(f.indicators().length, 1);
  assert.notEqual(f.indicators()[0], initial);
  const original = f.indicators()[0];
  const duplicate = new Element("span", f.document, "chzzk-catchup-rate-indicator");
  f.player.appendChild(duplicate);
  const next = create(f.options);
  next.update();
  assert.equal(f.indicators().length, 1);
  assert.equal(f.indicators()[0], original);
});

test("only recognized native player roots host indicators and destroy prevents recreation", () => {
  const unrecognized = fixture("ordinary-page-video");
  unrecognized.indicator.update();
  assert.equal(unrecognized.indicators().length, 0);
  const fallback = fixture("pzp");
  fallback.indicator.update();
  assert.equal(fallback.indicators().length, 1);
  fallback.indicator.destroy();
  fallback.indicator.update();
  assert.equal(fallback.indicators().length, 0);
});
