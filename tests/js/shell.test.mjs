// The page shell's snapshot flow (app/static/shell.js) with a minimal fake DOM and a fake camera controller.
// Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../app/static/${path}`, import.meta.url), "utf8");

class FakeElement {
  constructor() {
    this.listeners = {};
    this.attrs = {};
    this.children = [];
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.dataset = {};
    this.offsetWidth = 0;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  replaceChildren() { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
}

function loadShell() {
  const elements = new Map();
  const windowListeners = {};
  const urls = { created: [], revoked: [] };
  let pendingBlob = null;
  const camera = {
    settings: { blurOn: true, showBoxes: true, method: "pixel", strength: 3, glasses: false, glassesSize: 100, facingMode: "user" },
    active: true,
    state: "live",
    stop() { this.active = false; },
    snapshot() {
      return { width: 640, height: 480, toBlob: (callback) => (pendingBlob = callback) };
    },
    setSettings() {},
  };
  const context = {
    console,
    navigator: { mediaDevices: {} },
    isSecureContext: true,
    performance,
    URL: {
      createObjectURL: () => {
        const url = `blob:${urls.created.length + 1}`;
        urls.created.push(url);
        return url;
      },
      revokeObjectURL: (url) => urls.revoked.push(url),
    },
    createCameraController: () => camera,
    addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn),
    document: {
      documentElement: {},
      title: "",
      visibilityState: "visible",
      querySelector: (selector) => {
        if (!elements.has(selector)) elements.set(selector, new FakeElement());
        return elements.get(selector);
      },
      querySelectorAll: () => [],
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["i18n/en.js", "i18n/ko.js", "i18n.js", "shell.js"]) vm.runInContext(read(file), context);
  return {
    context,
    urls,
    el: (selector) => elements.get(selector),
    encode: () => pendingBlob({ size: 123, type: "image/png" }),
    fire: (type) => (windowListeners[type] || []).forEach((fn) => fn()),
  };
}

test("a snapshot is added, offered for download and revoked on pagehide", async () => {
  const h = loadShell();
  const pending = h.context.liveCameraShell.takeSnapshot();
  h.encode();
  await pending;
  assert.equal(h.context.liveCameraShell.snapshots().length, 1);
  assert.deepEqual(h.urls.created, ["blob:1"]);
  assert.equal(h.el("#snap-toast").hidden, false);

  h.fire("pagehide");
  assert.equal(h.context.liveCameraShell.snapshots().length, 0);
  assert.deepEqual(h.urls.revoked, ["blob:1"]);
});

test("a snapshot still being encoded at pagehide is discarded", async () => {
  const h = loadShell();
  const toastHiddenBefore = h.el("#snap-toast").hidden;
  const pending = h.context.liveCameraShell.takeSnapshot();
  h.fire("pagehide"); // the page goes away while toBlob is still running
  h.encode();
  await pending;
  assert.equal(h.context.liveCameraShell.snapshots().length, 0, "not added back to the list");
  assert.deepEqual(h.urls.created, [], "no blob URL is created after cleanup");
  assert.equal(h.el("#snap-toast").hidden, toastHiddenBefore, "no toast reopened");
});
