// The detector worker (app/static/detector-worker.mjs + detector-core.mjs) with MediaPipe replaced by fakes that
// consume and clear self.ModuleFactory the way the vendored bundle does. Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const CORE = readFileSync(new URL("../../app/static/detector-core.mjs", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../../app/static/detector-worker.mjs", import.meta.url), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

function loadWorker({ failLandmarker = false, maskValues = null, offscreen = true, iosChromeUA = false, brokenLandmarkers = 0, mainThread = false } = {}) {
  const posted = [];
  const created = [];
  const options = [];
  const fileArgs = [];
  const context = { console, performance, posted, transfers: [] };
  if (offscreen) {
    context.OffscreenCanvas = class OffscreenCanvas {
      constructor(width, height) {
        Object.assign(this, { width, height });
      }
    };
  }
  context.self = context;
  if (mainThread) context.document = {}; // a page has a document, a worker does not
  context.postMessage = (msg, transfer) => {
    posted.push(msg);
    context.transfers.push(transfer || []);
  };

  // Like the bundle: wait for the loader, require self.ModuleFactory, consume it and clear it.
  const closed = [];
  const task = (kind) => ({
    async createFromOptions(files, taskOptions) {
      options.push([kind, taskOptions]);
      fileArgs.push(files);
      await tick();
      // Like the bundle on Chrome for iOS (UA without "Version/"): no canvas given -> document.createElement,
      // which does not exist in a worker.
      if (iosChromeUA && !taskOptions.canvas) throw new ReferenceError("document is not defined");
      if (kind === "landmarker" && failLandmarker) throw new Error("model blocked");
      if (!context.ModuleFactory) throw new Error("ModuleFactory not set.");
      context.ModuleFactory = undefined;
      await tick();
      created.push(kind);
      // The first `brokenLandmarkers` landmarker instances fail at runtime, like a permanently broken instance.
      const broken = kind === "landmarker" && created.filter((k) => k === "landmarker").length <= brokenLandmarkers;
      return {
        close() {
          closed.push(kind);
        },
        detectForVideo() {
          if (kind === "segmenter") throw new Error("segmenter has no detectForVideo");
          if (broken) throw new Error("landmarker runtime failure");
          if (kind === "detector") {
            return { detections: [{ boundingBox: { originX: 1, originY: 2, width: 30, height: 40 }, categories: [{ score: 0.9 }] }] };
          }
          return { faceLandmarks: [Array.from({ length: 478 }, (_, i) => ({ x: i / 1000, y: 0.5, z: 0 }))] };
        },
        segmentForVideo(bitmap, timestamp, callback) {
          const values = maskValues || Float32Array.from({ length: bitmap.width * bitmap.height }, (_, i) => (i % 2 ? 1 : 0));
          callback({ confidenceMasks: [{ width: bitmap.width, height: bitmap.height, getAsFloat32Array: () => values }] });
        },
      };
    },
  });
  context.__mp = {
    FaceDetector: task("detector"),
    FaceLandmarker: task("landmarker"),
    ImageSegmenter: task("segmenter"),
    FilesetResolver: { forVisionTasks: async () => ({ wasmLoaderPath: "loader.js", wasmBinaryPath: "module.wasm" }) },
    ModuleFactory: function ModuleFactory() {},
  };
  // The core's imports become the fakes; the worker's import of the core becomes the core's own code, which is
  // run in the same script (its `export` keyword is dropped).
  const core = CORE
    .replace(/^import \{([^}]+)\} from "[^"]+";$/m, "const {$1} = __mp;")
    .replace(/^import ModuleFactory from "[^"]+";$/m, "const ModuleFactory = __mp.ModuleFactory;")
    .replace(/^export function /m, "function ");
  const worker = WORKER.replace(/^import \{ createDetectorCore \} from "[^"]+";$/m, "");
  const code = `${core}\n${worker}`;
  assert.ok(!/^import /m.test(code), "all imports replaced");
  assert.ok(!/^export /m.test(code), "no export left");
  vm.createContext(context);
  vm.runInContext(code, context);
  const send = (data) => context.onmessage({ data });
  return { posted, created, closed, send, context, options, fileArgs };
}

async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

test("detector and landmarker requested together are both created (no ModuleFactory race)", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" }); // glasses already on when the camera starts
  await settle();
  const types = w.posted.map((m) => m.type);
  assert.ok(types.includes("ready"), JSON.stringify(w.posted));
  assert.ok(types.includes("landmarker-ready"), JSON.stringify(w.posted));
  assert.deepEqual(w.created, ["detector", "landmarker"]);
});

test("a failed landmarker creation does not block the detector", async () => {
  const w = loadWorker({ failLandmarker: true });
  w.send({ type: "init-landmarker" });
  w.send({ type: "init" });
  await settle();
  assert.deepEqual(w.posted.map((m) => m.type).sort(), ["landmarker-error", "ready"]);
  // Detection still works and reports the landmark problem without failing.
  const bitmap = { width: 100, height: 100, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 1, frameId: 1, bitmap, timestamp: 1, landmarks: true });
  const result = w.posted.find((m) => m.type === "result");
  assert.equal(result.faces.length, 1);
  assert.equal(result.eyes, null);
  assert.equal(result.landmarksError, "not ready");
  assert.equal(bitmap.closed, true);
});

test("detect returns faces and eye corners from the same bitmap and closes it", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" });
  await settle();
  const bitmap = { width: 1000, height: 800, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 3, frameId: 7, bitmap, timestamp: 10, landmarks: true });
  const result = w.posted.find((m) => m.type === "result");
  assert.equal(result.frameId, 7);
  assert.equal(result.faces.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.eyes[0].rOuter)), { x: 33, y: 400 });
  assert.equal(result.landmarksError, null);
  assert.equal(bitmap.closed, true);
});

test("[bg] detector, landmarker and segmenter requested together are created one at a time", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" });
  w.send({ type: "init-segmenter" });
  await settle();
  assert.deepEqual(w.posted.map((m) => m.type).sort(), ["landmarker-ready", "ready", "segmenter-ready"]);
  assert.deepEqual(w.created, ["detector", "landmarker", "segmenter"]);
});

test("[bg] the mask comes from the same bitmap as the faces and its buffer is transferred", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-segmenter" });
  await settle();
  const bitmap = { width: 4, height: 2, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 1, frameId: 9, bitmap, timestamp: 5, landmarks: false, segment: true });
  const result = w.posted.find((m) => m.type === "result");
  assert.equal(result.frameId, 9);
  assert.equal(result.faces.length, 1);
  assert.deepEqual([result.mask.width, result.mask.height], [4, 2]);
  assert.deepEqual(Array.from(result.mask.alpha), [0, 255, 0, 255, 0, 255, 0, 255]);
  assert.equal(result.maskError, null);
  assert.ok(w.context.transfers.at(-1).includes(result.mask.alpha.buffer), "mask buffer transferred, not copied");
  assert.equal(bitmap.closed, true);
});

test("[bg] an invalid mask is reported, detection still succeeds", async () => {
  const w = loadWorker({ maskValues: Float32Array.from([0, 2, Number.NaN, 1]) });
  w.send({ type: "init" });
  w.send({ type: "init-segmenter" });
  await settle();
  const bitmap = { width: 2, height: 2, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 1, frameId: 1, bitmap, timestamp: 1, segment: true });
  const result = w.posted.find((m) => m.type === "result");
  assert.equal(result.mask, null);
  assert.equal(result.maskError, "mask value out of range");
  assert.equal(result.faces.length, 1);
  assert.equal(bitmap.closed, true);
});

test("[bg] segmentation before the segmenter is ready reports 'not ready'", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  await settle();
  const bitmap = { width: 2, height: 2, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 1, frameId: 1, bitmap, timestamp: 1, segment: true });
  assert.equal(w.posted.find((m) => m.type === "result").maskError, "not ready");
});

test("[d2] Retry (recreate) closes the broken segmenter and builds a new one through the queue", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-segmenter" });
  await settle();
  w.send({ type: "init-segmenter", recreate: true });
  // While it is rebuilt, detections report the segmenter as not ready.
  const bitmap = { width: 2, height: 2, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 1, frameId: 1, bitmap, timestamp: 1, segment: true });
  assert.equal(w.posted.find((m) => m.type === "result").maskError, "not ready");
  await settle();
  assert.deepEqual(w.closed, ["segmenter"], "broken instance released");
  assert.deepEqual(w.created, ["detector", "segmenter", "segmenter"]);
  assert.equal(w.posted.filter((m) => m.type === "segmenter-ready").length, 2);
});

test("[d2] init-segmenter without recreate keeps a working instance", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-segmenter" });
  await settle();
  w.send({ type: "init-segmenter" });
  await settle();
  assert.deepEqual(w.closed, []);
  assert.deepEqual(w.created, ["detector", "segmenter"]);
});

// ---------- iPhone Chrome: MediaPipe must not fall back to document.createElement in the worker ----------

test("[ios] every task gets its own OffscreenCanvas, so Chrome on iOS loads detector, landmarker and segmenter", async () => {
  const w = loadWorker({ iosChromeUA: true });
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" });
  w.send({ type: "init-segmenter" });
  await settle();
  assert.deepEqual(w.posted.map((m) => m.type), ["ready", "landmarker-ready", "segmenter-ready"]);
  const canvases = w.options.map(([, o]) => o.canvas);
  assert.ok(canvases.every((c) => c instanceof w.context.OffscreenCanvas), "OffscreenCanvas passed");
  assert.equal(new Set(canvases).size, 3, "one canvas per task");
});

test("[ios] without OffscreenCanvas nothing is passed (MediaPipe decides) and a load failure carries the error class", async () => {
  const w = loadWorker({ offscreen: false, iosChromeUA: true });
  w.send({ type: "init" });
  await settle();
  assert.equal(w.options[0][1].canvas, undefined);
  const error = w.posted.find((m) => m.type === "error");
  assert.equal(error.stage, "init");
  assert.equal(error.name, "ReferenceError");
});

// ---------- Codex review: Retry after a runtime landmarker failure must rebuild the instance ----------

test("[r-mon] Retry (recreate) closes a runtime-broken landmarker, builds a new one, and the next frame succeeds", async () => {
  const w = loadWorker({ brokenLandmarkers: 1 });
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" });
  await settle();
  const bitmap = () => ({ width: 1000, height: 800, close() {} });
  w.send({ type: "detect", session: 1, frameId: 1, bitmap: bitmap(), timestamp: 10, landmarks: true });
  let result = w.posted.filter((m) => m.type === "result").at(-1);
  assert.equal(result.landmarksError, "landmarker runtime failure");

  w.send({ type: "init-landmarker", recreate: true });
  await settle();
  assert.deepEqual(w.closed, ["landmarker"], "the broken instance was closed");
  assert.equal(w.created.filter((k) => k === "landmarker").length, 2, "a new instance was created");
  assert.equal(w.posted.filter((m) => m.type === "landmarker-ready").length, 2);

  w.send({ type: "detect", session: 1, frameId: 2, bitmap: bitmap(), timestamp: 20, landmarks: true });
  result = w.posted.filter((m) => m.type === "result").at(-1);
  assert.equal(result.landmarksError, null, "the next frame succeeds with the new instance");
  assert.equal(result.marks.length, 1);
});

// ---------- Every frame gets exactly one answer; the core can be disposed (main-thread fallback) ----------

test("[q] a frame sent before the detector exists is closed and answered with an error carrying its frame id", () => {
  const w = loadWorker();
  const bitmap = { width: 10, height: 10, closed: false, close() { this.closed = true; } };
  w.send({ type: "detect", session: 4, frameId: 12, bitmap, timestamp: 1 });
  const error = w.posted.find((m) => m.type === "error");
  assert.equal(error.stage, "detect");
  assert.equal(error.frameId, 12);
  assert.equal(error.session, 4);
  assert.equal(bitmap.closed, true);
  assert.equal(w.posted.length, 1, "exactly one answer");
});

test("[q] a detector that throws still answers the frame once, with the error class, and closes the bitmap", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  await settle();
  const bitmap = { width: 10, height: 10, closed: false, close() { this.closed = true; } };
  w.context.performance = { now: () => { throw new TypeError("clock broke"); } }; // makes detect() throw
  w.send({ type: "detect", session: 1, frameId: 3, bitmap, timestamp: 1 });
  const answers = w.posted.filter((m) => m.type === "result" || m.type === "error");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].type, "error");
  assert.equal(answers[0].name, "TypeError");
  assert.equal(answers[0].frameId, 3);
  assert.equal(bitmap.closed, true);
});

test("[fb] dispose closes every task; later frames are closed without an answer; two cores are independent", async () => {
  const w = loadWorker();
  w.send({ type: "init" });
  w.send({ type: "init-landmarker" });
  w.send({ type: "init-segmenter" });
  await settle();
  const second = [];
  const other = w.context.createDetectorCore((message) => second.push(message));
  other.dispose(); // disposing an unused core does nothing to the first
  const bitmap = () => ({ width: 100, height: 100, closed: false, close() { this.closed = true; } });
  const ok = bitmap();
  w.send({ type: "detect", session: 1, frameId: 1, bitmap: ok, timestamp: 1, landmarks: true });
  assert.equal(w.posted.at(-1).type, "result");

  // The core is reachable through the worker's own instance only via messages, so dispose it through a fresh one.
  const before = w.posted.length;
  const mine = [];
  const core = w.context.createDetectorCore((message) => mine.push(message));
  await core.handle({ type: "init" });
  await core.handle({ type: "init-landmarker" });
  assert.deepEqual(mine.map((m) => m.type), ["ready", "landmarker-ready"]);
  const closedBefore = w.closed.length;
  core.dispose();
  assert.equal(w.closed.length - closedBefore, 2, "detector and landmarker released");
  const late = bitmap();
  await core.handle({ type: "detect", session: 1, frameId: 2, bitmap: late, timestamp: 2 });
  assert.equal(late.closed, true, "a frame after dispose is still released");
  assert.equal(mine.length, 2, "and gets no answer");
  assert.equal(w.posted.length, before, "the worker's own core was not touched");
});

test("[fb] on the main thread MediaPipe is not asked to fetch the module loader as a classic script; in a worker it is untouched", async () => {
  const page = loadWorker({ mainThread: true });
  page.send({ type: "init" });
  page.send({ type: "init-landmarker" });
  page.send({ type: "init-segmenter" });
  await settle();
  assert.equal(page.fileArgs.length, 3);
  for (const files of page.fileArgs) {
    assert.equal(files.wasmLoaderPath, undefined, "no second load of the module file");
    assert.equal(files.wasmBinaryPath, "module.wasm", "the binary is still located");
  }
  assert.deepEqual(page.posted.map((m) => m.type), ["ready", "landmarker-ready", "segmenter-ready"]);

  const worker = loadWorker();
  worker.send({ type: "init" });
  await settle();
  assert.equal(worker.fileArgs[0].wasmLoaderPath, "loader.js");
});

// ---------- Review round 1: dispose while loading; two cores on one thread ----------

test("[r1] a task that finishes creating after dispose() is closed, and a disposed core stays silent", async () => {
  const w = loadWorker();
  const mine = [];
  const core = w.context.createDetectorCore((message) => mine.push(message));
  const loading = core.handle({ type: "init" });
  const landmarking = core.handle({ type: "init-landmarker" });
  core.dispose(); // while both are still being created
  await loading;
  await landmarking;
  await settle();
  assert.deepEqual(w.created.slice().sort(), ["detector", "landmarker"]);
  assert.deepEqual(w.closed.slice().sort(), ["detector", "landmarker"], "nothing leaks");
  assert.deepEqual(mine, [], "no ready / ready messages from a disposed core");
});

test("[r1] two cores created at the same time (a retry on the main thread) never share self.ModuleFactory", async () => {
  const w = loadWorker({ mainThread: true });
  const a = [];
  const b = [];
  const first = w.context.createDetectorCore((m) => a.push(m));
  const second = w.context.createDetectorCore((m) => b.push(m));
  await Promise.all([first.handle({ type: "init" }), second.handle({ type: "init" })]);
  assert.deepEqual(a.map((m) => m.type), ["ready"]);
  assert.deepEqual(b.map((m) => m.type), ["ready"], JSON.stringify(b));
});
