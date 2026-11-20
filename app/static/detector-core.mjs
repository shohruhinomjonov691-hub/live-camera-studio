// Face detector core: runs the vendored MediaPipe tasks. Frames arrive as ImageBitmaps and never leave the browser.
// The same core runs in two places:
//   - detector-worker.mjs: a module worker (the normal case, off the UI thread), and
//   - the page's main thread as a *fallback* when a worker cannot be started (see shell.js, "Fallback" engine).
// It only talks through the `post(message, transferList)` function it is given.
//
// in:  {type: "init"}                       load the face detector (needed for blur)
//      {type: "init-landmarker", recreate?} load the face landmarker (glasses effect, alertness monitor);
//                                           recreate: close the current instance first (Retry after an error)
//      {type: "init-segmenter", recreate?}  load the selfie segmenter (only for background effects);
//                                           recreate: close the current instance first (Retry after an error)
//      {type: "detect", session, frameId, bitmap, timestamp, landmarks: bool, segment: bool}
// out: {type: "ready", initMs}
//      {type: "landmarker-ready", initMs} | {type: "landmarker-error", message}
//      {type: "segmenter-ready", initMs} | {type: "segmenter-error", message}
//      {type: "result", session, frameId, faces: [{x, y, w, h, score}], inferMs,
//       eyes: [{rOuter, rInner, lInner, lOuter}] | null, marks: [[x0, y0, x1, y1, ...]] | null,
//       landmarksError: string | null,
//       mask: {width, height, alpha: Uint8ClampedArray (transferred)} | null, maskError: string | null}
//      {type: "error", stage: "init" | "detect", session?, frameId?, message, name}
//      name: the error's class name only (e.g. "ReferenceError"), shown in the UI as a diagnostic code
//
// Every "detect" gets exactly one answer ("result" or "error" with the same frameId), so the page can tell when
// the core is free again and never queues more than one frame behind it.
//
// Detection, landmarks and segmentation run on the same bitmap, so the person mask always belongs to the
// frame it is applied to. A landmarker or segmenter failure never fails the detection: the result then
// carries `landmarksError` / `maskError`, and the page decides how to fail closed.

import { FaceDetector, FaceLandmarker, FilesetResolver, ImageSegmenter } from "/static/vendor/mediapipe/tasks-vision-1.0.1/vision_bundle.mjs";
import ModuleFactory from "/static/vendor/mediapipe/tasks-vision-1.0.1/wasm/vision_wasm_module_internal.js";

const WASM_BASE = "/static/vendor/mediapipe/tasks-vision-1.0.1/wasm";
const DETECTOR_MODEL = "/static/vendor/mediapipe/models/blaze_face_short_range.tflite";
const LANDMARKER_MODEL = "/static/vendor/mediapipe/models/face_landmarker.task";
const SEGMENTER_MODEL = "/static/vendor/mediapipe/models/selfie_segmenter.tflite";
// Lower than MediaPipe's 0.5 default: for privacy a missed face costs more than an extra box.
const MIN_CONFIDENCE = 0.4;
const MAX_FACES_WITH_GLASSES = 4;
// Face mesh indices of the eye corners (image coordinates, not mirrored).
const EYE_POINTS = { rOuter: 33, rInner: 133, lInner: 362, lOuter: 263 };
// Points for the alertness monitor (eyes, mouth, head, face oval), in the order of MONITOR_LANDMARKS in
// app/static/monitor.js (a test checks they match). Sent per face as a flat [x0, y0, x1, y1, ...] array.
const MONITOR_POINTS = [
  33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380, 13, 14, 78, 308,
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146,
  1, 152, 234, 454, 10,
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150,
  136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

// MediaPipe clears self.ModuleFactory after creating each task. In a page it re-runs the loader script for the
// next task, but a cached ES module does not run again, so the second task (the landmarker) would fail with
// "ModuleFactory not set". Restore it before every task.
function provideModuleFactory() {
  self.ModuleFactory = ModuleFactory;
}

// MediaPipe needs a canvas for WebGL. Without one it picks OffscreenCanvas from the user agent: on WebKit only
// when the UA has "Version/17+" (Safari). Chrome on iOS is WebKit but its UA has "CriOS" and no "Version/", so
// MediaPipe falls back to document.createElement("canvas") — and a worker has no document ("document is not
// defined"). Pass our own OffscreenCanvas, which is what MediaPipe itself uses on desktop and in Safari 17+.
function glCanvas() {
  return typeof OffscreenCanvas === "undefined" ? undefined : new OffscreenCanvas(1, 1);
}

// On the main thread (the fallback) MediaPipe would fetch the ES-module WASM loader as a classic <script>, which
// cannot parse it ("Cannot use 'import.meta' outside a module"): harmless noise, because the module was already
// imported above and provideModuleFactory() hands it over, but it reports an exception and fetches the file twice.
// Leave the loader path out there. A worker needs nothing special.
function tasksFiles(files) {
  return typeof document === "undefined" ? files : { ...files, wasmLoaderPath: undefined };
}

/** Class name of an error (e.g. "TypeError"): safe to show; the message is not sent to the page's UI. */
function errorName(error) {
  const name = error && error.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Error";
}

function marksFrom(result, width, height) {
  return result.faceLandmarks.map((points) => {
    const flat = new Array(MONITOR_POINTS.length * 2);
    MONITOR_POINTS.forEach((index, i) => {
      flat[i * 2] = points[index].x * width;
      flat[i * 2 + 1] = points[index].y * height;
    });
    return flat;
  });
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

// Task creation is async and each task consumes (and clears) self.ModuleFactory, so two creations must
// never overlap — e.g. the detector and the landmarker when the glasses effect is already on. Queue them.
// The queue is shared by every core in this realm: on the main thread (the fallback) a retried core and the one
// it replaced would otherwise create tasks at the same time and fight over self.ModuleFactory.
let taskQueue = Promise.resolve();
function oneAtATime(create) {
  const run = taskQueue.then(create);
  taskQueue = run.catch(() => {});
  return run;
}

/** One independent detector: its own tasks and timestamps. `post(message, transfer)` delivers its output. */
export function createDetectorCore(post) {
  let fileset = null;
  let detector = null;
  let landmarker = null;
  let segmenter = null;
  let lastTimestamp = 0;
  let disposed = false;

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
    const task = await oneAtATime(() => {
      provideModuleFactory();
      return FaceDetector.createFromOptions(tasksFiles(files), {
        baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate: "CPU" },
        canvas: glCanvas(),
        runningMode: "VIDEO",
        minDetectionConfidence: MIN_CONFIDENCE,
      });
    });
    // Disposed while the task was being created: release it instead of keeping it.
    if (disposed) closeTask(task);
    else detector = task;
    return performance.now() - started;
  }

  async function initLandmarker() {
    const started = performance.now();
    const files = await loadFileset();
    const task = await oneAtATime(() => {
      provideModuleFactory();
      return FaceLandmarker.createFromOptions(tasksFiles(files), {
        baseOptions: { modelAssetPath: LANDMARKER_MODEL, delegate: "CPU" },
        canvas: glCanvas(),
        runningMode: "VIDEO",
        numFaces: MAX_FACES_WITH_GLASSES,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    });
    // Disposed while the task was being created: release it instead of keeping it.
    if (disposed) closeTask(task);
    else landmarker = task;
    return performance.now() - started;
  }

  async function initSegmenter() {
    const started = performance.now();
    const files = await loadFileset();
    const task = await oneAtATime(() => {
      provideModuleFactory();
      return ImageSegmenter.createFromOptions(tasksFiles(files), {
        baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: "CPU" },
        canvas: glCanvas(),
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    });
    // Disposed while the task was being created: release it instead of keeping it.
    if (disposed) closeTask(task);
    else segmenter = task;
    return performance.now() - started;
  }

  /** Person mask of this bitmap as 8-bit alpha. Throws if the mask is missing or malformed. */
  function maskFrom(bitmap, timestamp) {
    let mask = null;
    let problem = "no person mask";
    // The masks are only valid inside this callback: copy them out here. Do not throw from inside the
    // callback (it is called from WebAssembly); record the problem and throw afterwards.
    segmenter.segmentForVideo(bitmap, timestamp, (result) => {
      const confidence = result.confidenceMasks && result.confidenceMasks[0];
      if (!confidence || !(confidence.width > 0) || !(confidence.height > 0)) return;
      const values = confidence.getAsFloat32Array();
      if (values.length !== confidence.width * confidence.height) {
        problem = "mask size mismatch";
        return;
      }
      const alpha = new Uint8ClampedArray(values.length);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!(v >= 0 && v <= 1)) {
          problem = "mask value out of range";
          return;
        }
        alpha[i] = v * 255;
      }
      mask = { width: confidence.width, height: confidence.height, alpha };
    });
    if (!mask) throw new Error(problem);
    return mask;
  }

  function detect({ session, frameId, bitmap, timestamp, landmarks, segment }) {
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
      let marks = null;
      let landmarksError = null;
      if (landmarks) {
        if (!landmarker) {
          landmarksError = "not ready";
        } else {
          try {
            const found = landmarker.detectForVideo(bitmap, lastTimestamp);
            eyes = eyesFrom(found, bitmap.width, bitmap.height);
            marks = marksFrom(found, bitmap.width, bitmap.height);
          } catch (error) {
            landmarksError = String(error?.message || error);
          }
        }
      }
      let mask = null;
      let maskError = null;
      if (segment) {
        if (!segmenter) {
          maskError = "not ready";
        } else {
          try {
            mask = maskFrom(bitmap, lastTimestamp);
          } catch (error) {
            maskError = String(error?.message || error);
          }
        }
      }
      const inferMs = performance.now() - started;
      post(
        { type: "result", session, frameId, faces, inferMs, eyes, marks, landmarksError, mask, maskError },
        mask ? [mask.alpha.buffer] : [],
      );
    } catch (error) {
      post({
        type: "error", stage: "detect", session, frameId, message: String(error?.message || error), name: errorName(error),
      });
    } finally {
      bitmap.close();
    }
  }

  /** Release a task instance; an already unusable one is ignored. */
  function closeTask(task) {
    try {
      task && task.close();
    } catch (_) {
      /* already unusable */
    }
  }

  async function handle(msg) {
    if (disposed) {
      // A frame that arrives after dispose() must still be released.
      if (msg.type === "detect" && msg.bitmap) msg.bitmap.close();
      return;
    }
    if (msg.type === "init") {
      try {
        const initMs = await initDetector();
        if (!disposed) post({ type: "ready", initMs });
      } catch (error) {
        if (!disposed) post({ type: "error", stage: "init", message: String(error?.message || error), name: errorName(error) });
      }
    } else if (msg.type === "init-landmarker") {
      if (msg.recreate && landmarker) {
        // Retry after a runtime failure: release the broken instance; detections meanwhile report "not ready".
        const broken = landmarker;
        landmarker = null;
        closeTask(broken);
      }
      try {
        const initMs = landmarker ? 0 : await initLandmarker();
        if (!disposed) post({ type: "landmarker-ready", initMs });
      } catch (error) {
        landmarker = null;
        if (!disposed) post({ type: "landmarker-error", message: String(error?.message || error) });
      }
    } else if (msg.type === "init-segmenter") {
      if (msg.recreate && segmenter) {
        // Retry after a runtime failure: release the broken instance; detections meanwhile report "not ready".
        const broken = segmenter;
        segmenter = null;
        closeTask(broken);
      }
      try {
        const initMs = segmenter ? 0 : await initSegmenter();
        if (!disposed) post({ type: "segmenter-ready", initMs });
      } catch (error) {
        segmenter = null;
        if (!disposed) post({ type: "segmenter-error", message: String(error?.message || error) });
      }
    } else if (msg.type === "detect") {
      if (!detector) {
        msg.bitmap.close();
        post({ type: "error", stage: "detect", session: msg.session, frameId: msg.frameId, message: "not ready", name: "Error" });
        return;
      }
      detect(msg);
    }
  }

  /** Free every task (used when the core runs on the main thread, where there is no worker to terminate). */
  function dispose() {
    disposed = true;
    for (const task of [detector, landmarker, segmenter]) closeTask(task);
    detector = landmarker = segmenter = null;
  }

  return { handle, dispose };
}
