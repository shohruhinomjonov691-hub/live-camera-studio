// Face detector worker: runs the vendored MediaPipe Face Detector off the UI thread.
// Frames arrive as transferred ImageBitmaps and never leave the browser.
//
// in:  {type: "init"}
//      {type: "detect", session, frameId, bitmap, timestamp}
// out: {type: "ready", initMs}
//      {type: "result", session, frameId, faces: [{x, y, w, h, score}], inferMs}
//      {type: "error", stage: "init" | "detect", session?, frameId?, message}

import { FaceDetector, FilesetResolver } from "/static/vendor/mediapipe/tasks-vision-1.0.1/vision_bundle.mjs";

const WASM_BASE = "/static/vendor/mediapipe/tasks-vision-1.0.1/wasm";
const MODEL_PATH = "/static/vendor/mediapipe/models/blaze_face_short_range.tflite";
// Lower than MediaPipe's 0.5 default: for privacy a missed face costs more than an extra box.
const MIN_CONFIDENCE = 0.4;

let detector = null;
let lastTimestamp = 0;

async function init() {
  const started = performance.now();
  // true = the ES-module WASM loader, which works in a module worker (no importScripts).
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE, true);
  detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
    runningMode: "VIDEO",
    minDetectionConfidence: MIN_CONFIDENCE,
  });
  return performance.now() - started;
}

function detect({ session, frameId, bitmap, timestamp }) {
  try {
    // VIDEO mode needs strictly increasing timestamps, also across camera sessions.
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    const started = performance.now();
    const result = detector.detectForVideo(bitmap, lastTimestamp);
    const inferMs = performance.now() - started;
    const faces = result.detections
      .filter((d) => d.boundingBox)
      .map((d) => ({
        x: d.boundingBox.originX,
        y: d.boundingBox.originY,
        w: d.boundingBox.width,
        h: d.boundingBox.height,
        score: d.categories[0]?.score ?? 0,
      }));
    self.postMessage({ type: "result", session, frameId, faces, inferMs });
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
      const initMs = await init();
      self.postMessage({ type: "ready", initMs });
    } catch (error) {
      self.postMessage({ type: "error", stage: "init", message: String(error?.message || error) });
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
