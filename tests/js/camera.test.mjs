// Regression tests for the live camera controller (app/static/camera.js): fail-closed pipeline and lifecycle.
// Everything is faked (camera, worker, bitmaps, canvases, timers): these tests prove the control logic,
// not real face detection. Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const CAMERA_JS = readFileSync(new URL("../../app/static/camera.js", import.meta.url), "utf8");
const flush = () => new Promise((r) => setImmediate(r));
// Objects created inside the vm context have other prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeCanvas(name) {
  const canvas = { name, width: 0, height: 0, ops: [] };
  const ctx = new Proxy(
    { canvas },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => canvas.ops.push([key, ...args]);
      },
      set(target, key, value) {
        target[key] = value;
        canvas.ops.push(["set", key, value]);
        return true;
      },
    },
  );
  canvas.getContext = () => ctx;
  return canvas;
}

let bitmapSeq = 0;
function fakeBitmap(label) {
  return { id: `${label}#${++bitmapSeq}`, width: 640, height: 480, closed: false, close() { this.closed = true; } };
}

function fakeStream() {
  const track = {
    stopped: false,
    listeners: {},
    stop() { this.stopped = true; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    emit(type) { this.listeners[type]?.(); },
  };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function setup({ secure = true } = {}) {
  const timers = [];
  const frames = [];
  const captured = [];
  const states = [];
  let gum;
  const worker = {
    posted: [],
    terminated: false,
    postMessage(msg) { this.posted.push(msg); },
    terminate() { this.terminated = true; },
    reply(msg) { this.onmessage({ data: msg }); },
  };
  const env = {
    video: { srcObject: null, readyState: 4, paused: true, play: async function () { this.paused = false; }, pause() { this.paused = true; } },
    view: fakeCanvas("view"),
    overlay: fakeCanvas("overlay"),
    makeCanvas: () => fakeCanvas("offscreen"),
    isSecureContext: secure,
    mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => (gum = { resolve, reject })) },
    createWorker: () => worker,
    createImageBitmap: async (source) => {
      const bitmap = fakeBitmap(source === env.video ? "frame" : `copy-of-${source.id}`);
      if (source === env.video) captured.push(bitmap);
      else bitmap.copyOf = source;
      return bitmap;
    },
    requestFrame: (fn) => frames.push(fn) - 1,
    cancelFrame: (id) => (frames[id] = null),
    setTimeout: (fn, ms) => timers.push({ fn, ms, done: false }) - 1,
    clearTimeout: (id) => id != null && timers[id] && (timers[id].done = true),
    now: () => 1000 + timers.length,
    onState: (state, info) => states.push([state, info]),
  };
  const context = {
    console,
    fetch: () => {
      throw new Error("camera code must not make network requests");
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CAMERA_JS, context);
  const camera = context.createCameraController(env);

  return {
    camera, env, worker, captured, states, timers,
    gum: () => gum,
    state: () => camera.state,
    async runFrame() {
      const index = frames.findIndex((fn) => fn);
      assert.ok(index >= 0, "a frame should be scheduled");
      const fn = frames[index];
      frames[index] = null;
      fn();
      await flush();
    },
    pendingFrames: () => frames.filter(Boolean).length,
    fireTimers(ms) {
      timers.forEach((t) => { if (!t.done && t.ms <= ms) { t.done = true; t.fn(); } });
    },
    lastDetect: () => worker.posted.filter((m) => m.type === "detect").at(-1),
  };
}

async function goLive(h, stream = fakeStream()) {
  h.camera.start();
  await flush();
  h.gum().resolve(stream);
  await flush();
  h.worker.reply({ type: "ready", initMs: 1 });
  await flush();
  await flush();
  return stream;
}

const viewDraws = (canvas) => canvas.ops.filter((op) => op[0] === "drawImage");
const lastOp = (canvas) => canvas.ops.at(-1)[0];

test("detection and blur use the very same captured frame", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  const frame = h.captured.at(-1);
  assert.equal(msg.bitmap.copyOf, frame, "the detector gets a copy of the captured frame");

  const drawsBefore = viewDraws(h.env.view).length;
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 100, y: 100, w: 80, h: 80 }], inferMs: 5 });
  assert.equal(h.state(), "live");
  assert.equal(viewDraws(h.env.view).length, drawsBefore + 1);
  // The offscreen buffer was painted with exactly that frame before it was copied to the view.
  const bufferDraws = h.env.view.ops.filter((op) => op[0] === "drawImage").map((op) => op[1]);
  assert.equal(bufferDraws.at(-1).name, "offscreen");
  assert.equal(frame.closed, true, "the frame is released after compositing");

  // While the next frame is being detected nothing new is drawn: the view keeps the processed frame.
  await h.runFrame();
  const drawsWhilePending = viewDraws(h.env.view).length;
  await flush();
  assert.equal(viewDraws(h.env.view).length, drawsWhilePending);
});

test("the composited frame is the captured one, never a newer video frame", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  const frame = h.captured.at(-1);
  // Find the offscreen buffer by the frame drawn into it.
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 10, y: 10, w: 50, h: 50 }] });
  const viewSource = viewDraws(h.env.view).at(-1)[1];
  const bufferFrameDraw = viewSource.ops.find((op) => op[0] === "drawImage" && op[1] && op[1].id);
  assert.equal(bufferFrameDraw[1], frame);
  assert.equal(h.captured.length, 1, "no other frame was captured for this result");
});

test("zero faces with blur on clears the canvas and hides the frame", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  let msg = h.lastDetect();
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  await h.runFrame();
  msg = h.lastDetect();
  const frame = h.captured.at(-1);
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [] });
  assert.equal(h.state(), "hidden");
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "noface" }]);
  assert.equal(lastOp(h.env.view), "clearRect", "the previous processed frame is wiped too");
  assert.equal(lastOp(h.env.overlay), "clearRect");
  assert.equal(frame.closed, true);
});

test("with blur off a frame without faces is still shown (user choice)", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [] });
  assert.equal(h.state(), "live");
  assert.equal(viewDraws(h.env.view).length, 1);
});

test("a slow detector hides the frame after the pending timeout", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const before = h.env.view.ops.length;
  h.fireTimers(1000);
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "timeout" }]);
  assert.equal(h.env.view.ops.length, before + 1);
  assert.equal(lastOp(h.env.view), "clearRect");
});

test("results for an older frame id are ignored", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId - 1, faces: [{ x: 1, y: 1, w: 9, h: 9 }] });
  assert.equal(viewDraws(h.env.view).length, 0);
  assert.equal(h.state(), "loading");
});

test("stop releases camera, frame, loop and canvas; a late result is dropped", async () => {
  const h = setup();
  const stream = await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  const frame = h.captured.at(-1);

  h.camera.stop();
  assert.equal(stream.track.stopped, true);
  assert.equal(h.env.video.srcObject, null);
  assert.equal(frame.closed, true);
  assert.equal(lastOp(h.env.view), "clearRect");
  assert.equal(h.state(), "idle");

  const drawsAfterStop = viewDraws(h.env.view).length;
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(viewDraws(h.env.view).length, drawsAfterStop, "late result after stop must not draw");
  assert.equal(h.pendingFrames(), 0, "render loop stopped");
});

test("a stream that arrives after Cancel is closed at once", async () => {
  const h = setup();
  h.camera.start();
  await flush();
  assert.equal(h.state(), "prompt");
  h.camera.stop();
  const late = fakeStream();
  h.gum().resolve(late);
  await flush();
  assert.equal(late.track.stopped, true);
  assert.equal(h.env.video.srcObject, null);
  assert.equal(h.state(), "idle");
});

test("stopping while a frame is being captured drops that frame", async () => {
  const h = setup();
  await goLive(h);
  const index = h.pendingFrames();
  assert.equal(index, 1);
  // Start the tick but stop before the async capture finishes.
  const tick = h.runFrame();
  h.camera.stop();
  await tick;
  await flush();
  assert.ok(h.captured.every((b) => b.closed), "captured bitmaps are closed");
  assert.equal(h.worker.posted.filter((m) => m.type === "detect").length, 0);
});

test("track ended stops the camera and the loop", async () => {
  const h = setup();
  const stream = await goLive(h);
  stream.track.emit("ended");
  assert.equal(h.state(), "ended");
  assert.equal(stream.track.stopped, true);
  assert.equal(h.env.video.srcObject, null);
  assert.equal(h.pendingFrames(), 0);
});

test("stop with reason 'hidden' (page hidden) is reported for the paused message", async () => {
  const h = setup();
  await goLive(h);
  h.camera.stop("hidden");
  assert.deepEqual(plain(h.states.at(-1)), ["idle", { reason: "hidden" }]);
});

test("a detector error clears the canvas and shows the error state", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  let msg = h.lastDetect();
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  await h.runFrame();
  msg = h.lastDetect();
  const frame = h.captured.at(-1);
  h.worker.reply({ type: "error", stage: "detect", session: msg.session, frameId: msg.frameId, message: "boom" });
  assert.deepEqual(plain(h.states.at(-1)), ["error", { kind: "detector" }]);
  assert.equal(lastOp(h.env.view), "clearRect");
  assert.equal(frame.closed, true);
  assert.equal(h.pendingFrames(), 0);
});

test("a detector that fails to load leads to the error state, not a raw preview", async () => {
  const h = setup();
  h.camera.start();
  await flush();
  h.gum().resolve(fakeStream());
  await flush();
  h.worker.reply({ type: "error", stage: "init", message: "wasm blocked" });
  await flush();
  await flush();
  assert.deepEqual(plain(h.states.at(-1)), ["error", { kind: "detector" }]);
  assert.equal(viewDraws(h.env.view).length, 0);
  assert.equal(h.worker.terminated, true);
});

test("permission and device errors map to their states", async () => {
  for (const [name, expected] of [["NotAllowedError", "denied"], ["NotFoundError", "nocam"], ["NotReadableError", "nocam"], ["TypeError", "error"]]) {
    const h = setup();
    h.camera.start();
    await flush();
    h.gum().reject(Object.assign(new Error(name), { name }));
    await flush();
    assert.equal(h.state(), expected, name);
  }
});

test("an insecure page never asks for the camera", () => {
  const h = setup({ secure: false });
  h.camera.start();
  assert.equal(h.state(), "insecure");
  assert.equal(h.gum(), undefined);
});

test("face boxes are padded by 25% and clipped to the frame", () => {
  const context = { console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CAMERA_JS, context);
  const box = context.liveCameraInternals.boxFor;
  assert.deepEqual(plain(box({ x: 100, y: 100, w: 100, h: 100 }, 640, 480)), { x: 75, y: 75, w: 150, h: 150 });
  assert.deepEqual(plain(box({ x: -10, y: 400, w: 100, h: 100 }, 640, 480)), { x: 0, y: 375, w: 115, h: 105 });
  assert.equal(box({ x: 700, y: 10, w: 10, h: 10 }, 640, 480), null);
});
