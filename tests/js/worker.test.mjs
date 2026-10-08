// The detector worker (app/static/detector-worker.mjs) with MediaPipe replaced by fakes that consume and clear
// self.ModuleFactory the way the vendored bundle does. Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../app/static/detector-worker.mjs", import.meta.url), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));

function loadWorker({ failLandmarker = false, maskValues = null } = {}) {
  const posted = [];
  const created = [];
  const context = { console, performance, posted, transfers: [] };
  context.self = context;
  context.postMessage = (msg, transfer) => {
    posted.push(msg);
    context.transfers.push(transfer || []);
  };

  // Like the bundle: wait for the loader, require self.ModuleFactory, consume it and clear it.
  const task = (kind) => ({
    async createFromOptions() {
      await tick();
      if (kind === "landmarker" && failLandmarker) throw new Error("model blocked");
      if (!context.ModuleFactory) throw new Error("ModuleFactory not set.");
      context.ModuleFactory = undefined;
      await tick();
      created.push(kind);
      return {
        detectForVideo() {
          if (kind === "segmenter") throw new Error("segmenter has no detectForVideo");
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
    FilesetResolver: { forVisionTasks: async () => ({}) },
    ModuleFactory: function ModuleFactory() {},
  };
  const code = SOURCE
    .replace(/^import \{([^}]+)\} from "[^"]+";$/m, "const {$1} = __mp;")
    .replace(/^import ModuleFactory from "[^"]+";$/m, "const ModuleFactory = __mp.ModuleFactory;");
  assert.ok(!/^import /m.test(code), "all imports replaced");
  vm.createContext(context);
  vm.runInContext(code, context);
  const send = (data) => context.onmessage({ data });
  return { posted, created, send, context };
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
