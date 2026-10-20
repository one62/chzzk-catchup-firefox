"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Small DOM fixture for the public player's bottom-control structure. This
// verifies attachment and lifecycle, not Firefox rendering or hover styling.
class Element {
  constructor(tag, document, className = "") {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.className = className;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.ownText = "";
    this.listeners = new Map();
  }
  get isConnected() {
    return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected);
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(""); }
  set textContent(value) {
    this.ownText = value;
    for (const node of [...this.children]) node.remove();
  }
  getAttribute(name) { return this.attributes[name] || null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, next) {
    if (next === node) return node;
    node.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    if (index < 0) throw new Error("insertBefore target must be a child");
    this.children.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value.startsWith(".")) return this.className.split(/\s+/).includes(value.slice(1));
      if (value === "[role='button']") return this.attributes.role === "button";
      return this.tagName.toLowerCase() === value;
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

function fixture() {
  const document = { createElement: (tag) => new Element(tag, document) };
  document.body = document.createElement("body");
  const player = new Element("div", document, "pzp-pc");
  document.body.appendChild(player);
  const video = document.createElement("video");
  player.appendChild(video);
  const controls = new Element("div", document, "pzp-pc__bottom-buttons-left");
  player.appendChild(controls);
  const native = new Element("button", document, "live_time");
  native.textContent = "실시간";
  controls.appendChild(native);
  const volume = new Element("button", document, "pzp-pc__volume-control");
  controls.appendChild(volume);
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/player-label.js"), "utf8"), context);
  let currentVideo = video;
  let latency = 1.234;
  let buffer = 2.345;
  let connection = null;
  const label = context.ChzzkCatchupLabel.create({
    getVideo: () => currentVideo, getLatency: () => latency, getBuffer: () => buffer,
    getConnection: () => connection,
  });
  return { document, player, video, controls, native, volume, context, label,
    setVideo: (value) => { currentVideo = value; },
    setLatency: (value) => { latency = value; },
    setBuffer: (value) => { buffer = value; },
    setConnection: (value) => { connection = value; },
    labels: () => player.querySelectorAll(".chzzk-catchup-latency") };
}

test("player label is a native-control sibling and preserves the live button", () => {
  const f = fixture();
  const click = () => {};
  f.native.addEventListener("click", click);
  const original = f.native.textContent;
  f.label.update();
  assert.equal(f.labels().length, 1);
  const label = f.labels()[0];
  assert.equal(f.native.nextSibling, label);
  assert.equal(label.nextSibling, f.volume);
  assert.equal(label.textContent, "지연 1.23초 · 버퍼 2.35초");
  assert.equal(label.parentElement, f.controls);
  assert.equal(f.native.textContent, original);
  assert.equal(f.native.listeners.get("click"), click);
  assert.match(label.style.cssText, /pointer-events:none/);
  assert.doesNotMatch(label.style.cssText, /position:(fixed|absolute)/);
  assert.equal(label.matches(".live_time"), true);
  assert.doesNotMatch(label.style.cssText, /(?:^|;)(?:display|opacity|transition(?:-[a-z-]+)?):/);
  assert.match(label.title, /5초 평균.*버퍼/);
});

test("updates reuse one label, update numbers, and show unavailable latency distinctly", () => {
  const f = fixture();
  f.label.update();
  const initial = f.labels()[0];
  for (let i = 0; i < 5; i += 1) f.label.update();
  assert.equal(f.labels().length, 1);
  assert.equal(f.labels()[0], initial);
  f.setLatency(0);
  f.label.update();
  assert.equal(initial.textContent, "지연 0.00초 · 버퍼 2.35초");
  for (const unavailable of [null, undefined, NaN, Infinity, -1, "2"]) {
    f.setLatency(unavailable);
    f.label.update();
    assert.equal(initial.textContent, "지연 — · 버퍼 2.35초");
  }
});

test("replaced native controls get a new label and old controls are cleaned", () => {
  const f = fixture();
  f.label.update();
  const oldLabel = f.labels()[0];
  f.controls.remove();
  const nextControls = new Element("div", f.document, "pzp-pc__bottom-buttons-left");
  const nextNative = new Element("button", f.document, "live_time");
  nextNative.textContent = "실시간";
  nextControls.appendChild(nextNative);
  f.player.appendChild(nextControls);
  f.label.update();
  assert.equal(oldLabel.parentElement, null);
  assert.equal(f.labels().length, 1);
  assert.equal(f.labels()[0].parentElement, nextControls);
  assert.equal(nextNative.nextSibling, f.labels()[0]);
});

test("replaced live badge relocates the existing label without modifying native text", () => {
  const f = fixture();
  f.label.update();
  const initial = f.labels()[0];
  f.native.remove();
  const nextNative = new Element("button", f.document, "live_time");
  nextNative.textContent = "실시간";
  f.controls.appendChild(nextNative);
  f.label.update();
  assert.equal(f.labels().length, 1);
  assert.equal(nextNative.nextSibling, initial);
  assert.equal(nextNative.textContent, "실시간");
});

test("null video, detached video, missing live badge, and destroy remove the label", () => {
  const f = fixture();
  f.label.update();
  f.setVideo(null);
  f.label.update();
  assert.equal(f.labels().length, 0);
  f.setVideo(f.video);
  f.label.update();
  f.video.remove();
  f.label.update();
  assert.equal(f.labels().length, 0);
  f.player.appendChild(f.video);
  f.label.update();
  f.native.remove();
  f.label.update();
  assert.equal(f.labels().length, 0);
  f.controls.appendChild(f.native);
  f.label.update();
  f.label.destroy();
  f.label.update();
  assert.equal(f.labels().length, 0);
});

test("nested live badge keeps button contents untouched and label outside the button", () => {
  const f = fixture();
  f.native.className = "native-live-button";
  f.native.textContent = "";
  const badge = new Element("span", f.document, "live_time");
  badge.textContent = "실시간";
  f.native.appendChild(badge);
  f.label.update();
  assert.equal(f.native.nextSibling, f.labels()[0]);
  assert.equal(f.native.children.length, 1);
  assert.equal(f.native.children[0], badge);
});

test("a repeated factory reuses the owned class and cleans duplicates", () => {
  const f = fixture();
  f.label.update();
  const original = f.labels()[0];
  const duplicate = new Element("span", f.document, "chzzk-catchup-latency");
  f.controls.appendChild(duplicate);
  const next = f.context.ChzzkCatchupLabel.create({
    getVideo: () => f.video, getLatency: () => 2,
  });
  next.update();
  assert.equal(f.labels().length, 1);
  assert.equal(f.labels()[0], original);
  assert.equal(original.textContent, "지연 2.00초 · 버퍼 —");
});

test("fallback requires a semantic live control and never targets external page text", () => {
  const f = fixture();
  f.native.remove();
  const external = new Element("span", f.document, "live_time");
  external.textContent = "실시간";
  f.player.appendChild(external);
  f.label.update();
  assert.equal(f.labels().length, 0);
  const native = new Element("button", f.document, "pzp-pc__live-time");
  native.textContent = "실시간";
  f.controls.appendChild(native);
  f.label.update();
  assert.equal(native.nextSibling, f.labels()[0]);
  assert.equal(f.labels()[0].matches(".pzp-pc__live-time"), true);
  assert.equal(f.labels()[0].matches(".live_time"), false);
});

test("an accessible live button with whitespace-only contents is an eligible fallback", () => {
  const f = fixture();
  f.native.className = "native-live-button";
  f.native.textContent = "  ";
  f.native.setAttribute("aria-label", "실시간");
  f.label.update();
  assert.equal(f.labels().length, 1);
  assert.equal(f.native.nextSibling, f.labels()[0]);
  assert.equal(f.native.textContent, "  ");
});

test("native control visibility class remains in charge across hover and fullscreen states", () => {
  const f = fixture();
  f.label.update();
  const label = f.labels()[0];
  for (const state of ["pzp-pc", "pzp-pc pzp-pc--controls",
    "pzp-pc pzp-pc--fullscreen pzp-pc--controls", "pzp-pc pzp-pc--fullscreen"]) {
    f.player.className = state;
    f.label.update();
    assert.equal(f.labels()[0], label);
    assert.equal(label.matches(".live_time"), true);
    assert.doesNotMatch(label.style.cssText, /(?:^|;)(?:display|opacity|transition(?:-[a-z-]+)?):/);
  }
});

test("a label sharing live_time cannot become its own anchor after the live control disappears", () => {
  const f = fixture();
  f.label.update();
  const label = f.labels()[0];
  assert.equal(label.matches(".live_time"), true);
  f.native.remove();
  f.label.update();
  assert.equal(f.labels().length, 0);
  assert.equal(label.parentElement, null);
});

test("a replacement fallback control changes the shared visibility class on the existing label", () => {
  const f = fixture();
  f.label.update();
  const label = f.labels()[0];
  f.native.className = "pzp-pc__live-time";
  f.label.update();
  assert.equal(f.labels()[0], label);
  assert.equal(label.matches(".pzp-pc__live-time"), true);
  assert.equal(label.matches(".live_time"), false);
  assert.equal(f.native.nextSibling, label);
});

test("buffer is shown independently without averaging or substituting player latency", () => {
  const f = fixture();
  f.label.update();
  const label = f.labels()[0];
  f.setBuffer(0);
  f.label.update();
  assert.equal(label.textContent, "지연 1.23초 · 버퍼 0.00초");
  f.setBuffer(9.876);
  f.label.update();
  assert.equal(label.textContent, "지연 1.23초 · 버퍼 9.88초");
  f.setLatency(null);
  f.label.update();
  assert.equal(label.textContent, "지연 — · 버퍼 9.88초");
  for (const unavailable of [null, undefined, NaN, Infinity, -1, "2"]) {
    f.setBuffer(unavailable);
    f.label.update();
    assert.equal(label.textContent, "지연 — · 버퍼 —");
  }
});

test("native text typography is copied and reacts to native font changes without shifting position", () => {
  const f = fixture();
  f.native.textContent = "";
  const nativeText = new Element("span", f.document, "live_time_text");
  nativeText.textContent = "실시간";
  f.native.appendChild(nativeText);
  const metrics = { fontFamily: "Native Player Font", fontSize: "13px", fontWeight: "500",
    fontStyle: "normal", lineHeight: "16px", letterSpacing: "0.1px" };
  f.document.defaultView = { getComputedStyle: (node) => {
    assert.equal(node, nativeText);
    return metrics;
  } };
  f.label.update();
  const label = f.labels()[0];
  for (const [name, value] of Object.entries(metrics)) assert.equal(label.style[name], value);
  assert.doesNotMatch(label.style.cssText, /(?:^|;)(?:top|bottom|position|transform):/);
  metrics.fontSize = "14px";
  metrics.lineHeight = "18px";
  f.label.update();
  assert.equal(label.style.fontSize, "14px");
  assert.equal(label.style.lineHeight, "18px");
  assert.equal(f.native.textContent, "실시간");
});

test("source typography provides a matching fallback when computed style is unavailable", () => {
  const f = fixture();
  f.label.update();
  assert.match(f.labels()[0].style.cssText, /font-size:13px;line-height:16px/);
});

test("connection kind appears beside latency and buffer on the same fading native label", () => {
  const f = fixture();
  f.setConnection("LL-HLS · P2P");
  f.label.update();
  assert.equal(f.labels()[0].textContent, "지연 1.23초 · 버퍼 2.35초 · LL-HLS · P2P");
  assert.equal(f.labels()[0].matches(".live_time"), true);
  f.setConnection("HLS");
  f.label.update();
  assert.equal(f.labels().length, 1);
  assert.match(f.labels()[0].textContent, / · HLS$/);
});
