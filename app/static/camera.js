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
// - Effects (glasses) use landmarks of that same frame. Glasses and face blur are exclusive (glasses ON turns
//   blur OFF; blur ON turns glasses OFF), and blur is still drawn last. A landmarker or effect failure only
//   turns the effect off. Changing either setting drops the frame in flight.
// - Snapshots are copied from the visible, fully processed canvas only — never from the raw video.
// - Background effects use the person mask of that same frame. Layers: background (blurred frame or the
//   user's image) -> foreground (frame cut out by the mask) -> glasses or face blur. With a background on,
//   a frame without a valid mask is never shown (the real background must not reappear unannounced).
// - The alertness monitor (monitor.js) gets the landmarks of the very frame that was just processed
//   (env.onAnalysis) and its overlay is drawn from that same frame; it never changes what is blurred or hidden.
//
// - One frame at a time reaches the detector engine: a frame is posted only when the engine has answered the
//   previous one, so a slow or hung engine can never build a queue of stale frames behind it (a hung engine is
//   replaced after WORKER_STALL_MS).
// - The detector runs in a worker ("worker" engine). If a worker cannot be started the controller falls back to
//   `env.createFallbackWorker()` (the same core on the main thread, "fallback" engine) when the page provides one.
//   The engine and its status are reported through env.onEngine and stats().
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
  // Background blur: the frame is reduced to 1/N size and scaled back up, so the background is blurred
  // even without canvas filters; a filter softens the blocks where available.
  const BG_REDUCE = { 1: 12, 2: 20, 3: 32 };
  const MASK_ASPECT_TOLERANCE = 0.03;
  // A frame the engine has not answered for this long (after its deadline) means a hung engine: replace it.
  const WORKER_STALL_MS = 5000;
  const LUMA_EVERY_MS = 500; // brightness is sampled at most this often (a 24×24 reduction of the frame)
  const LUMA_SIZE = 24;
  const STATS_EVERY_MS = 500; // percentiles are recomputed at most this often
  // With the camera off the detector engine only holds models in memory: release it after this long (a later start
  // loads it again, which takes a moment).
  const WORKER_IDLE_MS = 60000;

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
    // A box smaller than one cell cannot be reduced (e.g. 1×1 left after clipping), so it is filled.
    if (method === "block" || Math.min(w, h) < MIN_CELL) {
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

  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function lensPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Draw glasses on one face, aligned to its eye corners (frame coordinates). `scale` is 0.8–1.2. */
  function drawGlasses(ctx, eye, scale) {
    const right = mid(eye.rOuter, eye.rInner);
    const left = mid(eye.lInner, eye.lOuter);
    const dist = Math.hypot(left.x - right.x, left.y - right.y);
    if (!(dist > 4)) return; // too small or invalid landmarks: no effect for this face
    const lensW = dist * 0.8 * scale;
    const lensH = lensW * 0.66;
    ctx.save();
    try {
      ctx.translate((right.x + left.x) / 2, (right.y + left.y) / 2);
      ctx.rotate(Math.atan2(left.y - right.y, left.x - right.x)); // follows head tilt
      ctx.lineWidth = Math.max(2, dist * 0.08 * scale);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#111318";
      ctx.fillStyle = "rgba(20, 24, 32, 0.45)";
      for (const cx of [-dist / 2, dist / 2]) {
        ctx.beginPath();
        lensPath(ctx, cx - lensW / 2, -lensH / 2, lensW, lensH, lensH * 0.35);
        ctx.fill();
        ctx.stroke();
      }
      const inner = dist / 2 - lensW / 2;
      const outer = dist / 2 + lensW / 2;
      ctx.beginPath(); // bridge
      ctx.moveTo(-inner, -lensH * 0.15);
      ctx.quadraticCurveTo(0, -lensH * 0.45, inner, -lensH * 0.15);
      ctx.moveTo(-outer, -lensH * 0.25); // temples
      ctx.lineTo(-outer - dist * 0.22, -lensH * 0.32);
      ctx.moveTo(outer, -lensH * 0.25);
      ctx.lineTo(outer + dist * 0.22, -lensH * 0.32);
      ctx.stroke();
    } finally {
      ctx.restore();
    }
  }

  /** A mask is usable only if it is complete and has the frame's aspect ratio. */
  function validMask(mask, frame) {
    if (!mask || !(mask.width > 0) || !(mask.height > 0) || !mask.alpha) return false;
    if (mask.alpha.length !== mask.width * mask.height) return false;
    const frameAspect = frame.width / frame.height;
    return Math.abs(mask.width / mask.height - frameAspect) / frameAspect <= MASK_ASPECT_TOLERANCE;
  }

  /** Draw `image` to cover the w×h canvas (centre crop), flipped horizontally when `mirror` is set. */
  function drawCover(ctx, image, w, h, mirror) {
    const scale = Math.max(w / image.width, h / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.save();
    try {
      if (mirror) {
        // The preview (and a mirrored snapshot) flips the whole canvas, so a flipped image ends up the
        // right way round for the viewer.
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } finally {
      ctx.restore();
    }
  }

  function stopTracks(stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  /**
   * Class name of an error (e.g. "NotAllowedError"), shown in the error card as a diagnostic code. Only a plain
   * identifier is kept: no message text, nothing from the frame.
   */
  function errorName(error) {
    const name = error && error.name;
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Error";
  }

  function errorState(error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (["NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError"].includes(name)) return "nocam";
    return "error";
  }

  function withTimeout(promise, ms, env) {
    return new Promise((resolve, reject) => {
      const timer = env.setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
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
    const settings = {
      blurOn: true, method: "pixel", strength: 3, showBoxes: true, facingMode: "user",
      glasses: false, glassesSize: 100,
      background: "off", bgBlur: 2, mirror: true,
      monitor: false, showLandmarks: true,
    };
    // Selfie segmenter for background effects: "off" | "loading" | "ready" | "error".
    let segmenter = "off";
    let backgroundImage = null; // ImageBitmap chosen by the user; owned (and closed) by this controller
    // Face landmarker for the glasses effect: "off" | "loading" | "ready" | "error". Independent of blur.
    let landmarker = "off";
    let viewReady = false; // the visible canvas holds a fully processed frame
    let camSession = 0;
    let stream = null;
    let worker = null;
    let workerReady = null; // Promise, resolved when the detector is loaded
    let detectorUp = false;
    let pendingInit = null;
    let workerMode = null; // "worker" | "fallback" while an engine exists
    let workerBroken = false; // a worker could not be started in this page: use the fallback until Restart
    // The frame the engine has not answered yet (id), and the timer that replaces an engine that never answers.
    let inWorker = null;
    let stallTimer = null;
    let idleTimer = null;
    // Detector engine for the telemetry: mode "worker" | "fallback" | null, status "off" | "starting" | "active" | "error".
    let engine = { mode: null, status: "off" };
    let frameId = 0;
    // The one frame in the pipeline, from the start of capture until its result is drawn or dropped:
    // {id, session, frame, copy, capturedAt, timer}. A new frame is captured only when this is null.
    let job = null;
    let frameHandle = null;
    let state = "idle";
    let stateInfo = null;
    const buffer = env.makeCanvas();
    const scratch = env.makeCanvas();
    const foreground = env.makeCanvas();
    const maskCanvas = env.makeCanvas();
    const bgSmall = env.makeCanvas();
    let lumaCanvas = null; // created on first use (only the monitor needs it)
    let lumaCache = null; // {at, frame, face}: mean brightness 0–255 of the whole frame and of the largest face
    let maskImage = null; // reused ImageData for the person mask
    const perf = {
      windowStart: 0, windowCount: 0, fps: null, inferMs: [], latencyMs: [], frameSize: null,
      dropped: 0, pct: null, pctAt: -Infinity,
    };

    function setEngine(mode, status) {
      if (engine.mode === mode && engine.status === status) return;
      engine = { mode, status };
      if (env.onEngine) env.onEngine({ ...engine });
    }

    function setState(next, info = null) {
      const changed = next !== state || JSON.stringify(info) !== JSON.stringify(stateInfo);
      state = next;
      stateInfo = info;
      if (changed) env.onState(next, info);
    }

    function clearCanvas(canvas) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    // Freshness watchdog: the frame on screen may be at most PENDING_TIMEOUT_MS old. A job's deadline belongs to
    // the frame in flight and is cancelled with it (dropJob, e.g. after a failed capture), so it cannot catch a
    // camera that stops delivering frames or a capture that keeps failing; this timer runs from the moment a
    // processed frame is shown and is re-armed by the next one.
    let freshTimer = null;

    function armFreshness() {
      disarmFreshness();
      const session = camSession;
      freshTimer = env.setTimeout(() => {
        freshTimer = null;
        if (session !== camSession || state !== "live") return; // stopped, restarted, or already hidden/error
        clearView(); // also blocks snapshots: they need a live, ready view
        setState("hidden", { why: "stale" });
        schedule(); // keep trying; the next processed frame shows the preview again
      }, PENDING_TIMEOUT_MS);
    }

    function disarmFreshness() {
      if (freshTimer !== null) env.clearTimeout(freshTimer);
      freshTimer = null;
    }

    function clearView() {
      viewReady = false;
      clearCanvas(env.view);
      clearCanvas(env.overlay);
      clearCanvas(buffer);
    }

    /** Drop the frame in the pipeline: cancel its deadline and close its bitmaps. Its late result is ignored. */
    function dropJob() {
      if (!job) return;
      env.clearTimeout(job.timer);
      // Its frame is already inside the engine: from now on the engine must answer within WORKER_STALL_MS.
      if (inWorker === job.id) armStall();
      if (job.frame) job.frame.close();
      if (job.copy) job.copy.close(); // null once transferred to the worker
      job = null;
    }

    // ---------- detector worker ----------
    function ensureWorker() {
      if (workerReady) return workerReady;
      const ready = new Promise((resolve, reject) => (pendingInit = { resolve, reject }));
      workerReady = ready;
      ready.catch(() => {}); // handled by whoever awaits it
      spawn(workerBroken && env.createFallbackWorker ? "fallback" : "worker");
      return ready; // spawn() may already have rejected it and cleared workerReady
    }

    /** Create the engine (`kind`: "worker" or "fallback") and start loading. Failing to create it is handled here. */
    function spawn(kind) {
      let created = null;
      let problem = null;
      try {
        created = kind === "fallback" ? env.createFallbackWorker() : env.createWorker();
      } catch (error) {
        problem = error;
      }
      if (!created) {
        if (kind === "worker" && env.createFallbackWorker) {
          workerBroken = true;
          spawn("fallback"); // no worker in this browser or page: run the detector on the main thread instead
          return;
        }
        const pending = pendingInit;
        resetWorker(); // forgets this attempt, so the next start tries again
        setEngine(kind, "error");
        if (pending) pending.reject(Object.assign(new Error("engine unavailable"), { name: errorName(problem), stage: "worker" }));
        return;
      }
      worker = created;
      workerMode = kind;
      setEngine(kind, "starting");
      // Messages from a worker that has since been replaced (restart) are ignored entirely.
      created.onmessage = (event) => worker === created && onWorkerMessage(event.data);
      created.onerror = (event) => worker === created && onWorkerFailure(event && event.message);
      created.postMessage({ type: "init" });
      if (settings.glasses || settings.monitor) requestLandmarker();
      if (settings.background !== "off") requestSegmenter();
    }

    /** The worker crashed before the detector was loaded: try the main-thread fallback once, keeping the same init promise. */
    function switchToFallback() {
      if (worker) worker.terminate();
      worker = null;
      detectorUp = false;
      inWorker = null;
      disarmStall();
      workerBroken = true;
      if (landmarker !== "off") setLandmarker("off");
      if (segmenter !== "off") setSegmenter("off");
      spawn("fallback");
    }

    function setSegmenter(next, message = null) {
      segmenter = next;
      if (env.onBackground) env.onBackground(next, message);
    }

    /** Load the segmenter in the worker (once, or again after an error). */
    function requestSegmenter({ recreate = false } = {}) {
      if (!worker || segmenter === "loading" || segmenter === "ready") return;
      setSegmenter("loading");
      // After an error the worker must drop the broken instance and build a new one.
      worker.postMessage({ type: "init-segmenter", recreate });
    }

    /** With a background on, a frame that cannot be cut out is hidden, never shown with its real background. */
    function hideForBackground() {
      clearView();
      setState("hidden", { why: segmenter === "error" ? "bgError" : segmenter === "ready" ? "bgInvalid" : "bgLoading" });
    }

    function setLandmarker(next, message = null) {
      landmarker = next;
      if (env.onEffect) env.onEffect(next, message);
    }

    /**
     * The glasses effect failed (landmarker load/runtime error, drawing error). Fail closed: turn the effect
     * off and face blur back on. `midCompose` is set when the current frame is being composed and will be
     * blurred right away, so the canvas must not be wiped under it.
     */
    function effectFailed(message, { midCompose = false } = {}) {
      setLandmarker("error", message);
      if (!settings.glasses) return;
      settings.glasses = false;
      settings.blurOn = true;
      if (!midCompose) {
        dropJob();
        clearView();
        if (state === "live" || state === "hidden") setState("hidden", { why: "pending" });
        if (stream && state !== "error") schedule();
      }
      if (env.onEffectFallback) env.onEffectFallback({ ...settings }, message);
    }

    /** Load the landmarker in the worker (once). Without a worker it is requested when one is created. */
    function requestLandmarker() {
      if (!worker || landmarker === "loading" || landmarker === "ready") return;
      // After an error (load or runtime) the worker must drop the broken instance and build a new one.
      const recreate = landmarker === "error";
      setLandmarker("loading");
      worker.postMessage({ type: "init-landmarker", recreate });
    }

    function resetWorker() {
      if (worker) worker.terminate();
      worker = null;
      workerMode = null;
      workerReady = null;
      detectorUp = false;
      pendingInit = null;
      inWorker = null; // a new engine has nothing queued
      disarmStall();
      disarmIdleRelease();
      if (engine.status !== "off") setEngine(engine.mode, "off");
      if (landmarker !== "off") setLandmarker("off"); // a new worker loads it again
      if (segmenter !== "off") setSegmenter("off");
    }

    function onWorkerMessage(msg) {
      // Every detect gets one answer (result or detect error): the engine is free again, however late the answer
      // is. A late answer is dropped below, but it lets the loop capture its next frame.
      const answered = (msg.type === "result" || (msg.type === "error" && msg.stage === "detect")) && inWorker !== null && msg.frameId === inWorker;
      if (answered) {
        inWorker = null;
        disarmStall();
      }
      try {
        dispatchWorkerMessage(msg);
      } finally {
        if (answered && !job && state !== "error") schedule(); // a stale answer: nothing else will wake the loop
      }
    }

    function dispatchWorkerMessage(msg) {
      if (msg.type === "ready") {
        detectorUp = true;
        setEngine(workerMode, "active");
        if (pendingInit) pendingInit.resolve(msg.initMs);
        pendingInit = null;
      } else if (msg.type === "landmarker-ready") {
        setLandmarker("ready");
      } else if (msg.type === "segmenter-ready") {
        setSegmenter("ready");
      } else if (msg.type === "segmenter-error") {
        setSegmenter("error", msg.message);
        if (settings.background !== "off" && (state === "live" || state === "hidden")) {
          dropJob();
          hideForBackground();
          if (stream) schedule();
        }
      } else if (msg.type === "landmarker-error") {
        effectFailed(msg.message);
      } else if (msg.type === "result") {
        // A result proves the engine works (an earlier transient detect error left the status at "error").
        if (detectorUp && workerMode && engine.status !== "active") setEngine(workerMode, "active");
        onResult(msg);
      } else if (msg.type === "error") {
        if (msg.stage === "init") {
          if (pendingInit) pendingInit.reject(Object.assign(new Error(msg.message), { name: errorName(msg) }));
          pendingInit = null;
        } else if (msg.session === camSession && job && msg.frameId === job.id) {
          // Errors for a frame that already timed out (or any older frame) are ignored like its result.
          fail("detector", errorName(msg));
        }
      }
    }

    function onWorkerFailure(message) {
      // A worker that cannot even start (blocked module worker, old browser): same detector on the main thread.
      if (pendingInit && workerMode === "worker" && env.createFallbackWorker) {
        switchToFallback();
        return;
      }
      // stage: a crash while the detector loads is still reported as a worker failure, not as a load failure.
      if (pendingInit) pendingInit.reject(Object.assign(new Error(message || "worker error"), { name: "WorkerError", stage: "worker" }));
      pendingInit = null;
      const mode = workerMode;
      resetWorker();
      setEngine(mode, "error");
      if (stream) fail("worker", "WorkerError");
    }

    function armStall() {
      if (stallTimer !== null || inWorker === null) return;
      const watched = inWorker;
      const watchedWorker = worker;
      stallTimer = env.setTimeout(() => {
        stallTimer = null;
        if (inWorker !== watched || worker !== watchedWorker) return; // it answered, or was replaced
        onWorkerStalled();
      }, WORKER_STALL_MS);
    }

    function disarmStall() {
      if (stallTimer !== null) env.clearTimeout(stallTimer);
      stallTimer = null;
    }

    /** No camera and no start in progress: let go of the engine after WORKER_IDLE_MS. */
    function armIdleRelease() {
      disarmIdleRelease();
      if (!worker) return;
      idleTimer = env.setTimeout(() => {
        idleTimer = null;
        if (!stream && state !== "prompt" && state !== "loading") resetWorker();
      }, WORKER_IDLE_MS);
    }

    function disarmIdleRelease() {
      if (idleTimer !== null) env.clearTimeout(idleTimer);
      idleTimer = null;
    }

    /** The engine never answered a frame: stop it (a hung worker is terminated). With the camera on this is an error. */
    function onWorkerStalled() {
      const mode = workerMode;
      resetWorker();
      if (stream) {
        setEngine(mode, "error");
        fail("worker", "WorkerStalled");
      }
    }

    // ---------- camera ----------
    async function start() {
      if (stream || state === "prompt" || state === "loading") stop();
      if (!env.isSecureContext || !env.mediaDevices || !env.mediaDevices.getUserMedia) {
        setState("insecure");
        return;
      }
      const id = ++camSession;
      disarmIdleRelease();
      // Reuse a warm engine only if it finished processing the last session's frame.
      if (inWorker !== null) resetWorker();
      setState("prompt");
      const ready = ensureWorker();

      let incoming;
      try {
        incoming = await env.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: settings.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (error) {
        if (id === camSession) {
          const next = errorState(error);
          setState(next, next === "error" ? { kind: "camera", name: errorName(error) } : { name: error && error.name });
          armIdleRelease(); // no camera: the engine started for it is not needed
        }
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
        setState("error", { kind: "play", name: errorName(error) });
        return;
      }
      if (id !== camSession) return;

      try {
        await withTimeout(ready, READY_TIMEOUT_MS, env);
      } catch (error) {
        if (id !== camSession) return;
        resetWorker();
        fail(loadFailureStage(error), errorName(error));
        return;
      }
      if (id !== camSession) return;
      schedule();
    }

    function onTrackEnded(id) {
      if (id !== camSession) return;
      stop("ended"); // the reason lets listeners tell a disconnected camera from Stop
      setState("ended");
    }

    /** Fully stop: camera off, loop cancelled, pending work dropped, canvas cleared. */
    function stop(reason = null) {
      camSession++;
      disarmFreshness();
      if (frameHandle !== null) env.cancelFrame(frameHandle);
      frameHandle = null;
      dropJob(); // keep watching any transferred frame until the engine answers or is terminated
      if (stream) stopTracks(stream);
      stream = null;
      if (env.video.pause) env.video.pause();
      env.video.srcObject = null;
      clearView();
      perf.windowStart = 0;
      perf.windowCount = 0;
      perf.fps = null;
      perf.inferMs.length = 0;
      perf.latencyMs.length = 0;
      perf.frameSize = null;
      perf.dropped = 0;
      perf.pct = null;
      lumaCache = null;
      setState("idle", reason ? { reason } : null);
      armIdleRelease();
    }

    /** Why the detector never became ready: the worker itself crashed, or the detector failed to load / timed out. */
    function loadFailureStage(error) {
      return error && error.stage === "worker" ? "worker" : "load";
    }

    /** kind: the stage that failed (load, detector, worker, render); name: the error's class name. */
    function fail(kind, name = "Error") {
      if (kind === "detector" || kind === "load" || kind === "worker") setEngine(workerMode || engine.mode || "worker", "error");
      disarmFreshness();
      if (frameHandle !== null) env.cancelFrame(frameHandle);
      frameHandle = null;
      dropJob();
      clearView();
      setState("error", { kind, name });
    }

    function restartDetector() {
      workerBroken = false; // an explicit retry tries the worker first again
      resetWorker();
      clearView();
      if (!stream) return start();
      const id = camSession;
      setState("loading");
      withTimeout(ensureWorker(), READY_TIMEOUT_MS, env).then(
        () => id === camSession && schedule(),
        (error) => {
          if (id !== camSession) return;
          resetWorker();
          fail(loadFailureStage(error), errorName(error));
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
      // The engine still holds an earlier frame: wait for its answer (onWorkerMessage wakes the loop).
      if (inWorker !== null) return;
      if (env.video.readyState < 2) {
        schedule();
        return;
      }
      capture();
    }

    async function capture() {
      // The deadline runs from the start of capture, so a stuck createImageBitmap also hides the preview.
      const current = {
        id: ++frameId, session: camSession, frame: null, copy: null, capturedAt: env.now(), timer: null,
        landmarks: (settings.glasses || settings.monitor) && landmarker === "ready",
        monitor: settings.monitor,
        segment: settings.background !== "off" && segmenter === "ready",
      };
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
      if (!worker || !detectorUp) {
        // The engine was replaced (and is still loading) while this frame was being captured: nowhere to send it.
        dropJob();
        schedule();
        return;
      }
      // Set before posting: an engine that answers inside postMessage must find the frame already registered.
      inWorker = current.id;
      try {
        worker.postMessage(
          {
            type: "detect", session: current.session, frameId: current.id, bitmap: current.copy,
            timestamp: env.now(), landmarks: current.landmarks, segment: current.segment,
          },
          [current.copy],
        );
      } catch (error) {
        // e.g. DataCloneError: nothing was sent (dropJob closes both bitmaps) and the engine cannot take frames.
        inWorker = null;
        if (live()) {
          dropJob();
          resetWorker();
          fail("worker", errorName(error));
        }
        return;
      }
      current.copy = null; // transferred: the worker closes it
    }

    function onDeadline(current) {
      if (job !== current) return;
      perf.dropped++;
      dropJob(); // this frame is now stale: its result will be ignored when it arrives
      // Fail closed whenever something must be hidden: faces (blur) or the real background (background on).
      if (settings.blurOn || settings.background !== "off") {
        clearView();
        setState("hidden", { why: "timeout" });
      }
      schedule(); // recover with the next new frame
      reportStats();
    }

    function onResult(msg) {
      // Only the result for the frame in the pipeline, in the current session, is used.
      if (msg.session !== camSession || !job || msg.frameId !== job.id) return;
      const current = job;
      job = null;
      env.clearTimeout(current.timer);

      const faces = msg.faces || [];
      // The result itself is still good: compose it below, blurred now that the effect has failed closed.
      if (current.landmarks && msg.landmarksError) effectFailed(msg.landmarksError, { midCompose: true });
      // Landmarks of this very frame, only if the effect is still on.
      const eyes = current.landmarks && settings.glasses && Array.isArray(msg.eyes) ? msg.eyes : [];
      // Monitor points of this very frame (null when the landmarker was not asked or failed).
      const marks = current.landmarks && Array.isArray(msg.marks) && !msg.landmarksError ? msg.marks : null;
      const overlayMarks = settings.monitor && settings.showLandmarks ? marks : null;
      let shown = false; // whether this frame reached the screen
      current.frameW = current.frame.width;
      current.frameH = current.frame.height;
      if (current.monitor && settings.monitor) sampleLuma(current, faces);
      try {
        // A runtime segmentation failure for this very frame (session and frameId already matched above):
        // the segmenter is now in error; the frame is hidden below and Retry recreates the segmenter.
        if (settings.background !== "off" && current.segment && msg.maskError) setSegmenter("error", msg.maskError);
        // Mask of this very frame, only if a background is still on and it was asked for this frame.
        const mask = settings.background !== "off" && current.segment && validMask(msg.mask, current.frame) ? msg.mask : null;
        if (settings.blurOn && faces.length === 0) {
          clearView();
          setState("hidden", { why: "noface" });
        } else if (settings.background !== "off" && !mask) {
          hideForBackground();
        } else if (compose(current.frame, faces, eyes, mask, overlayMarks)) {
          setState("live", { faces: faces.length, blurOn: settings.blurOn });
          armFreshness();
          shown = true;
        } else {
          // An effect failure inside compose turned blur back on and there is no face to blur.
          setState("hidden", { why: "noface" });
        }
      } catch (error) {
        fail("render", errorName(error)); // clears the canvas; nothing half-drawn stays visible
        return;
      } finally {
        current.frame.close();
      }
      if (current.monitor && settings.monitor) analyse(current, faces, marks, msg.landmarksError, shown, lumaOf(current));
      record(msg.inferMs, env.now() - current.capturedAt);
      schedule();
    }

    /** Hand this frame's monitor input to the page. A failure there must never stop the camera pipeline. */
    function analyse(current, faces, marks, landmarksError, shown, luma) {
      if (!env.onAnalysis) return;
      const error = landmarksError || (current.landmarks ? null : landmarker === "error" ? "landmarker" : null);
      try {
        env.onAnalysis({
          at: current.capturedAt, faces: faces.length, marks, error: error ? String(error) : null, shown,
          // Raw detector boxes and the frame size (frame-quality cues), and the brightness sampled from this frame.
          boxes: faces.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h })), frame: { w: current.frameW, h: current.frameH }, luma,
        });
      } catch (err) {
        if (global.console) global.console.error(err);
      }
    }

    /**
     * Brightness cue for the frame-quality status: the mean luma (0–255) of a LUMA_SIZE² reduction of the whole frame
     * and of the largest detected face. Sampled at most every LUMA_EVERY_MS. Only two numbers are kept: the reduced
     * image is wiped right away and never shown, stored or sent. A failure just means "no brightness reading".
     */
    function sampleLuma(current, faces) {
      const now = env.now();
      if (lumaCache && now - lumaCache.at < LUMA_EVERY_MS) return;
      let reading = { at: now, frame: null, face: null };
      try {
        if (!lumaCanvas) {
          lumaCanvas = env.makeCanvas();
          lumaCanvas.width = LUMA_SIZE;
          lumaCanvas.height = LUMA_SIZE;
        }
        const frame = current.frame;
        reading.frame = meanLuma(frame, 0, 0, frame.width, frame.height);
        const largest = faces.reduce((best, f) => (!best || f.w * f.h > best.w * best.h ? f : best), null);
        if (largest) {
          const x0 = Math.max(0, Math.floor(largest.x));
          const y0 = Math.max(0, Math.floor(largest.y));
          const x1 = Math.min(frame.width, Math.ceil(largest.x + largest.w));
          const y1 = Math.min(frame.height, Math.ceil(largest.y + largest.h));
          if (x1 - x0 >= 8 && y1 - y0 >= 8) reading.face = meanLuma(frame, x0, y0, x1 - x0, y1 - y0);
        }
      } catch (_) {
        reading = { at: now, frame: null, face: null };
      }
      lumaCache = reading;
    }

    function meanLuma(frame, sx, sy, sw, sh) {
      const ctx = lumaCanvas.getContext("2d", { willReadFrequently: true });
      let image;
      try {
        ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, LUMA_SIZE, LUMA_SIZE);
        image = ctx.getImageData(0, 0, LUMA_SIZE, LUMA_SIZE);
      } finally {
        ctx.clearRect(0, 0, LUMA_SIZE, LUMA_SIZE);
      }
      const data = image && image.data;
      if (!data || data.length < 4) return null;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      return sum / (data.length / 4);
    }

    /** The latest brightness reading for the monitor (null until the first one). */
    function lumaOf() {
      return lumaCache ? { frame: lumaCache.frame, face: lumaCache.face } : null;
    }

    /** Draw one processed frame. Returns false (and leaves every canvas cleared) if it must not be shown. */
    function compose(frame, faces, eyes = [], mask = null, marks = null) {
      const width = frame.width;
      const height = frame.height;
      for (const canvas of [buffer, env.view, env.overlay]) {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      }
      const bctx = buffer.getContext("2d");
      bctx.clearRect(0, 0, width, height);
      if (mask) {
        drawBackground(bctx, frame, width, height);
        drawForeground(bctx, frame, mask, width, height);
      } else {
        bctx.drawImage(frame, 0, 0);
      }
      if (eyes.length) {
        // An effect error must never cost the blur: turn the effect off and carry on.
        try {
          eyes.forEach((eye) => drawGlasses(bctx, eye, settings.glassesSize / 100));
        } catch (error) {
          // Blur is switched back on before the blur step below, so this very frame is blurred.
          effectFailed(String((error && error.message) || error), { midCompose: true });
        }
      }
      // The effect step may have switched blur back on: re-check the fail-closed rule before anything
      // reaches the screen. With blur on and no face, nothing of this frame may be shown.
      if (settings.blurOn && faces.length === 0) {
        clearView();
        return false;
      }
      const boxes = faces.map((face) => boxFor(face, width, height)).filter(Boolean);
      // Hiding faces is the last layer, over any effect.
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
      if (marks && marks.length && env.drawLandmarks) {
        // Only an overlay: a drawing problem clears it but never costs the frame or the blur under it.
        try {
          env.drawLandmarks(octx, marks, width);
        } catch (_) {
          octx.clearRect(0, 0, width, height);
        }
      }
      perf.frameSize = { w: width, h: height };
      viewReady = true;
      return true;
    }

    function drawBackground(ctx, frame, width, height) {
      if (settings.background === "image" && backgroundImage) {
        drawCover(ctx, backgroundImage, width, height, settings.mirror);
        return;
      }
      const reduce = BG_REDUCE[settings.bgBlur] || BG_REDUCE[2];
      bgSmall.width = Math.max(1, Math.round(width / reduce));
      bgSmall.height = Math.max(1, Math.round(height / reduce));
      const sctx = bgSmall.getContext("2d");
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(frame, 0, 0, bgSmall.width, bgSmall.height);
      ctx.save();
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bgSmall, 0, 0, bgSmall.width, bgSmall.height, 0, 0, width, height);
        ctx.filter = `blur(${Math.max(2, Math.round(reduce / 2))}px)`;
        ctx.drawImage(bgSmall, 0, 0, bgSmall.width, bgSmall.height, 0, 0, width, height);
      } finally {
        ctx.restore();
      }
    }

    function drawForeground(ctx, frame, mask, width, height) {
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
      const mctx = maskCanvas.getContext("2d");
      // One ImageData is reused while the mask size stays the same (a new one per frame is needless garbage).
      // Its colour channels stay 0: only alpha is written, which is all the destination-in step needs.
      if (!maskImage || maskImage.width !== mask.width || maskImage.height !== mask.height) {
        maskImage = mctx.createImageData(mask.width, mask.height);
      }
      for (let i = 0; i < mask.alpha.length; i++) maskImage.data[i * 4 + 3] = mask.alpha[i];
      mctx.putImageData(maskImage, 0, 0);
      foreground.width = width;
      foreground.height = height;
      const fctx = foreground.getContext("2d");
      fctx.globalCompositeOperation = "source-over";
      fctx.clearRect(0, 0, width, height);
      fctx.drawImage(frame, 0, 0);
      fctx.globalCompositeOperation = "destination-in"; // keep the person only
      fctx.imageSmoothingEnabled = true;
      fctx.drawImage(maskCanvas, 0, 0, mask.width, mask.height, 0, 0, width, height);
      fctx.globalCompositeOperation = "source-over";
      ctx.drawImage(foreground, 0, 0);
    }

    /** Replace (or remove, with null) the background image. The previous bitmap is closed. */
    function setBackgroundImage(bitmap) {
      if (backgroundImage && backgroundImage !== bitmap) backgroundImage.close();
      backgroundImage = bitmap || null;
      if (!backgroundImage && settings.background === "image") applyBackground({ background: "off" });
      else if (settings.background === "image") backgroundChanged();
    }

    /** Background settings changed: drop the frame in flight and keep the preview covered (and snapshots
     *  blocked) until a frame processed with the new settings arrives. */
    function backgroundChanged() {
      dropJob();
      clearView();
      if (state === "live" || state === "hidden") setState("hidden", { why: "bgPending" });
      if (stream && state !== "error") schedule();
    }

    function applyBackground(partial) {
      const next = { ...settings, ...partial };
      if (next.background === "image" && !backgroundImage) next.background = settings.background;
      if (!["off", "blur", "image"].includes(next.background)) next.background = settings.background;
      const changed =
        next.background !== settings.background ||
        (next.background === "blur" && next.bgBlur !== settings.bgBlur) ||
        (next.background === "image" && next.mirror !== settings.mirror);
      Object.assign(settings, { background: next.background, bgBlur: next.bgBlur, mirror: next.mirror });
      if (settings.background !== "off") requestSegmenter();
      if (changed) backgroundChanged();
    }

    function canSnapshot() {
      return Boolean(stream) && state === "live" && viewReady;
    }

    /**
     * Copy the visible processed canvas (no boxes, no HUD) into a new canvas, flipped like the preview when
     * `mirror` is set. Returns null when there is no fully processed frame on screen.
     */
    function snapshot({ mirror = false } = {}) {
      if (!canSnapshot()) return null;
      const out = env.makeCanvas();
      out.width = env.view.width;
      out.height = env.view.height;
      const ctx = out.getContext("2d");
      if (mirror) {
        ctx.translate(out.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(env.view, 0, 0);
      return out;
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
      reportStats();
    }

    /** A failure in the telemetry UI must leave the camera loop running. */
    function reportStats() {
      try {
        if (env.onStats) env.onStats(stats());
      } catch (err) {
        if (global.console) global.console.error(err);
      }
    }

    /** Percentiles sort two arrays of up to 600 values: refresh them twice a second, not on every frame. */
    function percentiles() {
      const now = env.now();
      if (!perf.pct || now - perf.pctAt >= STATS_EVERY_MS) {
        perf.pct = {
          inferP50: percentile(perf.inferMs, 50),
          inferP95: percentile(perf.inferMs, 95),
          latencyP50: percentile(perf.latencyMs, 50),
          latencyP95: percentile(perf.latencyMs, 95),
        };
        perf.pctAt = now;
      }
      return perf.pct;
    }

    function stats() {
      return {
        fps: perf.fps,
        latencyMs: perf.latencyMs.at(-1) ?? null,
        ...percentiles(),
        samples: perf.latencyMs.length,
        frameSize: perf.frameSize,
        dropped: perf.dropped, // frames that missed their deadline since the camera started
        engine: { ...engine },
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
        const { background, bgBlur, mirror, ...rest } = partial;
        if (background !== undefined || bgBlur !== undefined || mirror !== undefined) {
          // Background changes never change the blur/glasses choice.
          applyBackground({
            ...(background !== undefined && { background }),
            ...(bgBlur !== undefined && { bgBlur }),
            ...(mirror !== undefined && { mirror }),
          });
        }
        partial = rest;
        const next = { ...settings, ...partial };
        // Glasses and face blur are exclusive: glasses ON turns blur OFF, blur ON turns glasses OFF.
        // Turning glasses off never turns blur back on (that stays the user's explicit choice).
        if (partial.glasses === true) next.blurOn = false;
        if (partial.blurOn === true) {
          next.blurOn = true;
          next.glasses = false;
        }
        const blurTurnedOn = next.blurOn && !settings.blurOn;
        const modeChanged = next.blurOn !== settings.blurOn || next.glasses !== settings.glasses;
        Object.assign(settings, next);
        // Turning the effect or the monitor on (again) loads the landmarker, or retries it after an error.
        if ((partial.glasses === true || partial.monitor === true) && landmarker !== "ready") requestLandmarker();
        if (modeChanged) {
          // A frame captured under the old mode must not be drawn under the new one.
          dropJob();
          if (blurTurnedOn) {
            // Nothing captured or drawn while blur was off may stay visible: wipe it and show only frames
            // that are captured and processed with blur on.
            clearView();
            if (state === "live" || state === "hidden") setState("hidden", { why: "pending" });
          }
          // The dropped job may have been the only thing keeping the loop alive (e.g. the first frame
          // while still "loading"), so always ask for the next frame. tick() waits for the detector.
          if (stream && state !== "error") schedule();
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
      snapshot,
      canSnapshot,
      setBackgroundImage,
      /** Retry loading the landmarker after an error (monitor or glasses). */
      retryLandmarks() {
        if (landmarker === "error" || landmarker === "off") requestLandmarker();
      },
      /** Retry loading the segmenter after an error. */
      retryBackground() {
        if (segmenter === "error") requestSegmenter({ recreate: true });
      },
      /** Release the background image (page is going away). */
      dispose() {
        stop();
        setBackgroundImage(null);
        resetWorker(); // the worker holds the models in memory: release it with the page
      },
      /** Detector engine for the telemetry: {mode: "worker" | "fallback" | null, status: "off" | "starting" | "active" | "error"}. */
      get engine() {
        return { ...engine };
      },
      get effect() {
        return landmarker;
      },
      get background() {
        return { mode: settings.background, segmenter, hasImage: Boolean(backgroundImage) };
      },
    };
  }

  global.createCameraController = createCameraController;
  global.liveCameraInternals = { boxFor, obscure, drawGlasses, PENDING_TIMEOUT_MS };
})(typeof window !== "undefined" ? window : globalThis);
