// Face detector worker: runs the vendored MediaPipe tasks off the UI thread.
// Frames arrive as transferred ImageBitmaps and never leave the browser.
//
// in:  {type: "init"}                       load the face detector (needed for blur)
//      {type: "init-landmarker"}            load the face landmarker (only for the glasses effect)
//      {type: "detect", session, frameId, bitmap, timestamp, landmarks: bool}
// out: {type: "ready", initMs}
//      {type: "landmarker-ready", initMs} | {type: "landmarker-error", message}
//      {type: "result", session, frameId, faces: [{x, y, w, h, score}], inferMs,
//       eyes: [{rOuter, rInner, lInner, lOuter}] | null, landmarksError: string | null}
//      {type: "error", stage: "init" | "detect", session?, frameId?, message}
//
// Detection and landmarks run on the same bitmap. A landmarker failure never fails the detection:
// the result then carries `landmarksError` and no eyes, and blur keeps working.

import { FaceDetector, FaceLandmarker, FilesetResolver } from "/static/vendor/mediapipe/tasks-vision-1.0.1/vision_bundle.mjs";
import ModuleFactory from "/static/vendor/mediapipe/tasks-vision-1.0.1/wasm/vision_wasm_module_internal.js";

const WASM_BASE = "/static/vendor/mediapipe/tasks-vision-1.0.1/wasm";
const DETECTOR_MODEL = "/static/vendor/mediapipe/models/blaze_face_short_range.tflite";
const LANDMARKER_MODEL = "/static/vendor/mediapipe/models/face_landmarker.task";
// Lower than MediaPipe's 0.5 default: for privacy a missed face costs more than an extra box.
const MIN_CONFIDENCE = 0.4;
const MAX_FACES_WITH_GLASSES = 4;
// Face mesh indices of the eye corners (image coordinates, not mirrored).
const EYE_POINTS = { rOuter: 33, rInner: 133, lInner: 362, lOuter: 263 };

let fileset = null;
let detector = null;
let landmarker = null;
let lastTimestamp = 0;

// MediaPipe clears self.ModuleFactory after creating each task. In a page it re-runs the loader script for the
// next task, but in a module worker the loader is a cached ES module that does not run again, so the second
// task (the landmarker) would fail with "ModuleFactory not set". Restore it before every task.
function provideModuleFactory() {
  self.ModuleFactory = ModuleFactory;
}

// Task creation is async and each task consumes (and clears) self.ModuleFactory, so two creations must
// never overlap — e.g. the detector and the landmarker when the glasses effect is already on. Queue them.
let taskQueue = Promise.resolve();
function oneAtATime(create) {
  const run = taskQueue.then(create);
  taskQueue = run.catch(() => {});
  return run;
}

function loadFileset() {
  // true = the ES-module WASM loader, which works in a module worker (no importScripts).
  // One shared promise, so parallel inits do not resolve it twice.
  if (!fileset) {
    fileset = FilesetResolver.forVisionTasks(WASM_BASE, true);
    fileset.catch(() => (fileset = null)); // allow a retry after a failure
  }
  return fileset;
}

async function initDetector() {
  const started = performance.now();
  const files = await loadFileset();
  detector = await oneAtATime(() => {
    provideModuleFactory();
    return FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: MIN_CONFIDENCE,
    });
  });
  return performance.now() - started;
}

async function initLandmarker() {
  const started = performance.now();
  const files = await loadFileset();
  landmarker = await oneAtATime(() => {
    provideModuleFactory();
    return FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: LANDMARKER_MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: MAX_FACES_WITH_GLASSES,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
  });
  return performance.now() - started;
}

function eyesFrom(result, width, height) {
  return result.faceLandmarks.map((points) => {
    const eye = {};
    for (const [name, index] of Object.entries(EYE_POINTS)) {
      eye[name] = { x: points[index].x * width, y: points[index].y * height };
    }
    return eye;
  });
}

function detect({ session, frameId, bitmap, timestamp, landmarks }) {
  try {
    // VIDEO mode needs strictly increasing timestamps, also across camera sessions.
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    const started = performance.now();
    const result = detector.detectForVideo(bitmap, lastTimestamp);
    const faces = result.detections
      .filter((d) => d.boundingBox)
      .map((d) => ({
        x: d.boundingBox.originX,
        y: d.boundingBox.originY,
        w: d.boundingBox.width,
        h: d.boundingBox.height,
        score: d.categories[0]?.score ?? 0,
      }));

    let eyes = null;
    let landmarksError = null;
    if (landmarks) {
      if (!landmarker) {
        landmarksError = "not ready";
      } else {
        try {
          eyes = eyesFrom(landmarker.detectForVideo(bitmap, lastTimestamp), bitmap.width, bitmap.height);
        } catch (error) {
          landmarksError = String(error?.message || error);
        }
      }
    }
    const inferMs = performance.now() - started;
    self.postMessage({ type: "result", session, frameId, faces, inferMs, eyes, landmarksError });
  } catch (error) {
    self.postMessage({ type: "error", stage: "detect", session, frameId, message: String(error?.message || error) });
  } finally {
    bitmap.close();
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      const initMs = await initDetector();
      self.postMessage({ type: "ready", initMs });
    } catch (error) {
      self.postMessage({ type: "error", stage: "init", message: String(error?.message || error) });
    }
  } else if (msg.type === "init-landmarker") {
    try {
      const initMs = landmarker ? 0 : await initLandmarker();
      self.postMessage({ type: "landmarker-ready", initMs });
    } catch (error) {
      landmarker = null;
      self.postMessage({ type: "landmarker-error", message: String(error?.message || error) });
    }
  } else if (msg.type === "detect") {
    if (!detector) {
      msg.bitmap.close();
      self.postMessage({ type: "error", stage: "detect", session: msg.session, frameId: msg.frameId, message: "not ready" });
      return;
    }
    detect(msg);
  }
};
