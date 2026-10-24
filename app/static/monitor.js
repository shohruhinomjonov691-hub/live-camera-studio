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
(function (global) {
  // MediaPipe face-mesh indices, in the order the worker sends them (flat [x0, y0, x1, y1, ...] per face).
  // Keep in sync with app/static/detector-worker.mjs (a test checks this).
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
    return { ear, mar, yaw, pitch, head, mouth: mar > MOUTH_OPEN ? "open" : "closed" };
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

    function clampAlert(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n)) return DEFAULTS.alertAfterMs;
      const stepped = Math.round(n / ALERT_RANGE.step) * ALERT_RANGE.step;
      return Math.min(ALERT_RANGE.max, Math.max(ALERT_RANGE.min, stepped));
    }

    function log(type, at, detail = null) {
      if (!session) return;
      session.events.push({ type, wall: toWall(at), detail });
      if (session.events.length > MAX_EVENTS) session.events.shift();
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
    }

    function setStatus(next, at) {
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
      emit();
    }

    /** No fresh frames (preview hidden as stale/timeout): the closure timer must not keep running. */
    function interrupt(at, reason) {
      if (!session) return;
      resetClosure(at, reason);
      metrics = null;
      lastAt = null;
      if (!paused) status = "waiting";
      emit();
    }

    function cancelCalibration() {
      if (calibrationStatus === "running") calibrationStatus = "none";
      calibration = null;
    }

    /**
     * One processed frame. sample: {at, faces (detector count), marks: array of flat landmark arrays (one per
     * face) | null when landmarks are not available, error: string|null}
     */
    function update(sample) {
      if (!session) startSession(sample.at);
      const at = sample.at;
      if (lastAt !== null && at - lastAt > MAX_GAP_MS) resetClosure(at, "gap");
      if (lastAt !== null && at < lastAt) return snapshot(); // out of order: ignore
      lastAt = at;
      if (paused) {
        status = "paused";
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
        emit();
      },
      setSettings(partial) {
        if (partial.alertAfterMs !== undefined) settings.alertAfterMs = clampAlert(partial.alertAfterMs);
        if (partial.sound !== undefined) settings.sound = Boolean(partial.sound);
        emit();
      },
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
  };
})(typeof window !== "undefined" ? window : globalThis);
