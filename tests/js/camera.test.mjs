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
        return (...args) => {
          if (canvas.throwOn === key) throw new Error(`${key} failed`);
          canvas.ops.push([key, ...args]);
        };
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

function setup({ secure = true, deferBitmaps = false } = {}) {
  const made = [];
  const bitmapRequests = [];
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
    makeCanvas: () => {
      const canvas = fakeCanvas("offscreen");
      made.push(canvas);
      return canvas;
    },
    isSecureContext: secure,
    mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => (gum = { resolve, reject })) },
    createWorker: () => worker,
    createImageBitmap: (source) => {
      const bitmap = fakeBitmap(source === env.video ? "frame" : `copy-of-${source.id}`);
      if (source === env.video) captured.push(bitmap);
      else bitmap.copyOf = source;
      if (!deferBitmaps) return Promise.resolve(bitmap);
      return new Promise((resolve) => bitmapRequests.push({ source, bitmap, resolve: () => resolve(bitmap) }));
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
    camera, env, worker, captured, states, timers, bitmapRequests,
    buffer: () => made[0],
    detects: () => worker.posted.filter((m) => m.type === "detect"),
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

// ---------- Codex review (2026-10-08) regressions ----------

async function showFrame(h, faces = [{ x: 100, y: 100, w: 80, h: 80 }]) {
  await h.runFrame();
  const msg = h.lastDetect();
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces, inferMs: 5 });
  return msg;
}
const cleared = (canvas) => canvas.ops.at(-1)[0] === "clearRect";

test("[1] turning blur back on wipes view, overlay and buffer at once", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await goLive(h);
  await showFrame(h, []); // an unblurred frame is on screen (allowed while blur is off)
  assert.equal(h.state(), "live");

  h.camera.setSettings({ blurOn: true });
  assert.ok(cleared(h.env.view) && cleared(h.env.overlay) && cleared(h.buffer()));
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "pending" }]);
});

test("[1] a frame captured while blur was off is never shown after blur is turned on", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await goLive(h);
  await showFrame(h, []);
  await h.runFrame(); // frame captured with blur off, result pending
  const pending = h.lastDetect();
  const frame = h.captured.at(-1);

  h.camera.setSettings({ blurOn: true });
  const draws = viewDraws(h.env.view).length;
  h.worker.reply({ type: "result", session: pending.session, frameId: pending.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(viewDraws(h.env.view).length, draws, "result of the off-frame is ignored");
  assert.equal(frame.closed, true);

  // Only a frame captured and processed with blur on reopens the preview.
  await showFrame(h);
  assert.equal(h.state(), "live");
  assert.ok(h.buffer().ops.some((op) => op[0] === "clip"), "the new frame was blurred");
});

test("[1] a timeout that fired while blur was off cannot leave a raw frame up after turning blur on", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await goLive(h);
  await showFrame(h, []);
  await h.runFrame();
  h.fireTimers(1000); // deadline while blur off: frame dropped, view untouched (allowed)
  h.camera.setSettings({ blurOn: true });
  assert.ok(cleared(h.env.view));
  assert.equal(h.state(), "hidden");
  assert.ok(h.pendingFrames() >= 1, "the pipeline continues with a new frame");
});

test("[2] the late result of a timed-out frame is dropped; the next new frame recovers", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const stale = h.lastDetect();
  const staleFrame = h.captured.at(-1);
  h.fireTimers(1000);
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "timeout" }]);
  assert.equal(staleFrame.closed, true);

  h.worker.reply({ type: "result", session: stale.session, frameId: stale.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(h.state(), "hidden", "a result older than the deadline must not reopen the preview");
  assert.equal(viewDraws(h.env.view).length, 0);

  await showFrame(h); // pipeline is not stuck busy
  assert.equal(h.detects().length, 2);
  assert.equal(h.state(), "live");
});

test("[3] the deadline counts from capture start: a stuck capture hides the preview", async () => {
  const h = setup({ deferBitmaps: true });
  await goLive(h);
  await h.runFrame(); // createImageBitmap(video) never resolves
  assert.equal(h.bitmapRequests.length, 1);
  h.fireTimers(1000);
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "timeout" }]);
  assert.ok(cleared(h.env.view));

  h.bitmapRequests[0].resolve(); // returns after the deadline
  await flush();
  assert.equal(h.bitmapRequests[0].bitmap.closed, true, "late bitmap is closed");
  assert.equal(h.bitmapRequests.length, 1, "no copy is started for a timed-out frame");
  assert.equal(h.detects().length, 0);
  assert.ok(h.pendingFrames() >= 1, "a new frame is scheduled");
});

test("[3] Stop before the first bitmap returns: it is closed and no copy is started", async () => {
  const h = setup({ deferBitmaps: true });
  await goLive(h);
  await h.runFrame();
  h.camera.stop();
  h.bitmapRequests[0].resolve();
  await flush();
  assert.equal(h.bitmapRequests[0].bitmap.closed, true);
  assert.equal(h.bitmapRequests.length, 1);
  assert.equal(h.detects().length, 0);
});

test("[3] Stop while the copy is pending: both bitmaps are closed, nothing is sent", async () => {
  const h = setup({ deferBitmaps: true });
  await goLive(h);
  await h.runFrame();
  h.bitmapRequests[0].resolve();
  await flush(); // now waiting for the copy
  assert.equal(h.bitmapRequests.length, 2);
  h.camera.stop();
  assert.equal(h.bitmapRequests[0].bitmap.closed, true, "frame closed by Stop");
  h.bitmapRequests[1].resolve();
  await flush();
  assert.equal(h.bitmapRequests[1].bitmap.closed, true, "late copy closed");
  assert.equal(h.detects().length, 0);
});

test("[4] a compose error closes the frame and fails closed", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  const frame = h.captured.at(-1);
  h.env.view.throwOn = "drawImage";
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(frame.closed, true);
  assert.deepEqual(plain(h.states.at(-1)), ["error", { kind: "render" }]);
  assert.ok(cleared(h.env.view) && cleared(h.env.overlay) && cleared(h.buffer()));
  assert.equal(h.pendingFrames(), 0);
  h.env.view.throwOn = null;
  h.camera.stop(); // and Stop afterwards is clean
  assert.ok(h.captured.every((b) => b.closed));
});

test("[5] small boxes are really reduced, so no original pixel survives without canvas filters", () => {
  const context = { console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CAMERA_JS, context);
  const { obscure } = context.liveCameraInternals;
  for (const method of ["pixel", "gauss"]) {
    for (const strength of [1, 2, 3]) {
      for (const size of [6, 10, 24]) {
        const target = fakeCanvas("frame");
        const scratch = fakeCanvas("scratch");
        obscure(target.getContext("2d"), scratch, { x: 5, y: 5, w: size, h: size }, method, strength);
        assert.ok(scratch.width * 3 <= size, `${method}/${strength}/${size}: scratch ${scratch.width}px is not a reduction`);
        // Everything painted back into the box comes from the reduced copy, never the original canvas.
        const paints = target.ops.filter((op) => op[0] === "drawImage");
        assert.ok(paints.length > 0 && paints.every((op) => op[1] === scratch));
      }
    }
  }
});

test("onResult ignores a result whose frame id matches but whose session is old", async () => {
  const h = setup();
  await goLive(h);
  const oldSession = (await (async () => { await h.runFrame(); return h.lastDetect().session; })());
  h.camera.stop();
  await goLive(h);
  await h.runFrame();
  const current = h.lastDetect();
  assert.notEqual(current.session, oldSession);
  h.worker.reply({ type: "result", session: oldSession, frameId: current.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(viewDraws(h.env.view).length, 0, "same frame id, old session: ignored");
  h.worker.reply({ type: "result", session: current.session, frameId: current.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(viewDraws(h.env.view).length, 1);
});

test("after Stop and restart the pipeline is not left busy", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  h.camera.stop();
  await goLive(h);
  await showFrame(h);
  assert.equal(h.state(), "live");
});

// ---------- Codex re-review (2026-10-08) regressions ----------

test("[r1] blur OFF -> ON while the first frame is still pending keeps the stream going", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await goLive(h);
  await h.runFrame(); // first frame in flight, still "loading"
  assert.equal(h.state(), "loading");

  h.camera.setSettings({ blurOn: true });
  assert.equal(h.state(), "loading");
  assert.ok(h.pendingFrames() >= 1, "a new frame is scheduled, the loop did not stall");
  await showFrame(h);
  assert.equal(h.state(), "live");
  assert.equal(h.detects().length, 2);
});

test("[r2] a late detect error from a timed-out frame does not cancel the next frame", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const stale = h.lastDetect();
  h.fireTimers(1000); // frame 1 times out
  await h.runFrame(); // frame 2 in flight
  const current = h.lastDetect();
  const frame2 = h.captured.at(-1);
  assert.notEqual(current.frameId, stale.frameId);

  h.worker.reply({ type: "error", stage: "detect", session: stale.session, frameId: stale.frameId, message: "late" });
  assert.notEqual(h.state(), "error");
  assert.equal(frame2.closed, false, "frame 2 is still in the pipeline");

  h.worker.reply({ type: "result", session: current.session, frameId: current.frameId, faces: [{ x: 1, y: 1, w: 50, h: 50 }] });
  assert.equal(h.state(), "live");
  assert.equal(frame2.closed, true);
});

test("[r2] a detect error for the current frame still fails closed", async () => {
  const h = setup();
  await goLive(h);
  await h.runFrame();
  const msg = h.lastDetect();
  h.worker.reply({ type: "error", stage: "detect", session: msg.session, frameId: msg.frameId, message: "boom" });
  assert.deepEqual(plain(h.states.at(-1)), ["error", { kind: "detector" }]);
});

test("[r3] every box size is either really reduced or filled solid (incl. 1×1 and thin boxes)", () => {
  const context = { console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CAMERA_JS, context);
  const { obscure } = context.liveCameraInternals;
  const sizes = [];
  for (let n = 1; n <= 40; n++) sizes.push([n, n], [n, 1], [1, n], [n, 3], [3, n], [n, 4]);
  for (const method of ["pixel", "gauss"]) {
    for (const strength of [1, 2, 3]) {
      for (const [w, h] of sizes) {
        const target = fakeCanvas("frame");
        const scratch = fakeCanvas("scratch");
        obscure(target.getContext("2d"), scratch, { x: 0, y: 0, w, h }, method, strength);
        const paints = target.ops.filter((op) => op[0] === "drawImage");
        const filled = target.ops.some((op) => op[0] === "fillRect");
        const label = `${method}/${strength}/${w}x${h}`;
        if (filled) {
          assert.equal(paints.length, 0, `${label}: filled box must not also redraw pixels`);
        } else {
          assert.ok(scratch.width * 2 <= w && scratch.height * 2 <= h, `${label}: scratch ${scratch.width}x${scratch.height} is not a reduction`);
          assert.ok(paints.every((op) => op[1] === scratch), `${label}: only the reduced copy is painted`);
        }
      }
    }
  }
});
