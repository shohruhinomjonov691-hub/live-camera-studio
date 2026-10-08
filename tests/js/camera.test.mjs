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
        if (key === "createImageData") {
          return (w, h) => {
            canvas.ops.push([key, w, h]);
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          };
        }
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
  // Every createWorker() call returns a new fake worker, like `new Worker()`.
  const workers = [];
  const makeWorker = () => ({
    posted: [],
    terminated: false,
    postMessage(msg) { this.posted.push(msg); },
    terminate() { this.terminated = true; },
    reply(msg) { this.onmessage({ data: msg }); },
  });
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
    createWorker: () => {
      const created = makeWorker();
      workers.push(created);
      return created;
    },
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
    camera, env, captured, states, timers, bitmapRequests, workers,
    get worker() {
      return workers.at(-1);
    },
    buffer: () => made[0],
    foreground: () => made[2],
    maskCanvas: () => made[3],
    bgSmall: () => made[4],
    detects: () => workers.at(-1).posted.filter((m) => m.type === "detect"),
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
    lastDetect: () => workers.at(-1).posted.filter((m) => m.type === "detect").at(-1),
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

// ---------- 2-batch: glasses effect and snapshots ----------

const EYES = [{ rOuter: { x: 100, y: 120 }, rInner: { x: 130, y: 121 }, lInner: { x: 170, y: 122 }, lOuter: { x: 200, y: 123 } }];
const FACE = [{ x: 90, y: 80, w: 120, h: 140 }];
const glassesOps = (canvas) => canvas.ops.filter((op) => op[0] === "arcTo").length;
const firstIndex = (canvas, name) => canvas.ops.findIndex((op) => op[0] === name);

async function liveWithGlasses(h, { ready = true } = {}) {
  h.camera.setSettings({ glasses: true });
  await goLive(h);
  assert.ok(h.worker.posted.some((m) => m.type === "init-landmarker"), "landmarker requested with the worker");
  if (ready) h.worker.reply({ type: "landmarker-ready", initMs: 1 });
}

function reply(h, msg, extra = {}) {
  h.worker.reply({ type: "result", session: msg.session, frameId: msg.frameId, faces: FACE, inferMs: 5, eyes: null, landmarksError: null, ...extra });
}

test("[g] glasses use the landmarks of the same frame; blur is off while glasses are on", async () => {
  const h = setup();
  await liveWithGlasses(h);
  assert.equal(h.camera.settings.blurOn, false, "glasses ON turns face blur OFF");
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.landmarks, true, "landmarks requested for this frame");
  const frame = h.captured.at(-1);
  reply(h, msg, { eyes: EYES });
  const buffer = h.buffer();
  const frameDraw = buffer.ops.findIndex((op) => op[0] === "drawImage" && op[1] === frame);
  assert.ok(frameDraw >= 0, "the captured frame is the base layer");
  assert.ok(frameDraw < firstIndex(buffer, "arcTo"), "glasses over the frame");
  assert.equal(firstIndex(buffer, "clip"), -1, "no blur while glasses are on");
  assert.equal(h.state(), "live");
  assert.equal(frame.closed, true);
});

test("[g] with blur off the glasses are visible and nothing is blurred", async () => {
  const h = setup();
  h.camera.setSettings({ blurOn: false });
  await liveWithGlasses(h);
  await h.runFrame();
  reply(h, h.lastDetect(), { eyes: EYES });
  assert.ok(glassesOps(h.buffer()) > 0);
  assert.equal(firstIndex(h.buffer(), "clip"), -1);
});

test("[g] before the landmarker is ready no landmarks are requested or drawn", async () => {
  const h = setup();
  await liveWithGlasses(h, { ready: false });
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.landmarks, false);
  reply(h, msg, { eyes: EYES }); // even if a worker sent eyes, they are not used for this frame
  assert.equal(glassesOps(h.buffer()), 0);
  assert.equal(h.camera.effect, "loading");
});

test("[g] a landmarker that fails to load turns glasses off and face blur back on (fail closed)", async () => {
  const h = setup();
  await liveWithGlasses(h, { ready: false });
  await showFrame(h, FACE); // an unblurred frame is on screen (glasses mode)
  h.worker.reply({ type: "landmarker-error", message: "model blocked" });
  assert.equal(h.camera.effect, "error");
  assert.deepEqual(plain({ glasses: h.camera.settings.glasses, blurOn: h.camera.settings.blurOn }), { glasses: false, blurOn: true });
  assert.ok(cleared(h.env.view) && cleared(h.buffer()), "the unblurred frame is wiped at once");
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "pending" }]);
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.landmarks, false);
  reply(h, msg);
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0, "blur applied");
  // Turning the effect on again retries the landmarker.
  h.camera.setSettings({ glasses: true });
  assert.equal(h.worker.posted.filter((m) => m.type === "init-landmarker").length, 2);
});

test("[g] a landmark error in a result fails closed: this frame is blurred, glasses off", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  reply(h, h.lastDetect(), { eyes: null, landmarksError: "graph failed" });
  assert.equal(h.camera.effect, "error");
  assert.equal(h.camera.settings.blurOn, true);
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0, "the same frame is blurred");
  await h.runFrame();
  assert.equal(h.lastDetect().landmarks, false, "no more landmark requests after the error");
});

test("[g] an exception while drawing glasses blurs that frame and closes it", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  const frame = h.captured.at(-1);
  h.buffer().throwOn = "arcTo";
  reply(h, h.lastDetect(), { eyes: EYES });
  assert.equal(h.camera.effect, "error");
  assert.equal(h.camera.settings.blurOn, true);
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0, "blur applied to the frame whose effect failed");
  assert.equal(frame.closed, true);
});

test("[g] switching glasses off while a frame is in flight: its landmarks are not drawn", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  const msg = h.lastDetect();
  h.camera.setSettings({ glasses: false });
  reply(h, msg, { eyes: EYES });
  assert.equal(glassesOps(h.buffer()), 0);
  await h.runFrame();
  assert.equal(h.lastDetect().landmarks, false);
});

test("[g] landmarks of a timed-out frame are never drawn; frames are released", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  const stale = h.lastDetect();
  h.fireTimers(1000);
  reply(h, stale, { eyes: EYES });
  assert.equal(glassesOps(h.buffer()), 0);
  assert.equal(viewDraws(h.env.view).length, 0);
  await showFrame(h, FACE);
  assert.ok(h.captured.every((b) => b.closed), "every captured bitmap is closed");
});

test("[g] no face while glasses are on: the frame is shown unblurred (faces visible by choice)", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  reply(h, h.lastDetect(), { faces: [], eyes: EYES });
  assert.equal(h.state(), "live");
  assert.equal(firstIndex(h.buffer(), "clip"), -1);
});

test("[g] restarting the detector reloads the landmarker for the new worker", async () => {
  const h = setup();
  await liveWithGlasses(h);
  h.camera.restartDetector();
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.camera.effect, "loading");
  assert.equal(h.worker.posted.filter((m) => m.type === "init-landmarker").length, 1, "new worker loads it");
});

test("[s] snapshot copies only the visible processed canvas, without boxes", async () => {
  const h = setup();
  await goLive(h);
  await showFrame(h, FACE);
  const shot = h.camera.snapshot();
  assert.ok(shot);
  assert.deepEqual([shot.width, shot.height], [h.env.view.width, h.env.view.height]);
  const draws = shot.ops.filter((op) => op[0] === "drawImage");
  assert.equal(draws.length, 1);
  assert.equal(draws[0][1], h.env.view, "source is the visible processed canvas");
  assert.ok(!shot.ops.some((op) => op[1] === h.env.overlay || op[1] === h.env.video), "no boxes, never the raw video");
  assert.equal(shot.ops.some((op) => op[0] === "scale"), false);
});

test("[s] a mirrored preview gives a mirrored snapshot", async () => {
  const h = setup();
  await goLive(h);
  await showFrame(h, FACE);
  const shot = h.camera.snapshot({ mirror: true });
  const names = shot.ops.map((op) => op[0]);
  assert.deepEqual(plain(shot.ops.find((op) => op[0] === "translate")), ["translate", h.env.view.width, 0]);
  assert.deepEqual(plain(shot.ops.find((op) => op[0] === "scale")), ["scale", -1, 1]);
  assert.ok(names.indexOf("scale") < names.indexOf("drawImage"));
});

test("[s] no snapshot while loading, pending, hidden, timed out, in error or stopped", async () => {
  const h = setup();
  h.camera.start();
  await flush();
  assert.equal(h.camera.snapshot(), null, "prompt");
  h.gum().resolve(fakeStream());
  await flush();
  h.worker.reply({ type: "ready", initMs: 1 });
  await flush();
  await flush();
  assert.equal(h.camera.snapshot(), null, "loading");

  await showFrame(h, FACE);
  assert.ok(h.camera.canSnapshot(), "live");
  await h.runFrame();
  assert.ok(h.camera.canSnapshot(), "pending keeps the last processed frame on screen");
  h.fireTimers(1000);
  assert.equal(h.camera.snapshot(), null, "timed out");

  await showFrame(h, []);
  assert.equal(h.camera.snapshot(), null, "hidden: no face");

  await showFrame(h, FACE);
  h.camera.setSettings({ blurOn: false });
  h.camera.setSettings({ blurOn: true });
  assert.equal(h.camera.snapshot(), null, "pending after blur re-enabled");

  await showFrame(h, FACE);
  await h.runFrame();
  const msg = h.lastDetect();
  h.worker.reply({ type: "error", stage: "detect", session: msg.session, frameId: msg.frameId, message: "x" });
  assert.equal(h.camera.snapshot(), null, "error");

  h.camera.stop();
  assert.equal(h.camera.snapshot(), null, "stopped");
});

// ---------- Codex review of 2-batch (2026-10-08) ----------

test("[w] messages from a replaced worker cannot change the new worker's state", async () => {
  const h = setup();
  await liveWithGlasses(h, { ready: false });
  const old = h.workers[0];
  h.camera.restartDetector();
  assert.equal(h.camera.effect, "loading");

  old.reply({ type: "landmarker-ready", initMs: 1 }); // late delivery from the terminated worker
  assert.equal(h.camera.effect, "loading", "old worker cannot mark the new landmarker ready");
  old.reply({ type: "landmarker-error", message: "late" });
  assert.equal(h.camera.effect, "loading");
  old.reply({ type: "ready", initMs: 1 });
  old.onerror({ message: "late crash" });
  assert.notEqual(h.state(), "error", "old worker errors are ignored");

  h.worker.reply({ type: "landmarker-ready", initMs: 1 });
  assert.equal(h.camera.effect, "ready", "the current worker still can");
});

// ---------- UX: glasses and face blur are exclusive ----------

const mode = (h) => plain({ glasses: h.camera.settings.glasses, blurOn: h.camera.settings.blurOn });

test("[ux] glasses ON -> blur OFF; blur ON -> glasses OFF; glasses OFF leaves blur OFF", () => {
  const h = setup();
  assert.deepEqual(mode(h), { glasses: false, blurOn: true });
  h.camera.setSettings({ glasses: true });
  assert.deepEqual(mode(h), { glasses: true, blurOn: false });
  h.camera.setSettings({ glasses: false });
  assert.deepEqual(mode(h), { glasses: false, blurOn: false }, "turning glasses off does not re-enable blur");
  h.camera.setSettings({ glasses: true });
  h.camera.setSettings({ blurOn: true });
  assert.deepEqual(mode(h), { glasses: false, blurOn: true });
  h.camera.setSettings({ glasses: true, blurOn: true });
  assert.deepEqual(mode(h), { glasses: false, blurOn: true }, "if both are asked for, blur wins");
});

test("[ux] a blurred frame in flight is not drawn after glasses turn blur off", async () => {
  const h = setup();
  await goLive(h);
  await showFrame(h, FACE);
  await h.runFrame(); // captured with blur on
  const stale = h.lastDetect();
  h.camera.setSettings({ glasses: true });
  h.worker.reply({ type: "landmarker-ready", initMs: 1 });
  const draws = viewDraws(h.env.view).length;
  reply(h, stale, { eyes: EYES });
  assert.equal(viewDraws(h.env.view).length, draws, "result from the old mode is dropped");
  assert.ok(h.pendingFrames() >= 1);
  await h.runFrame();
  const fresh = h.lastDetect();
  assert.equal(fresh.landmarks, true);
  reply(h, fresh, { eyes: EYES });
  assert.ok(glassesOps(h.buffer()) > 0);
});

test("[ux] blur ON while a glasses frame is in flight: canvas wiped at once, old result dropped", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await showFrame(h, FACE); // unblurred glasses frame on screen
  await h.runFrame();
  const stale = h.lastDetect();
  const staleFrame = h.captured.at(-1);
  h.camera.setSettings({ blurOn: true });
  assert.ok(cleared(h.env.view) && cleared(h.env.overlay) && cleared(h.buffer()));
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "pending" }]);
  assert.equal(staleFrame.closed, true);
  assert.equal(h.camera.snapshot(), null, "no snapshot while pending");
  const draws = viewDraws(h.env.view).length;
  reply(h, stale, { eyes: EYES });
  assert.equal(viewDraws(h.env.view).length, draws, "the glasses-mode result never reaches the screen");
  await h.runFrame();
  const fresh = h.lastDetect();
  assert.equal(fresh.landmarks, false);
  reply(h, fresh);
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0);
  assert.equal(glassesOps(h.buffer()), 0);
});

// ---------- Codex review: effect failure inside compose ----------

test("[p1] glasses ON, zero faces, drawing fails: blur comes back and the frame is hidden, not shown", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await showFrame(h, FACE); // a glasses frame (blur off) is on screen
  await h.runFrame();
  const msg = h.lastDetect();
  const frame = h.captured.at(-1);
  const viewDrawsBefore = viewDraws(h.env.view).length;
  h.buffer().throwOn = "arcTo";
  reply(h, msg, { faces: [], eyes: EYES });
  h.buffer().throwOn = null;

  assert.equal(h.camera.settings.blurOn, true, "fallback turned blur on");
  assert.equal(h.camera.settings.glasses, false);
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "noface" }]);
  assert.equal(viewDraws(h.env.view).length, viewDrawsBefore, "the unblurred buffer never reaches the view");
  assert.ok(cleared(h.env.view) && cleared(h.env.overlay) && cleared(h.buffer()));
  assert.equal(h.camera.canSnapshot(), false);
  assert.equal(h.camera.snapshot(), null);
  assert.equal(frame.closed, true);

  await showFrame(h, FACE); // recovers with the next frame, blurred
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0);
  assert.ok(h.captured.every((b) => b.closed));
});

test("[p1] control: glasses ON, a face, drawing fails: the same frame is shown blurred", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  h.buffer().throwOn = "arcTo";
  reply(h, h.lastDetect(), { faces: FACE, eyes: EYES });
  h.buffer().throwOn = null;
  assert.equal(h.state(), "live");
  assert.ok(firstIndex(h.buffer(), "clip") >= 0, "blurred");
  assert.ok(h.camera.canSnapshot());
});

test("[p1] control: glasses ON, zero faces, no error: the frame is shown (blur off by choice)", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  reply(h, h.lastDetect(), { faces: [], eyes: EYES });
  assert.equal(h.state(), "live");
  assert.equal(h.camera.settings.blurOn, false);
  assert.ok(glassesOps(h.buffer()) > 0);
});

test("[p1] control: landmark error in a zero-face result is hidden too (fallback before compose)", async () => {
  const h = setup();
  await liveWithGlasses(h);
  await h.runFrame();
  reply(h, h.lastDetect(), { faces: [], eyes: null, landmarksError: "graph failed" });
  assert.equal(h.camera.settings.blurOn, true);
  assert.equal(h.state(), "hidden");
  assert.equal(h.camera.canSnapshot(), false);
});

// ---------- 3-batch: background blur / image ----------

const fullMask = (w = 640, h = 480, value = 200) => ({ width: w, height: h, alpha: new Uint8ClampedArray(w * h).fill(value) });
const fakeImage = (w = 800, h = 600) => ({ width: w, height: h, closed: false, close() { this.closed = true; } });

async function liveWithBackground(h, { mode = "blur", ready = true, image = null } = {}) {
  if (image) h.camera.setBackgroundImage(image);
  h.camera.setSettings({ background: mode });
  await goLive(h);
  assert.ok(h.worker.posted.some((m) => m.type === "init-segmenter"), "segmenter requested with the worker");
  if (ready) h.worker.reply({ type: "segmenter-ready", initMs: 1 });
}

function replyBg(h, msg, extra = {}) {
  h.worker.reply({
    type: "result", session: msg.session, frameId: msg.frameId, faces: FACE, inferMs: 5,
    eyes: null, landmarksError: null, mask: fullMask(), maskError: null, ...extra,
  });
}

async function bgFrame(h, extra = {}) {
  await h.runFrame();
  const msg = h.lastDetect();
  replyBg(h, msg, extra);
  return msg;
}

test("[bg] blur: mask of the same frame; background -> foreground -> face blur", async () => {
  const h = setup();
  await liveWithBackground(h);
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.segment, true);
  const frame = h.captured.at(-1);
  replyBg(h, msg);
  assert.equal(h.state(), "live");
  const buf = h.buffer();
  const iBg = buf.ops.findIndex((op) => op[0] === "drawImage" && op[1] === h.bgSmall());
  const iFg = buf.ops.findIndex((op) => op[0] === "drawImage" && op[1] === h.foreground());
  const iBlur = firstIndex(buf, "clip");
  assert.ok(iBg >= 0 && iFg > iBg && iBlur > iFg, `order bg ${iBg} < fg ${iFg} < face blur ${iBlur}`);
  assert.ok(h.bgSmall().ops.some((op) => op[0] === "drawImage" && op[1] === frame), "background from this frame");
  assert.ok(h.foreground().ops.some((op) => op[0] === "drawImage" && op[1] === frame), "foreground from this frame");
  assert.ok(h.foreground().ops.some((op) => op[0] === "drawImage" && op[1] === h.maskCanvas()), "cut out by this mask");
  assert.ok(!buf.ops.some((op) => op[0] === "drawImage" && op[1] === frame), "the raw frame is never drawn whole");
  assert.equal(frame.closed, true);
});

test("[bg] glasses with a background: glasses over the foreground, no face blur", async () => {
  const h = setup();
  h.camera.setSettings({ glasses: true });
  await liveWithBackground(h);
  h.worker.reply({ type: "landmarker-ready", initMs: 1 });
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.landmarks && msg.segment, true, "landmarks and mask for the same frame");
  replyBg(h, msg, { eyes: EYES });
  const buf = h.buffer();
  const iFg = buf.ops.findIndex((op) => op[0] === "drawImage" && op[1] === h.foreground());
  assert.ok(iFg >= 0 && firstIndex(buf, "arcTo") > iFg);
  assert.equal(firstIndex(buf, "clip"), -1);
});

test("[bg] background changes never change the blur or glasses choice", () => {
  const h = setup();
  h.camera.setSettings({ glasses: true });
  for (const background of ["blur", "off", "blur"]) {
    h.camera.setSettings({ background });
    assert.deepEqual(mode(h), { glasses: true, blurOn: false });
  }
  h.camera.setSettings({ blurOn: true });
  h.camera.setSettings({ background: "off", bgBlur: 3 });
  assert.deepEqual(mode(h), { glasses: false, blurOn: true });
});

test("[bg] image mode needs an image; only one mode at a time; removing the image turns it off", () => {
  const h = setup();
  h.camera.setSettings({ background: "image" });
  assert.equal(h.camera.background.mode, "off", "no image yet: image mode refused");
  const image = fakeImage();
  h.camera.setBackgroundImage(image);
  h.camera.setSettings({ background: "image" });
  assert.equal(h.camera.background.mode, "image");
  h.camera.setSettings({ background: "blur" });
  assert.equal(h.camera.background.mode, "blur");
  h.camera.setSettings({ background: "image" });
  h.camera.setBackgroundImage(null);
  assert.equal(image.closed, true);
  assert.equal(h.camera.background.mode, "off");
  h.camera.setSettings({ background: "sepia" });
  assert.equal(h.camera.background.mode, "off", "unknown modes are ignored");
});

test("[bg] while the segmenter loads the preview stays hidden; it opens once masks arrive", async () => {
  const h = setup();
  await liveWithBackground(h, { ready: false });
  await h.runFrame();
  const early = h.lastDetect();
  assert.equal(early.segment, false);
  replyBg(h, early, { mask: null });
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "bgLoading" }]);
  assert.equal(viewDraws(h.env.view).length, 0, "nothing shown without a mask");
  assert.equal(h.camera.canSnapshot(), false);
  h.worker.reply({ type: "segmenter-ready", initMs: 1 });
  await bgFrame(h);
  assert.equal(h.state(), "live");
});

test("[bg] segmenter error: hidden at once, snapshot blocked; Retry or background OFF recovers", async () => {
  const h = setup();
  await liveWithBackground(h);
  await bgFrame(h);
  assert.equal(h.state(), "live");
  h.worker.reply({ type: "segmenter-error", message: "model blocked" });
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "bgError" }]);
  assert.ok(cleared(h.env.view) && cleared(h.buffer()));
  assert.equal(h.camera.snapshot(), null);
  await h.runFrame();
  const msg = h.lastDetect();
  assert.equal(msg.segment, false);
  replyBg(h, msg, { mask: null });
  assert.equal(h.state(), "hidden", "the real background is not shown");

  h.camera.retryBackground();
  assert.equal(h.worker.posted.filter((m) => m.type === "init-segmenter").length, 2);
  h.worker.reply({ type: "segmenter-ready", initMs: 1 });
  await bgFrame(h);
  assert.equal(h.state(), "live", "retry recovers");

  h.worker.reply({ type: "segmenter-error", message: "again" });
  h.camera.setSettings({ background: "off" });
  await showFrame(h, FACE);
  assert.equal(h.state(), "live", "background OFF recovers");
});

test("[bg] an invalid or missing mask hides that frame", async () => {
  const h = setup();
  await liveWithBackground(h);
  for (const bad of [null, fullMask(640, 240), { width: 640, height: 480, alpha: new Uint8ClampedArray(10) }, { width: 0, height: 0, alpha: new Uint8ClampedArray(0) }]) {
    await h.runFrame();
    replyBg(h, h.lastDetect(), { mask: bad, maskError: bad ? null : "no person mask" });
    assert.equal(h.state(), "hidden", JSON.stringify(bad && [bad.width, bad.height]));
    assert.ok(cleared(h.env.view));
  }
  await bgFrame(h, { mask: fullMask(320, 240) }); // same aspect, smaller: fine
  assert.equal(h.state(), "live");
});

test("[bg] a result for a frame captured before a background change is dropped", async () => {
  const h = setup();
  await goLive(h);
  await showFrame(h, FACE);
  await h.runFrame(); // captured with background off
  const stale = h.lastDetect();
  const staleFrame = h.captured.at(-1);
  h.camera.setSettings({ background: "blur" });
  h.worker.reply({ type: "segmenter-ready", initMs: 1 });
  assert.deepEqual(plain(h.states.at(-1)), ["hidden", { why: "bgPending" }]);
  assert.ok(cleared(h.env.view));
  assert.equal(staleFrame.closed, true);
  const draws = viewDraws(h.env.view).length;
  replyBg(h, stale);
  assert.equal(viewDraws(h.env.view).length, draws, "stale success ignored");
  h.worker.reply({ type: "error", stage: "detect", session: stale.session, frameId: stale.frameId, message: "late" });
  assert.notEqual(h.state(), "error", "stale error ignored");
  await bgFrame(h);
  assert.equal(h.state(), "live");
});

test("[bg] every background setting change wipes, drops the job and blocks snapshots until a new frame", async () => {
  const h = setup();
  const image = fakeImage();
  h.camera.setBackgroundImage(image);
  await liveWithBackground(h);
  const changes = [
    { bgBlur: 3 },
    { background: "image" },
    { mirror: false }, // matters for an image background
    { background: "off" },
  ];
  for (const change of changes) {
    await bgFrame(h);
    assert.ok(h.camera.canSnapshot(), "before the change");
    await h.runFrame();
    const inFlight = h.captured.at(-1);
    h.camera.setSettings(change);
    assert.equal(h.camera.canSnapshot(), false, JSON.stringify(change));
    assert.ok(cleared(h.env.view), JSON.stringify(change));
    assert.equal(inFlight.closed, true);
  }
  // A new image replaces the old one (closed) and also counts as a change.
  h.camera.setSettings({ background: "image" });
  await bgFrame(h);
  const next = fakeImage(640, 480);
  h.camera.setBackgroundImage(next);
  assert.equal(image.closed, true);
  assert.equal(h.camera.canSnapshot(), false);
  await bgFrame(h);
  assert.ok(h.camera.canSnapshot());
});

test("[bg] mirror: an image background is drawn flipped so the mirrored preview shows it the right way", async () => {
  const h = setup();
  const image = fakeImage();
  await liveWithBackground(h, { mode: "image", image });
  await bgFrame(h);
  let ops = h.buffer().ops;
  let iImage = ops.findIndex((op) => op[0] === "drawImage" && op[1] === image);
  assert.ok(iImage > 0);
  assert.deepEqual(plain(ops.slice(0, iImage).filter((op) => op[0] === "scale").at(-1)), ["scale", -1, 1]);

  h.camera.setSettings({ mirror: false });
  await bgFrame(h);
  ops = h.buffer().ops;
  const last = ops.findLastIndex((op) => op[0] === "drawImage" && op[1] === image);
  const lastScale = ops.slice(0, last).findLastIndex((op) => op[0] === "scale");
  const lastClear = ops.slice(0, last).findLastIndex((op) => op[0] === "clearRect");
  assert.ok(lastScale < lastClear, "no flip in this frame when the preview is not mirrored");
});

test("[bg] timeout with a background, then recovery", async () => {
  const h = setup();
  await liveWithBackground(h);
  await h.runFrame();
  const stale = h.lastDetect();
  h.fireTimers(1000);
  assert.equal(h.state(), "hidden");
  replyBg(h, stale);
  assert.equal(h.state(), "hidden", "late mask ignored");
  await bgFrame(h);
  assert.equal(h.state(), "live");
});

test("[bg] Stop -> Start keeps the segmenter; a late result of the old session is ignored", async () => {
  const h = setup();
  await liveWithBackground(h);
  await h.runFrame();
  const old = h.lastDetect();
  h.camera.stop();
  await goLive(h);
  const draws = viewDraws(h.env.view).length;
  replyBg(h, old);
  assert.equal(viewDraws(h.env.view).length, draws);
  await bgFrame(h);
  assert.equal(h.state(), "live");
  assert.ok(h.captured.every((b) => b.closed));
});

test("[bg] restart: the new worker loads the segmenter again; the old worker cannot mark it ready", async () => {
  const h = setup();
  await liveWithBackground(h, { ready: false });
  const old = h.workers[0];
  h.camera.restartDetector();
  assert.equal(h.camera.background.segmenter, "loading");
  old.reply({ type: "segmenter-ready", initMs: 1 });
  assert.equal(h.camera.background.segmenter, "loading");
  assert.equal(h.worker.posted.filter((m) => m.type === "init-segmenter").length, 1);
});

test("[bg] dispose stops the camera and closes the background image", async () => {
  const h = setup();
  const image = fakeImage();
  const stream = fakeStream();
  h.camera.setBackgroundImage(image);
  await liveWithBackground(h, { mode: "image" });
  h.camera.dispose();
  assert.equal(image.closed, true);
  assert.equal(h.state(), "idle");
  assert.equal(h.camera.background.hasImage, false);
  void stream;
});

test("[bg] a mask is used only if it was asked for that very frame", async () => {
  const h = setup();
  await liveWithBackground(h, { ready: false });
  await h.runFrame();
  const early = h.lastDetect(); // captured before the segmenter was ready: no mask asked for
  assert.equal(early.segment, false);
  h.worker.reply({ type: "segmenter-ready", initMs: 1 });
  replyBg(h, early); // even if a mask comes back with it
  assert.equal(h.state(), "hidden");
  assert.equal(viewDraws(h.env.view).length, 0);
});
