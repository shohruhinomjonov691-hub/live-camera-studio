"use strict";

// Alertness monitor: turns the face landmarks of each processed camera frame into visible signals (eye openness,
// mouth openness, approximate head direction), measures how long the eyes stay closed without a break, and
// raises a "possible drowsiness cue" after a configurable duration. It also keeps an in-memory event history.
//
// What this is NOT: it does not detect sleep, emotions, medical conditions or driving fitness. The signals are
// geometric ratios of MediaPipe face-mesh points on one camera image; thresholds are heuristics.
//
// Rules:
// - Only results of real processed frames are used (the camera controller passes landmarks of the very frame it
//   just processed). Nothing is interpolated or invented.
// - The closure timer counts only while one face is tracked, roughly facing the camera, in consecutive frames.
//   No face, several faces, an invalid result, a frame gap, a turned head, a pause, Stop, a hidden page or a
//   camera error all reset it (and end an active alert).
// - Nothing leaves the browser; history lives in memory and is gone when the page closes.
//
// Besides the closure timer it reports (all from the same real frames, none of it diagnostic):
// - face count (from the detector) and head pose: direction (left/right/up/down) and an approximate left/right angle;
// - a frame-quality status: normal | lowLight | outOfFrame | recalibrate (or unknown when there is nothing to judge).
(function (global) {
  // MediaPipe face-mesh indices, in the order the worker sends them (flat [x0, y0, x1, y1, ...] per face).
  // Keep in sync with app/static/detector-core.mjs (a test checks this).
  const MONITOR_LANDMARKS = {
    // Eye aspect ratio order: corner, upper, upper, corner, lower, lower.
    eyeR: [33, 160, 158, 133, 153, 144],
    eyeL: [362, 385, 387, 263, 373, 380],
    mouth: [13, 14, 78, 308], // inner lips top/bottom, mouth corners
    lips: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146], // drawing only
    head: [1, 152, 234, 454, 10], // nose tip, chin, cheek right side of image, cheek left side, forehead
    oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
      149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  };
  const GROUPS = Object.keys(MONITOR_LANDMARKS);
  const OFFSETS = {};
  let total = 0;
  for (const name of GROUPS) {
    OFFSETS[name] = total;
    total += MONITOR_LANDMARKS[name].length;
  }
  const POINT_COUNT = total;
  const MONITOR_POINT_INDICES = GROUPS.flatMap((name) => MONITOR_LANDMARKS[name]);

  const DEFAULTS = {
    alertAfterMs: 2000, // eyes closed this long without a break -> cue
    sound: true,
  };
  const ALERT_RANGE = { min: 1000, max: 5000, step: 500 };
  // Eye aspect ratio of open eyes before calibration (typical for this mesh; calibration replaces it).
  const DEFAULT_BASELINE = 0.3;
  const CLOSE_RATIO = 0.65; // closed below baseline * CLOSE_RATIO
  const OPEN_RATIO = 0.8; // open again above baseline * OPEN_RATIO (hysteresis)
  const MOUTH_OPEN = 0.3; // inner-lip gap / mouth width
  const YAW_RANGE = [0.3, 0.7]; // nose position between the cheeks counted as "facing the camera"
  const PITCH_RANGE = [0.2, 0.62]; // nose position between eye line and chin counted as level
  const MAX_GAP_MS = 1000; // frames further apart than this break a closure episode
  const MIN_EYE_WIDTH = 4; // px; smaller eyes are not measured
  const CALIBRATION_MS = 3000;
  const CALIBRATION_MIN_SAMPLES = 15;
  const BASELINE_RANGE = [0.15, 0.5];
  const CHART_WINDOW_MS = 30000;
  const MAX_EVENTS = 200;
  const MAX_SESSIONS = 20;
  // Frame quality. Brightness is the mean luma (0–255) of the face, or of the whole frame when no face is found;
  // two thresholds (hysteresis) keep the warning from flickering. These are heuristics, not measurements of exposure.
  const LOW_LIGHT_ENTER = 55;
  const LOW_LIGHT_EXIT = 70;
  const EDGE_TOUCH = 0.01; // a face box this close to the frame edge (fraction of the frame) counts as cut off
  const EDGE_EXIT = 0.08; // a face that vanishes while its box was this close to an edge has left the frame
  const EXIT_MS = 2000; // ... for this long after it was last seen
  const VISIBLE_MIN = 0.9; // less of the face box inside the frame than this: partial
  const QUALITY_HOLD_MS = 1000; // a level must hold this long before it is shown
  // Recalibration is advised when open-eye readings sit persistently far from the baseline (relative to it).
  const RECAL_WINDOW_MS = 12000;
  const RECAL_MIN_SPAN_MS = 8000;
  const RECAL_MIN_SAMPLES = 40;
  const RECAL_HIGH = 1.4; // median above this: the baseline is too low, closing eyes would not be noticed
  const RECAL_LOW = 0.78; // median between CLOSE_RATIO and this: open eyes sit next to the closing threshold
  const RECAL_EVERY_MS = 500;

  const point = (marks, group, i) => {
    const k = (OFFSETS[group] + i) * 2;
    return { x: marks[k], y: marks[k + 1] };
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function eyeRatio(marks, group) {
    const p = [0, 1, 2, 3, 4, 5].map((i) => point(marks, group, i));
    const width = dist(p[0], p[3]);
    return { width, ratio: width > 0 ? (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * width) : NaN };
  }

  /**
   * Geometric signals of one face (flat landmark array in MONITOR_LANDMARKS order, frame pixels), or null if the
   * result is not usable (wrong size, non-finite values, eyes too small).
   */
  function measure(marks) {
    if (!marks || marks.length !== POINT_COUNT * 2) return null;
    for (let i = 0; i < marks.length; i++) if (!Number.isFinite(marks[i])) return null;
    const right = eyeRatio(marks, "eyeR");
    const left = eyeRatio(marks, "eyeL");
    if (!(right.width >= MIN_EYE_WIDTH && left.width >= MIN_EYE_WIDTH)) return null;
    const ear = (right.ratio + left.ratio) / 2;
    const mouthWidth = dist(point(marks, "mouth", 2), point(marks, "mouth", 3));
    const mar = mouthWidth > 0 ? dist(point(marks, "mouth", 0), point(marks, "mouth", 1)) / mouthWidth : NaN;
    const nose = point(marks, "head", 0);
    const chin = point(marks, "head", 1);
    const cheekA = point(marks, "head", 2);
    const cheekB = point(marks, "head", 3);
    const span = cheekB.x - cheekA.x;
    const yaw = span !== 0 ? (nose.x - cheekA.x) / span : NaN;
    const eyeLine = (point(marks, "eyeR", 0).y + point(marks, "eyeL", 3).y) / 2;
    const drop = chin.y - eyeLine;
    const pitch = drop > 0 ? (nose.y - eyeLine) / drop : NaN;
    if (![ear, mar, yaw, pitch].every(Number.isFinite)) return null;
    let head = "centered";
    if (yaw < YAW_RANGE[0] || yaw > YAW_RANGE[1]) head = "turned";
    else if (pitch > PITCH_RANGE[1]) head = "down";
    else if (pitch < PITCH_RANGE[0]) head = "up";
    // Approximate left/right angle from the nose position between the cheeks (nose offset ~ sin of the angle).
    // The camera image is not mirrored, so a nose nearer image-left (landmark 234 side) is the person's RIGHT.
    // Positive = turned to the person's left. Only a rough indicator: it is not a calibrated head-pose estimate.
    const yawDeg = (Math.asin(Math.max(-1, Math.min(1, (yaw - 0.5) * 2))) * 180) / Math.PI;
    return { ear, mar, yaw, pitch, yawDeg, head, mouth: mar > MOUTH_OPEN ? "open" : "closed" };
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * options: { toWall(at) -> epoch ms for an `at` timestamp, onChange(snapshot), onAlert(alert), settings }
   * Timestamps `at` are the controller's capture times (performance.now() clock).
   */
  function createAlertnessMonitor(options = {}) {
    const toWall = options.toWall || ((at) => at);
    const settings = { ...DEFAULTS, ...(options.settings || {}) };
    settings.alertAfterMs = clampAlert(settings.alertAfterMs);
    let baseline = DEFAULT_BASELINE;
    let calibrated = false;
    let calibration = null; // {until, samples} while collecting; status kept in calibrationStatus
    let calibrationStatus = "none"; // none | running | done | failed
    let session = null; // {id, startedAt, endedAt, events: []}
    const sessions = []; // finished sessions, newest first
    let sessionSeq = 0;
    let paused = false;
    let status = "idle"; // idle | waiting | tracking | noface | multiple | invalid | turned | paused | unavailable
    let lastAt = null;
    let eyes = "unknown"; // open | closed | unknown
    let closedSince = null;
    let alert = null; // {since, firedAt, at, dismissed}
    let metrics = null; // last measure() result of a tracked face
    let chart = []; // [{at, value}] value = ear / baseline (relative openness)
    let lastTracked = null; // status before tracking was lost, to log "resumed" once
    let faces = null; // detector face count of the last frame (null: no frame)
    let lowLight = false;
    let lastFace = null; // {at, edge} last frame with a face: was it close to an edge?
    let quality = "unknown"; // shown level: unknown | normal | lowLight | outOfFrame | recalibrate
    let qualityCandidate = null; // {level, since}: a new level waiting out QUALITY_HOLD_MS
    let recal = []; // [{at, ratio}] open-eye readings of tracked, centered frames (ratio = ear / baseline)
    let recalNeeded = false;
    let recalCheckedAt = -Infinity;

    function clampAlert(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n)) return DEFAULTS.alertAfterMs;
      const stepped = Math.round(n / ALERT_RANGE.step) * ALERT_RANGE.step;
      return Math.min(ALERT_RANGE.max, Math.max(ALERT_RANGE.min, stepped));
    }

    function log(type, at, detail = null) {
      if (!session) return;
      session.events.push({ type, wall: toWall(at), detail });
      if (session.events.length > MAX_EVENTS) {
        // Frame-quality changes can flap (light around a threshold): they are the first to go, so they can never push
        // out "started", a cue or the tracking events.
        const noise = session.events.findIndex((e) => e.type === "quality");
        session.events.splice(noise >= 0 ? noise : 0, 1);
      }
    }

    function emit() {
      if (options.onChange) options.onChange(snapshot());
    }

    /** End any closure episode (and its alert). `at` is used for the "reopened"/"ended" log only. */
    function resetClosure(at, reason) {
      if (alert && session) log("alertEnded", at, { reason, closedMs: Math.round(at - alert.since) });
      alert = null;
      closedSince = null;
      eyes = "unknown";
      recal = []; // tracking was interrupted: the recalibration check needs one unbroken stretch
    }

    function resetQuality() {
      faces = null;
      lowLight = false;
      lastFace = null;
      quality = "unknown";
      qualityCandidate = null;
      recal = [];
      recalNeeded = false;
      recalCheckedAt = -Infinity;
    }

    /** True when `box` ({x, y, w, h}, frame pixels) is cut by the frame or touches its edge. */
    function boxPartial(box, frame) {
      const { w: W, h: H } = frame;
      const x1 = Math.min(W, box.x + box.w);
      const y1 = Math.min(H, box.y + box.h);
      const x0 = Math.max(0, box.x);
      const y0 = Math.max(0, box.y);
      const visible = x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / (box.w * box.h) : 0;
      const touching = box.x <= W * EDGE_TOUCH || box.y <= H * EDGE_TOUCH || box.x + box.w >= W * (1 - EDGE_TOUCH) || box.y + box.h >= H * (1 - EDGE_TOUCH);
      return visible < VISIBLE_MIN || touching;
    }

    function boxNearEdge(box, frame) {
      return box.x <= frame.w * EDGE_EXIT || box.y <= frame.h * EDGE_EXIT || box.x + box.w >= frame.w * (1 - EDGE_EXIT) || box.y + box.h >= frame.h * (1 - EDGE_EXIT);
    }

    const validBox = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;

    function needsRecalibration(at) {
      if (calibrationStatus === "failed") return true;
      if (at - recalCheckedAt < RECAL_EVERY_MS) return recalNeeded;
      recalCheckedAt = at;
      recalNeeded = false;
      while (recal.length && recal[0].at < at - RECAL_WINDOW_MS) recal.shift();
      if (!alert && recal.length >= RECAL_MIN_SAMPLES && recal[recal.length - 1].at - recal[0].at >= RECAL_MIN_SPAN_MS) {
        const med = median(recal.map((r) => r.ratio));
        recalNeeded = med > RECAL_HIGH || (med >= CLOSE_RATIO && med < RECAL_LOW);
      }
      return recalNeeded;
    }

    /** The quality level this frame alone points to (before the hold time). */
    function rawQuality(sample, at) {
      const n = Number.isFinite(sample.faces) ? sample.faces : null;
      const luma = sample.luma && Number.isFinite(sample.luma.face) ? sample.luma.face : sample.luma && Number.isFinite(sample.luma.frame) ? sample.luma.frame : null;
      if (luma !== null) {
        if (luma < LOW_LIGHT_ENTER) lowLight = true;
        else if (luma > LOW_LIGHT_EXIT) lowLight = false;
      }
      if (lowLight) return "lowLight";
      const frame = sample.frame && sample.frame.w > 0 && sample.frame.h > 0 ? sample.frame : null;
      const boxes = frame && Array.isArray(sample.boxes) ? sample.boxes.filter(validBox) : [];
      if (n > 0 && boxes.length) {
        const largest = boxes.reduce((best, b) => (b.w * b.h > best.w * best.h ? b : best));
        lastFace = { at, edge: boxNearEdge(largest, frame) };
        if (boxes.some((b) => boxPartial(b, frame))) return "outOfFrame";
      } else if (n === 0 && lastFace && lastFace.edge && at - lastFace.at <= EXIT_MS) {
        return "outOfFrame"; // the face vanished next to an edge: it left the frame
      }
      if (n === 0 || n === null) return "unknown"; // nothing to judge
      return needsRecalibration(at) ? "recalibrate" : "normal";
    }

    function assessQuality(sample, at) {
      const raw = rawQuality(sample, at);
      if (raw === quality) {
        qualityCandidate = null;
        return;
      }
      if (!qualityCandidate || qualityCandidate.level !== raw) qualityCandidate = { level: raw, since: at };
      if (at - qualityCandidate.since < QUALITY_HOLD_MS) return;
      const previous = quality;
      quality = raw;
      qualityCandidate = null;
      // History: a warning is logged when it starts, and when it ends in a normal reading (never on unknown).
      if (raw === "normal" ? previous !== "unknown" : raw !== "unknown") log("quality", at, { level: raw });
    }

    function setStatus(next, at) {
      if (next === "noface") cancelCalibration();
      if (next === status) return;
      const wasTracking = status === "tracking" || status === "turned";
      // Logged only after a face was really tracked (or when one lost state turns into another), so a session
      // that starts without a face logs nothing.
      const LOST = ["noface", "multiple", "invalid"];
      if (LOST.includes(next) && (wasTracking || (LOST.includes(status) && lastTracked))) {
        log(next === "noface" ? "lost" : next === "multiple" ? "multiple" : "invalid", at);
        lastTracked = next;
      }
      if ((next === "tracking" || next === "turned") && lastTracked) {
        log("resumed", at);
        lastTracked = null;
      }
      status = next;
    }

    function startSession(at) {
      if (session) return;
      session = { id: ++sessionSeq, startedAt: toWall(at), endedAt: null, events: [], alerts: 0 };
      paused = false;
      status = "waiting";
      lastAt = null;
      lastTracked = null;
      chart = [];
      resetQuality();
      log("started", at);
      emit();
    }

    /** Camera stopped, ended or failed, or the page was hidden: end the session and clear every timer. */
    function endSession(at, reason = "stopped") {
      resetClosure(at, reason);
      cancelCalibration();
      if (session) {
        log("stopped", at, { reason });
        session.endedAt = toWall(at);
        sessions.unshift(session);
        sessions.splice(MAX_SESSIONS);
      }
      session = null;
      status = "idle";
      metrics = null;
      lastAt = null;
      chart = [];
      resetQuality();
      emit();
    }

    /** No fresh frames (preview hidden as stale/timeout): the closure timer must not keep running. */
    function interrupt(at, reason) {
      if (!session) return;
      resetClosure(at, reason);
      metrics = null;
      lastAt = null;
      resetQuality(); // no fresh frames: there is nothing current to judge
      if (!paused) status = "waiting";
      emit();
    }

    function cancelCalibration() {
      if (calibrationStatus === "running") calibrationStatus = "none";
      calibration = null;
    }

    /**
     * One processed frame. sample: {at, faces (detector count), marks: array of flat landmark arrays (one per
     * face) | null when landmarks are not available, error: string|null, shown: false if the preview hid this frame}
     */
    function update(sample) {
      if (!session) startSession(sample.at);
      const at = sample.at;
      if (lastAt !== null && at - lastAt > MAX_GAP_MS) resetClosure(at, "gap");
      if (lastAt !== null && at < lastAt) return snapshot(); // out of order: ignore
      lastAt = at;
      faces = Number.isFinite(sample.faces) ? sample.faces : null;
      assessQuality(sample, at);
      if (paused) {
        status = "paused";
        emit();
        return snapshot();
      }
      // Status priority: no detected face, then a hidden preview, then landmark availability, then the landmarks.
      // The face detector decides whether there is a face: landmarks without a detected face are not tracking
      // (with blur on, that frame is hidden too).
      if (sample.faces === 0) {
        resetClosure(at, "noface");
        metrics = null;
        setStatus("noface", at);
        emit();
        return snapshot();
      }
      if (sample.shown === false) {
        // The preview hid this frame (e.g. no valid background mask): it is not counted as normal tracking.
        resetClosure(at, "previewHidden");
        metrics = null;
        setStatus("hidden", at);
        emit();
        return snapshot();
      }
      if (!Array.isArray(sample.marks)) {
        resetClosure(at, "unavailable");
        metrics = null;
        status = sample.error ? "unavailable" : "waiting";
        emit();
        return snapshot();
      }
      if (sample.marks.length === 0) {
        resetClosure(at, "noface");
        metrics = null;
        setStatus("noface", at);
        emit();
        return snapshot();
      }
      if (sample.marks.length > 1 || sample.faces > 1) {
        resetClosure(at, "multiple");
        metrics = null;
        setStatus("multiple", at);
        emit();
        return snapshot();
      }
      const m = measure(sample.marks[0]);
      if (!m) {
        resetClosure(at, "invalid");
        metrics = null;
        setStatus("invalid", at);
        emit();
        return snapshot();
      }
      metrics = m;
      chart.push({ at, value: Math.min(1.5, m.ear / baseline) });
      while (chart.length && chart[0].at < at - CHART_WINDOW_MS) chart.shift();
      if (m.head !== "centered") {
        // A turned or tilted head changes the eye shape in the image: the eyes are not judged.
        resetClosure(at, "head");
        setStatus("turned", at);
        emit();
        return snapshot();
      }
      setStatus("tracking", at);
      recal.push({ at, ratio: m.ear / baseline });
      // Trim here too: while a warning (low light, out of frame) is shown the check below does not run, and an
      // untrimmed window would grow for as long as the warning lasts.
      while (recal.length && recal[0].at < at - RECAL_WINDOW_MS) recal.shift();
      collectCalibration(m, at);
      judgeEyes(m, at);
      emit();
      return snapshot();
    }

    function judgeEyes(m, at) {
      const closeAt = baseline * CLOSE_RATIO;
      const openAt = baseline * OPEN_RATIO;
      if (eyes !== "closed" && m.ear < closeAt) {
        eyes = "closed";
        closedSince = at;
      } else if (eyes === "closed" && m.ear > openAt) {
        if (alert) log("reopened", at, { closedMs: Math.round(at - closedSince) });
        alert = null;
        eyes = "open";
        closedSince = null;
      } else if (eyes === "unknown") {
        // First judgement of an episode: not closed means open. The hysteresis only delays closed -> open.
        eyes = "open";
      }
      if (eyes === "closed" && !alert && at - closedSince >= settings.alertAfterMs) {
        alert = { since: closedSince, at, dismissed: false };
        if (session) session.alerts++;
        log("alert", at, { closedMs: Math.round(at - closedSince), afterMs: settings.alertAfterMs });
        if (options.onAlert) options.onAlert({ closedMs: at - closedSince, sound: settings.sound });
      }
      if (alert) alert.at = at;
    }

    function collectCalibration(m, at) {
      if (!calibration) return;
      calibration.samples.push(m.ear);
      if (at < calibration.until) return;
      const samples = calibration.samples;
      calibration = null;
      const value = samples.length >= CALIBRATION_MIN_SAMPLES ? median(samples) : NaN;
      if (value >= BASELINE_RANGE[0] && value <= BASELINE_RANGE[1]) {
        baseline = value;
        calibrated = true;
        calibrationStatus = "done";
        recalNeeded = false;
        log("calibrated", at);
        resetClosure(at, "calibrated");
      } else {
        calibrationStatus = "failed";
      }
    }

    function snapshot() {
      const closedMs = eyes === "closed" && closedSince !== null && lastAt !== null ? lastAt - closedSince : 0;
      return {
        active: Boolean(session),
        status,
        paused,
        eyes: status === "tracking" ? eyes : "unknown",
        closedMs,
        mouth: metrics ? metrics.mouth : "unknown",
        head: metrics ? metrics.head : "unknown",
        // Head pose: the person's own left/right, to the nearest 5 degrees (positive yawDeg = turned left).
        yawDeg: metrics ? Math.round(metrics.yawDeg / 5) * 5 : null,
        faces, // detector count of the last frame, null while there is none
        quality, // unknown | normal | lowLight | outOfFrame | recalibrate
        openness: metrics ? metrics.ear / baseline : null,
        alert: alert && !alert.dismissed ? { closedMs: alert.at - alert.since } : null,
        calibrated,
        calibration: calibrationStatus,
        settings: { ...settings },
        chart: chart.slice(),
        session: session ? { ...session, events: session.events.slice() } : null,
      };
    }

    return {
      update,
      startSession,
      endSession,
      interrupt,
      snapshot,
      pause(at) {
        if (!session || paused) return;
        paused = true;
        resetClosure(at, "paused");
        cancelCalibration();
        status = "paused";
        log("paused", at);
        emit();
      },
      resume(at) {
        if (!session || !paused) return;
        paused = false;
        status = "waiting";
        lastAt = null;
        log("resumedSession", at);
        emit();
      },
      dismissAlert() {
        if (alert) alert.dismissed = true; // stays dismissed until the eyes reopen (a new episode can alert again)
        emit();
      },
      /** Collect open-eye ratios for CALIBRATION_MS from tracked, centered frames. */
      calibrate(at) {
        if (!session || paused) return false;
        calibration = { until: at + CALIBRATION_MS, samples: [] };
        calibrationStatus = "running";
        emit();
        return true;
      },
      resetCalibration() {
        baseline = DEFAULT_BASELINE;
        calibrated = false;
        calibrationStatus = "none";
        calibration = null;
        recal = [];
        recalNeeded = false;
        emit();
      },
      setSettings(partial) {
        if (partial.alertAfterMs !== undefined) settings.alertAfterMs = clampAlert(partial.alertAfterMs);
        if (partial.sound !== undefined) settings.sound = Boolean(partial.sound);
        emit();
      },
      /** Size of the recalibration window (for tests: it must stay bounded). */
      debugRecalSize: () => recal.length,
      /** Finished sessions (newest first) plus the running one. */
      history() {
        const list = sessions.map((s) => ({ ...s, events: s.events.slice() }));
        if (session) list.unshift({ ...session, events: session.events.slice() });
        return list;
      },
      clearHistory() {
        sessions.length = 0;
        if (session) session.events = session.events.filter((e) => e.type === "started");
        emit();
      },
    };
  }

  /** Draw the monitored landmarks of one frame on the overlay (frame coordinates). */
  function drawMonitorLandmarks(ctx, marksList, width) {
    const r = Math.max(1.5, width / 480);
    ctx.save();
    try {
      ctx.lineWidth = Math.max(1, width / 900);
      for (const marks of marksList) {
        if (!marks || marks.length !== POINT_COUNT * 2) continue;
        const pts = (group) => MONITOR_LANDMARKS[group].map((_, i) => point(marks, group, i));
        ctx.strokeStyle = "rgba(56, 214, 240, 0.55)";
        polyline(ctx, pts("oval"), true);
        ctx.strokeStyle = "rgba(56, 214, 240, 0.9)";
        for (const eye of ["eyeR", "eyeL"]) {
          const p = pts(eye);
          polyline(ctx, [p[0], p[1], p[2], p[3], p[4], p[5]], true);
        }
        polyline(ctx, pts("lips"), true);
        ctx.fillStyle = "#38d6f0";
        for (const group of ["eyeR", "eyeL", "mouth"]) pts(group).forEach((p) => dot(ctx, p, r));
        pts("lips").forEach((p, i) => i % 2 === 0 && dot(ctx, p, r * 0.8));
        dot(ctx, point(marks, "head", 0), r);
        ctx.fillStyle = "rgba(56, 214, 240, 0.7)";
        pts("oval").forEach((p, i) => i % 3 === 0 && dot(ctx, p, r * 0.8));
      }
    } finally {
      ctx.restore();
    }
  }

  function polyline(ctx, pts, close) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
    ctx.stroke();
  }

  function dot(ctx, p, r) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  global.createAlertnessMonitor = createAlertnessMonitor;
  global.alertnessMonitorInternals = {
    MONITOR_LANDMARKS, MONITOR_POINT_INDICES, POINT_COUNT, measure, drawMonitorLandmarks, DEFAULT_BASELINE,
    CLOSE_RATIO, OPEN_RATIO, ALERT_RANGE, MAX_GAP_MS, CALIBRATION_MS,
    LOW_LIGHT_ENTER, LOW_LIGHT_EXIT, QUALITY_HOLD_MS, EXIT_MS, RECAL_MIN_SPAN_MS, RECAL_HIGH, RECAL_LOW,
  };
})(typeof window !== "undefined" ? window : globalThis);
