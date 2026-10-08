"use strict";

// Live camera with fail-closed face blur. Design: design/live-camera-studio/PLAN.md.
//
// Privacy rules implemented here:
// - The raw <video> is never shown. Only frames that went through detection are drawn.
// - Detection and blur use the very same captured frame: one ImageBitmap is captured, a copy goes to the
//   detector worker, and the original is blurred with exactly that frame's boxes.
// - While a result is pending the canvas keeps the last processed frame; after PENDING_TIMEOUT_MS, on
//   zero faces (with blur on) or on any error the canvas is cleared.
// - Every camera start opens a session; late streams, late frames and late detector results from an older
//   session are discarded (and their tracks/bitmaps released).
// - Frames never leave the browser: this file makes no network requests.
//
// The controller takes its browser dependencies as `env`, so tests can drive it with fakes.
(function (global) {
  const PENDING_TIMEOUT_MS = 1000;
  const READY_TIMEOUT_MS = 20000;
  // BlazeFace boxes are tighter than the Haar boxes used for uploads (padded 15%), so live boxes get more.
  const PADDING = 0.25;
  const CELLS = { 1: 16, 2: 11, 3: 7 }; // pixel cells across the shorter side of a face box
  const BLUR_DIVISOR = { 1: 12, 2: 8, 3: 5 }; // Gaussian radius = shorter side / divisor
  // Every scratch cell covers at least MIN_CELL×MIN_CELL source pixels, so even a tiny box is really reduced
  // and no original pixel survives when canvas filters are unavailable.
  const MIN_CELL = 4;

  /** Pad a detector box by PADDING on each side and clip it to the frame. */
  function boxFor(face, width, height) {
    const padX = face.w * PADDING;
    const padY = face.h * PADDING;
    const x0 = Math.max(0, Math.floor(face.x - padX));
    const y0 = Math.max(0, Math.floor(face.y - padY));
    const x1 = Math.min(width, Math.ceil(face.x + face.w + padX));
    const y1 = Math.min(height, Math.ceil(face.y + face.h + padY));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Obscure one box of ctx's canvas in place. */
  function obscure(ctx, scratch, box, method, strength) {
    const { x, y, w, h } = box;
    if (method === "block") {
      ctx.fillStyle = "#0b0d11";
      ctx.fillRect(x, y, w, h);
      return;
    }
    const cells = method === "gauss" ? CELLS[strength] * 2 : CELLS[strength];
    const cell = Math.max(MIN_CELL, Math.min(w, h) / cells);
    const sw = Math.max(1, Math.round(w / cell));
    const sh = Math.max(1, Math.round(h / cell));
    scratch.width = sw;
    scratch.height = sh;
    const sctx = scratch.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // First an opaque downscaled copy, so nothing of the original survives even where the blur below
    // fades out at the edges, or in browsers without canvas filters.
    ctx.imageSmoothingEnabled = method === "gauss";
    ctx.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
    ctx.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) / BLUR_DIVISOR[strength]))}px)`;
    ctx.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
    ctx.restore();
  }

  function stopTracks(stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  function errorState(error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (["NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError"].includes(name)) return "nocam";
    return "error";
  }

  function withTimeout(promise, ms, env) {
    return new Promise((resolve, reject) => {
      const timer = env.setTimeout(() => reject(new Error("timeout")), ms);
      promise.then(
        (value) => {
          env.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          env.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  function createCameraController(env) {
    const settings = { blurOn: true, method: "pixel", strength: 3, showBoxes: true, facingMode: "user" };
    let camSession = 0;
    let stream = null;
    let worker = null;
    let workerReady = null; // Promise, resolved when the detector is loaded
    let detectorUp = false;
    let pendingInit = null;
    let frameId = 0;
    // The one frame in the pipeline, from the start of capture until its result is drawn or dropped:
    // {id, session, frame, copy, capturedAt, timer}. A new frame is captured only when this is null.
    let job = null;
    let frameHandle = null;
    let state = "idle";
    let stateInfo = null;
    const buffer = env.makeCanvas();
    const scratch = env.makeCanvas();
    const perf = { windowStart: 0, windowCount: 0, fps: null, inferMs: [], latencyMs: [], frameSize: null };

    function setState(next, info = null) {
      const changed = next !== state || JSON.stringify(info) !== JSON.stringify(stateInfo);
      state = next;
      stateInfo = info;
      if (changed) env.onState(next, info);
    }

    function clearCanvas(canvas) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    function clearView() {
      clearCanvas(env.view);
      clearCanvas(env.overlay);
      clearCanvas(buffer);
    }

    /** Drop the frame in the pipeline: cancel its deadline and close its bitmaps. Its late result is ignored. */
    function dropJob() {
      if (!job) return;
      env.clearTimeout(job.timer);
      if (job.frame) job.frame.close();
      if (job.copy) job.copy.close(); // null once transferred to the worker
      job = null;
    }

    // ---------- detector worker ----------
    function ensureWorker() {
      if (workerReady) return workerReady;
      worker = env.createWorker();
      workerReady = new Promise((resolve, reject) => (pendingInit = { resolve, reject }));
      workerReady.catch(() => {}); // handled by whoever awaits it
      worker.onmessage = (event) => onWorkerMessage(event.data);
      worker.onerror = (event) => onWorkerFailure(event && event.message);
      worker.postMessage({ type: "init" });
      return workerReady;
    }

    function resetWorker() {
      if (worker) worker.terminate();
      worker = null;
      workerReady = null;
      detectorUp = false;
      pendingInit = null;
    }

    function onWorkerMessage(msg) {
      if (msg.type === "ready") {
        detectorUp = true;
        if (pendingInit) pendingInit.resolve(msg.initMs);
        pendingInit = null;
      } else if (msg.type === "result") {
        onResult(msg);
      } else if (msg.type === "error") {
        if (msg.stage === "init") {
          if (pendingInit) pendingInit.reject(new Error(msg.message));
          pendingInit = null;
        } else if (msg.session === camSession) {
          fail("detector");
        }
      }
    }

    function onWorkerFailure(message) {
      if (pendingInit) pendingInit.reject(new Error(message || "worker error"));
      pendingInit = null;
      resetWorker();
      if (stream) fail("detector");
    }

    // ---------- camera ----------
    async function start() {
      if (stream || state === "prompt" || state === "loading") stop();
      if (!env.isSecureContext || !env.mediaDevices || !env.mediaDevices.getUserMedia) {
        setState("insecure");
        return;
      }
      const id = ++camSession;
      setState("prompt");
      const ready = ensureWorker();

      let incoming;
      try {
        incoming = await env.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: settings.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (error) {
        if (id === camSession) setState(errorState(error), { name: error && error.name });
        return;
      }
      if (id !== camSession) {
        stopTracks(incoming); // permission came back after Stop/Cancel/hide: close it at once
        return;
      }
      stream = incoming;
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => onTrackEnded(id)));
      setState("loading");

      env.video.srcObject = stream;
      try {
        await env.video.play();
      } catch (error) {
        if (id !== camSession) return;
        stop();
        setState("error", { kind: "play" });
        return;
      }
      if (id !== camSession) return;

      try {
        await withTimeout(ready, READY_TIMEOUT_MS, env);
      } catch (error) {
        if (id !== camSession) return;
        resetWorker();
        fail("detector");
        return;
      }
      if (id !== camSession) return;
      schedule();
    }

    function onTrackEnded(id) {
      if (id !== camSession) return;
      stop();
      setState("ended");
    }

    /** Fully stop: camera off, loop cancelled, pending work dropped, canvas cleared. */
    function stop(reason = null) {
      camSession++;
      if (frameHandle !== null) env.cancelFrame(frameHandle);
      frameHandle = null;
      dropJob();
      if (stream) stopTracks(stream);
      stream = null;
      if (env.video.pause) env.video.pause();
      env.video.srcObject = null;
      clearView();
      perf.windowStart = 0;
      perf.windowCount = 0;
      perf.fps = null;
      setState("idle", reason ? { reason } : null);
    }

    function fail(kind) {
      if (frameHandle !== null) env.cancelFrame(frameHandle);
      frameHandle = null;
      dropJob();
      clearView();
      setState("error", { kind });
    }

    function restartDetector() {
      resetWorker();
      clearView();
      if (!stream) return start();
      const id = camSession;
      setState("loading");
      withTimeout(ensureWorker(), READY_TIMEOUT_MS, env).then(
        () => id === camSession && schedule(),
        () => {
          if (id !== camSession) return;
          resetWorker();
          fail("detector");
        },
      );
    }

    // ---------- frame loop ----------
    function schedule() {
      if (frameHandle === null && stream) frameHandle = env.requestFrame(tick);
    }

    function tick() {
      frameHandle = null;
      if (!stream || job || !detectorUp || state === "error") return;
      if (env.video.readyState < 2) {
        schedule();
        return;
      }
      capture();
    }

    async function capture() {
      // The deadline runs from the start of capture, so a stuck createImageBitmap also hides the preview.
      const current = { id: ++frameId, session: camSession, frame: null, copy: null, capturedAt: env.now(), timer: null };
      job = current;
      current.timer = env.setTimeout(() => onDeadline(current), PENDING_TIMEOUT_MS);
      // After every await: is this still the frame in the pipeline (no Stop, timeout or newer frame)?
      const live = () => job === current && current.session === camSession;
      try {
        const frame = await env.createImageBitmap(env.video);
        if (!live()) {
          frame.close();
          return;
        }
        current.frame = frame;
        const copy = await env.createImageBitmap(frame); // same pixels: one for the detector, one to blur
        if (!live()) {
          copy.close(); // current.frame was already closed by dropJob()
          return;
        }
        current.copy = copy;
      } catch (error) {
        if (live()) {
          dropJob();
          schedule();
        }
        return;
      }
      worker.postMessage(
        { type: "detect", session: current.session, frameId: current.id, bitmap: current.copy, timestamp: env.now() },
        [current.copy],
      );
      current.copy = null; // transferred: the worker closes it
    }

    function onDeadline(current) {
      if (job !== current) return;
      dropJob(); // this frame is now stale: its result will be ignored when it arrives
      if (settings.blurOn) {
        clearView();
        setState("hidden", { why: "timeout" });
      }
      schedule(); // recover with the next new frame
    }

    function onResult(msg) {
      // Only the result for the frame in the pipeline, in the current session, is used.
      if (msg.session !== camSession || !job || msg.frameId !== job.id) return;
      const current = job;
      job = null;
      env.clearTimeout(current.timer);

      const faces = msg.faces || [];
      try {
        if (settings.blurOn && faces.length === 0) {
          clearView();
          setState("hidden", { why: "noface" });
        } else {
          compose(current.frame, faces);
          setState("live", { faces: faces.length, blurOn: settings.blurOn });
        }
      } catch (error) {
        fail("render"); // clears the canvas; nothing half-drawn stays visible
        return;
      } finally {
        current.frame.close();
      }
      record(msg.inferMs, env.now() - current.capturedAt);
      schedule();
    }

    function compose(frame, faces) {
      const width = frame.width;
      const height = frame.height;
      for (const canvas of [buffer, env.view, env.overlay]) {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      }
      const bctx = buffer.getContext("2d");
      bctx.clearRect(0, 0, width, height);
      bctx.drawImage(frame, 0, 0);
      const boxes = faces.map((face) => boxFor(face, width, height)).filter(Boolean);
      if (settings.blurOn) boxes.forEach((box) => obscure(bctx, scratch, box, settings.method, settings.strength));

      const vctx = env.view.getContext("2d");
      vctx.clearRect(0, 0, width, height);
      vctx.drawImage(buffer, 0, 0);

      const octx = env.overlay.getContext("2d");
      octx.clearRect(0, 0, width, height);
      if (settings.showBoxes) {
        octx.lineWidth = Math.max(2, Math.round(width / 400));
        octx.strokeStyle = "#3ccf8e";
        boxes.forEach((box) => octx.strokeRect(box.x, box.y, box.w, box.h));
      }
      perf.frameSize = { w: width, h: height };
    }

    function record(inferMs, latencyMs) {
      const now = env.now();
      if (!perf.windowStart) perf.windowStart = now;
      perf.windowCount++;
      if (now - perf.windowStart >= 1000) {
        perf.fps = (perf.windowCount * 1000) / (now - perf.windowStart);
        perf.windowStart = now;
        perf.windowCount = 0;
      }
      if (typeof inferMs === "number") perf.inferMs.push(inferMs);
      perf.latencyMs.push(latencyMs);
      if (perf.inferMs.length > 600) perf.inferMs.shift();
      if (perf.latencyMs.length > 600) perf.latencyMs.shift();
      if (env.onStats) env.onStats(stats());
    }

    function stats() {
      return {
        fps: perf.fps,
        latencyMs: perf.latencyMs.at(-1) ?? null,
        inferP50: percentile(perf.inferMs, 50),
        inferP95: percentile(perf.inferMs, 95),
        latencyP50: percentile(perf.latencyMs, 50),
        latencyP95: percentile(perf.latencyMs, 95),
        samples: perf.latencyMs.length,
        frameSize: perf.frameSize,
      };
    }

    return {
      start,
      stop,
      restartDetector,
      async switchCamera() {
        settings.facingMode = settings.facingMode === "user" ? "environment" : "user";
        if (stream || state === "prompt" || state === "loading") {
          stop();
          await start();
        }
      },
      setSettings(partial) {
        const blurTurnedOn = partial.blurOn === true && !settings.blurOn;
        Object.assign(settings, partial);
        if (blurTurnedOn) {
          // Nothing captured or drawn while blur was off may stay visible: wipe it and show only frames
          // that are captured and processed with blur on.
          dropJob();
          clearView();
          if (state === "live" || state === "hidden") {
            setState("hidden", { why: "pending" });
            schedule();
          }
        }
      },
      get settings() {
        return { ...settings };
      },
      get state() {
        return state;
      },
      get active() {
        return Boolean(stream) || state === "prompt" || state === "loading";
      },
      stats,
    };
  }

  global.createCameraController = createCameraController;
  global.liveCameraInternals = { boxFor, obscure, PENDING_TIMEOUT_MS };
})(typeof window !== "undefined" ? window : globalThis);
