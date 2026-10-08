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
    this.readyState = 4;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  replaceChildren() { this.children = []; }
  getContext() {
    const element = this;
    element.ops ||= [];
    element.width ||= 0;
    element.height ||= 0;
    return (element.ctx ||= new Proxy(
      { canvas: element },
      {
        get: (target, key) => (key in target ? target[key] : (...args) => element.ops.push([key, ...args])),
        set: (target, key, value) => {
          target[key] = value;
          return true;
        },
      },
    ));
  }
  play() { return Promise.resolve(); }
  pause() {}
  append(...nodes) { this.children.push(...nodes); }
}

function loadShell({ realCamera = false } = {}) {
  const elements = new Map();
  // Fake camera pipeline for the real controller: stream, worker, bitmaps, frame callbacks, timers.
  const media = { workers: [], frames: [], timers: [], bitmaps: [], canvases: [] };
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
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
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    Worker: class {
      constructor() {
        this.posted = [];
        media.workers.push(this);
      }
      postMessage(msg) { this.posted.push(msg); }
      terminate() { this.terminated = true; }
    },
    createImageBitmap: async (source) => {
      const bitmap = { width: 640, height: 480, source, closed: false, close() { this.closed = true; } };
      media.bitmaps.push(bitmap);
      return bitmap;
    },
    requestAnimationFrame: (fn) => media.frames.push(fn),
    cancelAnimationFrame: (id) => (media.frames[id - 1] = null),
    setTimeout: (fn, ms) => media.timers.push({ fn, ms }),
    clearTimeout: () => {},
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
    ...(realCamera ? {} : { createCameraController: () => camera }),
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
      createElement: () => {
        const element = new FakeElement();
        media.canvases.push(element);
        return element;
      },
      createElementNS: () => new FakeElement(),
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
  };
  context.window = context;
  vm.createContext(context);
  const files = ["i18n/en.js", "i18n/ko.js", "i18n.js", ...(realCamera ? ["camera.js"] : []), "shell.js"];
  for (const file of files) vm.runInContext(read(file), context);
  return {
    context,
    urls,
    el: (selector) => elements.get(selector),
    encode: () => pendingBlob({ size: 123, type: "image/png" }),
    fire: (type) => (windowListeners[type] || []).forEach((fn) => fn()),
    media,
    track,
    toggle: (selector, checked) => {
      const element = elements.get(selector);
      element.checked = checked;
      element.listeners.change.forEach((fn) => fn({ target: element }));
    },
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

// ---------- UX: glasses and face blur toggles (real camera controller) ----------

const EN = (key) => {
  const context = { window: {} };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read("i18n/en.js"), context);
  return context.LCS_I18N.en[key];
};

test("[ux] toggles and notes follow the real settings: glasses ON turns blur OFF and says faces are visible", () => {
  const h = loadShell({ realCamera: true });
  assert.equal(h.el("#t-blur").checked, true);
  assert.equal(h.el("#t-glasses").checked, false);
  assert.equal(h.el("#effect-blur-note").textContent, EN("effects.exclusive"));

  h.toggle("#t-glasses", true);
  assert.equal(h.el("#t-glasses").checked, true);
  assert.equal(h.el("#t-blur").checked, false, "blur toggle shows OFF");
  assert.equal(h.el("#blur-off-warn").hidden, false, "privacy panel warns that faces are visible");
  assert.equal(h.el("#effect-blur-note").textContent, EN("effects.faceVisible"));

  h.toggle("#t-glasses", false);
  assert.equal(h.el("#t-blur").checked, false, "glasses OFF does not turn blur back on");
  assert.equal(h.el("#blur-off-warn").hidden, false);
  assert.equal(h.el("#effect-blur-note").textContent, EN("effects.exclusive"));
});

test("[ux] blur ON turns glasses OFF; Privacy turns glasses OFF and blur ON", () => {
  const h = loadShell({ realCamera: true });
  h.toggle("#t-glasses", true);
  h.toggle("#t-blur", true);
  assert.equal(h.el("#t-glasses").checked, false);
  assert.equal(h.el("#t-blur").checked, true);
  assert.equal(h.el("#blur-off-warn").hidden, true);

  h.toggle("#t-glasses", true);
  h.context.liveCameraShell.selectMode("privacy");
  assert.equal(h.el("#t-glasses").checked, false, "privacy turns glasses off");
  assert.equal(h.el("#t-blur").checked, true, "privacy turns face blur on");
  assert.equal(h.el("#blur-off-warn").hidden, true);

  // Turning glasses off yourself still leaves blur off.
  h.toggle("#t-glasses", true);
  h.toggle("#t-glasses", false);
  assert.equal(h.el("#t-blur").checked, false);
  // Privacy also turns blur on when glasses were already off.
  h.context.liveCameraShell.selectMode("privacy");
  assert.equal(h.el("#t-blur").checked, true);
});

test("[ux] the face-visible note is translated", () => {
  const h = loadShell({ realCamera: true });
  h.toggle("#t-glasses", true);
  h.context.i18n.setLang("ko");
  assert.equal(h.el("#effect-blur-note").textContent, "안경이 켜져 있어 얼굴 블러가 꺼져 있습니다. 미리보기와 스냅샷에 얼굴이 그대로 보입니다.");
});

// ---------- Privacy while streaming: real controller + shell + fake camera/worker ----------

const flush = () => new Promise((r) => setImmediate(r));

async function goLiveInShell(h) {
  h.el("#cam-toggle").listeners.click.forEach((fn) => fn());
  await flush();
  await flush();
  const worker = h.media.workers.at(-1);
  worker.onmessage({ data: { type: "ready", initMs: 1 } });
  await flush();
  await flush();
  return worker;
}

async function nextFrame(h, worker) {
  const fn = h.media.frames.find(Boolean);
  h.media.frames[h.media.frames.indexOf(fn)] = null;
  fn();
  await flush();
  await flush();
  return worker.posted.filter((m) => m.type === "detect").at(-1);
}

const FACES = [{ x: 100, y: 100, w: 120, h: 140 }];
const EYES = [{ rOuter: { x: 110, y: 150 }, rInner: { x: 140, y: 150 }, lInner: { x: 180, y: 150 }, lOuter: { x: 210, y: 150 } }];
const lastOp = (canvas) => canvas.ops.at(-1)[0];
const drawCount = (canvas) => canvas.ops.filter((op) => op[0] === "drawImage").length;

test("[ux] Privacy while glasses are on: blur ON, canvases wiped at once, old frame dropped, blurred frame reopens", async () => {
  const h = loadShell({ realCamera: true });
  const worker = await goLiveInShell(h);
  const view = h.el("#cam-view");
  const overlay = h.el("#cam-overlay");
  const buffer = h.media.canvases[0]; // the controller's offscreen buffer

  let msg = await nextFrame(h, worker);
  worker.onmessage({ data: { type: "result", session: msg.session, frameId: msg.frameId, faces: FACES, inferMs: 5 } });
  assert.equal(h.context.liveCamera.state, "live");

  h.toggle("#t-glasses", true); // blur goes off
  worker.onmessage({ data: { type: "landmarker-ready", initMs: 1 } });
  msg = await nextFrame(h, worker);
  worker.onmessage({ data: { type: "result", session: msg.session, frameId: msg.frameId, faces: FACES, eyes: EYES, landmarksError: null } });
  assert.equal(h.el("#chip-bluroff").hidden, false, "HUD says faces are visible");

  const pending = await nextFrame(h, worker); // a glasses-mode frame is in flight
  assert.equal(pending.landmarks, true);

  h.context.liveCameraShell.selectMode("privacy");
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.liveCamera.settings)).blurOn, true);
  assert.equal(h.context.liveCamera.settings.glasses, false);
  assert.equal(h.el("#t-blur").checked, true);
  assert.equal(h.el("#t-glasses").checked, false);
  for (const canvas of [view, overlay, buffer]) assert.equal(lastOp(canvas), "clearRect", "wiped at once");
  assert.equal(h.context.liveCamera.state, "hidden");
  assert.equal(h.el("#ov-hidden").hidden, false, "preview covered while waiting");
  assert.equal(h.el("#chip-bluroff").hidden, true);
  assert.equal(h.context.liveCamera.canSnapshot(), false);

  const draws = drawCount(view);
  worker.onmessage({ data: { type: "result", session: pending.session, frameId: pending.frameId, faces: FACES, eyes: EYES, landmarksError: null } });
  assert.equal(drawCount(view), draws, "the old glasses-mode frame never reaches the screen");

  const fresh = await nextFrame(h, worker);
  assert.equal(fresh.landmarks, false);
  worker.onmessage({ data: { type: "result", session: fresh.session, frameId: fresh.frameId, faces: FACES, inferMs: 5 } });
  assert.equal(h.context.liveCamera.state, "live");
  assert.equal(h.el("#ov-hidden").hidden, true, "preview reopens with the blurred frame");
  assert.ok(buffer.ops.some((op) => op[0] === "clip"), "the new frame is blurred");
  assert.equal(drawCount(view), draws + 1);
  // Frames the controller keeps (captured from the video) are all released; copies are closed by the worker.
  const frames = h.media.bitmaps.filter((b) => b.source === h.el("#cam-video"));
  assert.ok(frames.length >= 4 && frames.every((b) => b.closed));
});

test("[ux] the Privacy texts follow the language", () => {
  const h = loadShell({ realCamera: true });
  h.context.i18n.setLang("ko");
  assert.equal(
    h.el("#effect-blur-note").textContent,
    "안경과 얼굴 블러는 함께 사용할 수 없습니다. 안경을 켜면 얼굴 블러가 꺼지고, 프라이버시를 열면 얼굴 블러가 켜지고 안경이 꺼집니다. 안경을 직접 끄면 블러는 자동으로 다시 켜지지 않습니다.",
  );
  h.toggle("#t-glasses", true);
  h.context.liveCameraShell.selectMode("privacy");
  assert.equal(h.el("#effect-blur-note").textContent.startsWith("안경과 얼굴 블러는"), true);
});

// ---------- Codex review: the effect-failure message stays visible ----------

test("[p2] after an effect failure the alert stays, survives re-renders and language, and clears only on dismiss or retry", async () => {
  const h = loadShell({ realCamera: true });
  const worker = await goLiveInShell(h);
  h.toggle("#t-glasses", true);
  assert.equal(h.el("#effect-alert").hidden, true);

  worker.onmessage({ data: { type: "landmarker-error", message: "model blocked" } });
  assert.equal(h.el("#t-glasses").checked, false, "glasses were turned off automatically");
  assert.equal(h.el("#t-blur").checked, true, "blur came back");
  assert.equal(h.el("#effect-alert").hidden, false, "the failure is announced");
  assert.equal(h.el("#effect-alert-text").textContent, EN("effects.error"));

  // Ordinary renders do not hide it.
  h.context.liveCameraShell.selectMode("effects");
  h.context.liveCameraShell.selectMode("privacy");
  h.el("#t-glasses-size").value = "110";
  h.el("#t-glasses-size").listeners.input.forEach((fn) => fn({ target: h.el("#t-glasses-size") }));
  assert.equal(h.el("#effect-alert").hidden, false);
  h.context.i18n.setLang("ko");
  assert.equal(h.el("#effect-alert-text").textContent, "안경 효과가 작동하지 않아 얼굴 블러를 다시 켰습니다.");

  // Dismiss clears it.
  h.el("#effect-alert-dismiss").listeners.click.forEach((fn) => fn());
  assert.equal(h.el("#effect-alert").hidden, true);

  // A new failure shows it again; an explicit retry (turning glasses on) clears it.
  h.toggle("#t-glasses", true);
  worker.onmessage({ data: { type: "landmarker-error", message: "again" } });
  assert.equal(h.el("#effect-alert").hidden, false);
  h.toggle("#t-glasses", true);
  assert.equal(h.el("#effect-alert").hidden, true);
});

test("[p2] a landmarker error while glasses are already off does not claim blur was turned back on", async () => {
  const h = loadShell({ realCamera: true });
  const worker = await goLiveInShell(h);
  h.toggle("#t-glasses", true);
  h.toggle("#t-glasses", false); // the user turned glasses off; blur stays off
  worker.onmessage({ data: { type: "landmarker-error", message: "late" } });
  assert.equal(h.el("#effect-alert").hidden, true);
  assert.equal(h.el("#t-blur").checked, false);
});
