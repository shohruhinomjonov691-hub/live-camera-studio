// Alertness monitor (app/static/monitor.js): signals, closure timer, cue, resets, calibration and history.
// The landmarks here are synthetic geometry built to known ratios: these tests prove the timing and reset
// logic, not how accurately MediaPipe finds eyes on real faces. Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../app/static/monitor.js", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../../app/static/detector-core.mjs", import.meta.url), "utf8");

function load() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context;
}
const M = load();
const I = M.alertnessMonitorInternals;
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A synthetic face whose eye ratio, mouth ratio and head position are exactly as given. */
function face({ ear = 0.3, mar = 0.05, yaw = 0.5, pitch = 0.4 } = {}) {
  const W = 30;
  const g = ear * W;
  const eyeR = [[100, 100], [110, 100 - g / 2], [120, 100 - g / 2], [130, 100], [120, 100 + g / 2], [110, 100 + g / 2]];
  const eyeL = [[170, 100], [180, 100 - g / 2], [190, 100 - g / 2], [200, 100], [190, 100 + g / 2], [180, 100 + g / 2]];
  const mouth = [[150, 170 - (mar * 40) / 2], [150, 170 + (mar * 40) / 2], [130, 170], [170, 170]];
  const lips = I.MONITOR_LANDMARKS.lips.map((_, i) => {
    const a = (i / 20) * Math.PI * 2;
    return [150 + 24 * Math.cos(a), 170 + 10 * Math.sin(a)];
  });
  const head = [[80 + yaw * 140, 100 + pitch * 100], [150, 200], [80, 120], [220, 120], [150, 40]];
  const oval = I.MONITOR_LANDMARKS.oval.map((_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return [150 + 75 * Math.sin(a), 120 - 85 * Math.cos(a)];
  });
  return [eyeR, eyeL, mouth, lips, head, oval].flat().flat();
}

function monitor(settings = {}) {
  const alerts = [];
  const m = M.createAlertnessMonitor({ toWall: (at) => 1_000_000 + at, onAlert: (a) => alerts.push(a), settings });
  return { m, alerts };
}

/** Feed frames every `step` ms from `from` until `to` (inclusive) with the given sample builder. */
function feed(m, from, to, build, step = 50) {
  let last;
  for (let at = from; at <= to; at += step) last = m.update({ at, ...build(at) });
  return last;
}
const one = (opts) => () => ({ faces: 1, marks: [face(opts)], error: null });
const events = (m) => plain(m.snapshot().session.events.map((e) => e.type));

test("worker sends exactly the points the monitor reads, in the same order", () => {
  const block = WORKER.match(/const MONITOR_POINTS = \[([\s\S]*?)\];/);
  assert.ok(block, "MONITOR_POINTS in the worker");
  const worker = block[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  assert.deepEqual(worker, plain(I.MONITOR_POINT_INDICES));
});

test("measure: eye ratio, mouth and head direction from the geometry", () => {
  const m = I.measure(face({ ear: 0.3, mar: 0.05 }));
  assert.ok(Math.abs(m.ear - 0.3) < 1e-9);
  assert.equal(m.mouth, "closed");
  assert.equal(m.head, "centered");
  assert.equal(I.measure(face({ mar: 0.5 })).mouth, "open");
  assert.equal(I.measure(face({ yaw: 0.15 })).head, "turned");
  assert.equal(I.measure(face({ yaw: 0.85 })).head, "turned");
  assert.equal(I.measure(face({ pitch: 0.8 })).head, "down");
  assert.equal(I.measure(face({ pitch: 0.1 })).head, "up");
});

test("measure rejects unusable results instead of guessing", () => {
  assert.equal(I.measure(null), null);
  assert.equal(I.measure(face().slice(2)), null, "wrong length");
  const nan = face();
  nan[5] = NaN;
  assert.equal(I.measure(nan), null, "non-finite value");
  const tiny = face().map((v) => v / 20); // eyes 1.5 px wide
  assert.equal(I.measure(tiny), null, "eyes too small to measure");
});

test("closed eyes: the duration grows frame by frame and the cue fires once at the configured duration", () => {
  const { m, alerts } = monitor({ alertAfterMs: 2000 });
  feed(m, 0, 500, one({ ear: 0.3 }));
  let s = feed(m, 550, 2500, one({ ear: 0.1 })); // closed from 550 ms
  assert.equal(s.eyes, "closed");
  assert.equal(s.closedMs, 1950);
  assert.equal(s.alert, null, "not yet");
  s = m.update({ at: 2550, ...one({ ear: 0.1 })() });
  assert.equal(s.closedMs, 2000);
  assert.deepEqual(plain(s.alert), { closedMs: 2000 });
  feed(m, 2600, 4000, one({ ear: 0.1 }));
  assert.equal(alerts.length, 1, "one cue per closure episode");
  assert.equal(events(m).filter((e) => e === "alert").length, 1);
});

test("reopening the eyes ends the episode and the cue; a new episode can alert again", () => {
  const { m, alerts } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 1200, one({ ear: 0.1 }));
  assert.ok(m.snapshot().alert);
  let s = m.update({ at: 1250, ...one({ ear: 0.3 })() });
  assert.equal(s.eyes, "open");
  assert.equal(s.closedMs, 0);
  assert.equal(s.alert, null);
  assert.ok(events(m).includes("reopened"));
  s = feed(m, 1300, 2400, one({ ear: 0.1 }));
  assert.equal(alerts.length, 2);
});

test("hysteresis: a ratio between the close and open thresholds does not flip the state", () => {
  const { m } = monitor();
  feed(m, 0, 200, one({ ear: 0.1 }));
  const between = I.DEFAULT_BASELINE * ((I.CLOSE_RATIO + I.OPEN_RATIO) / 2);
  const s = feed(m, 250, 600, one({ ear: between }));
  assert.equal(s.eyes, "closed");
  assert.equal(s.closedMs, 600);
});

for (const [name, sample] of [
  ["no face", () => ({ faces: 0, marks: [], error: null })],
  ["several faces", () => ({ faces: 2, marks: [face(), face()], error: null })],
  ["an invalid result", () => ({ faces: 1, marks: [face().slice(4)], error: null })],
  ["a turned head", one({ ear: 0.1, yaw: 0.1 })],
  ["landmarks unavailable", () => ({ faces: 1, marks: null, error: "landmarker" })],
]) {
  test(`${name} resets the closure timer and ends the cue`, () => {
    const { m, alerts } = monitor({ alertAfterMs: 1000 });
    feed(m, 0, 1100, one({ ear: 0.1 }));
    assert.ok(m.snapshot().alert);
    const s = m.update({ at: 1150, ...sample() });
    assert.equal(s.closedMs, 0);
    assert.equal(s.alert, null);
    // Closing again starts from zero: no cue before another full second.
    const t = feed(m, 1200, 2100, one({ ear: 0.1 }));
    assert.equal(t.closedMs, 900);
    assert.equal(alerts.length, 1);
  });
}

test("a gap between frames (more than 1 s) breaks the episode", () => {
  const { m } = monitor({ alertAfterMs: 2000 });
  feed(m, 0, 1500, one({ ear: 0.1 }));
  const s = m.update({ at: 2700, ...one({ ear: 0.1 })() });
  assert.equal(s.closedMs, 0, "restarted at the frame after the gap");
  assert.equal(s.alert, null);
});

test("interrupt (stale or timed-out preview), pause and the end of a session clear the timer", () => {
  const { m } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 1100, one({ ear: 0.1 }));
  m.interrupt(1150, "stale");
  assert.equal(m.snapshot().closedMs, 0);
  assert.equal(m.snapshot().alert, null);
  assert.equal(m.snapshot().status, "waiting");

  feed(m, 1200, 2300, one({ ear: 0.1 }));
  m.pause(2350);
  let s = m.update({ at: 2400, ...one({ ear: 0.1 })() });
  assert.equal(s.status, "paused");
  assert.equal(s.closedMs, 0);
  m.resume(2450);
  s = m.update({ at: 2500, ...one({ ear: 0.1 })() });
  assert.equal(s.closedMs, 0, "a pause never counts as closed time");

  m.endSession(2600, "stopped");
  s = m.snapshot();
  assert.equal(s.active, false);
  assert.equal(s.closedMs, 0);
  assert.equal(s.alert, null);
  assert.equal(s.chart.length, 0, "the chart is cleared");
  assert.equal(m.history()[0].events.at(-1).type, "stopped");
});

test("status and events: tracking lost/resumed and several faces are logged once per change", () => {
  const { m } = monitor();
  m.startSession(0);
  feed(m, 0, 100, () => ({ faces: 0, marks: [], error: null })); // no face before tracking: nothing logged
  feed(m, 150, 300, one());
  feed(m, 350, 600, () => ({ faces: 0, marks: [], error: null }));
  feed(m, 650, 800, one());
  feed(m, 850, 900, () => ({ faces: 2, marks: [face(), face()], error: null }));
  feed(m, 950, 1000, () => ({ faces: 0, marks: [], error: null })); // one lost state to another
  feed(m, 1050, 1100, one());
  assert.deepEqual(events(m), ["started", "lost", "resumed", "multiple", "lost", "resumed"]);
});

test("the alert duration is clamped to 1–5 s in 0.5 s steps", () => {
  const { m } = monitor();
  m.setSettings({ alertAfterMs: 200 });
  assert.equal(m.snapshot().settings.alertAfterMs, 1000);
  m.setSettings({ alertAfterMs: 9000 });
  assert.equal(m.snapshot().settings.alertAfterMs, 5000);
  m.setSettings({ alertAfterMs: 2740 });
  assert.equal(m.snapshot().settings.alertAfterMs, 2500);
  m.setSettings({ alertAfterMs: "x" });
  assert.equal(m.snapshot().settings.alertAfterMs, 2000);
});

test("dismissing hides the cue for this episode only", () => {
  const { m, alerts } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 1100, one({ ear: 0.1 }));
  m.dismissAlert();
  let s = feed(m, 1150, 3000, one({ ear: 0.1 }));
  assert.equal(s.alert, null);
  assert.equal(alerts.length, 1, "no repeated cue while the same episode continues");
  feed(m, 3050, 3100, one({ ear: 0.3 }));
  s = feed(m, 3150, 4200, one({ ear: 0.1 }));
  assert.ok(s.alert, "a new episode alerts again");
});

test("calibration sets the open-eye baseline from tracked frames; a bad calibration keeps the old one", () => {
  const { m } = monitor({ alertAfterMs: 1000 });
  m.startSession(0);
  assert.equal(m.calibrate(0), true);
  feed(m, 0, 3000, one({ ear: 0.2 })); // narrower eyes than the default baseline
  let s = m.snapshot();
  assert.equal(s.calibration, "done");
  assert.equal(s.calibrated, true);
  assert.ok(Math.abs(s.openness - 1) < 1e-9, "openness is relative to the calibrated baseline");
  // 0.2 is "closed" for the default baseline (0.3 * 0.65 = 0.195 is the limit) but open after calibration.
  s = feed(m, 3050, 4500, one({ ear: 0.2 }));
  assert.equal(s.eyes, "open");

  const bad = monitor().m;
  bad.startSession(0);
  bad.calibrate(0);
  feed(bad, 0, 3000, one({ ear: 0.6 })); // implausible open-eye ratio
  assert.equal(bad.snapshot().calibration, "failed");
  assert.equal(bad.snapshot().calibrated, false);

  const few = monitor().m;
  few.startSession(0);
  few.calibrate(0);
  feed(few, 0, 3000, one({ ear: 0.3 }), 500); // only 7 frames
  assert.equal(few.snapshot().calibration, "failed");
});

test("history keeps finished sessions newest first; clearing keeps the running session", () => {
  const { m } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 1100, one({ ear: 0.1 }));
  m.endSession(1200);
  feed(m, 2000, 2100, one());
  const h = m.history();
  assert.equal(h.length, 2);
  assert.equal(h[0].endedAt, null, "running session first");
  assert.equal(h[1].alerts, 1);
  assert.equal(h[1].startedAt, 1_000_000);
  m.clearHistory();
  assert.equal(m.history().length, 1);
  assert.deepEqual(plain(m.history()[0].events.map((e) => e.type)), ["started"]);
});

test("the openness chart holds real samples of the last 30 s only", () => {
  const { m } = monitor();
  feed(m, 0, 40000, one({ ear: 0.3 }), 500);
  const chart = m.snapshot().chart;
  assert.ok(chart[0].at >= 10000);
  assert.ok(chart.every((p) => Math.abs(p.value - 1) < 1e-9));
});

test("drawing the overlay skips malformed faces and restores the context", () => {
  const ops = [];
  const ctx = new Proxy({}, { get: (_, k) => (k in _ ? _[k] : (...a) => ops.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) });
  I.drawMonitorLandmarks(ctx, [face(), [1, 2, 3]], 640);
  assert.equal(ops[0][0], "save");
  assert.equal(ops.at(-1)[0], "restore");
  assert.ok(ops.filter((o) => o[0] === "arc").length > 20, "points drawn for the valid face only");
});

test("a ratio between the thresholds counts as open at the start (not unknown forever)", () => {
  const { m } = monitor();
  const between = I.DEFAULT_BASELINE * ((I.CLOSE_RATIO + I.OPEN_RATIO) / 2);
  const s = feed(m, 0, 300, one({ ear: between }));
  assert.equal(s.eyes, "open");
  assert.equal(s.closedMs, 0);
});

// ---------- Codex review: a frame without a detected face (or a hidden preview) is never tracking ----------

test("[r-mon] detector found no face but landmarks exist: no tracking, no timer, no cue", () => {
  const { m, alerts } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 200, one({ ear: 0.3 }));
  const s = feed(m, 250, 3000, () => ({ faces: 0, marks: [face({ ear: 0.1 })], error: null }));
  assert.equal(s.status, "noface");
  assert.equal(s.closedMs, 0);
  assert.equal(s.alert, null);
  assert.equal(alerts.length, 0);
});

test("[r-mon] a frame whose preview is hidden is not tracking and resets the timer", () => {
  const { m, alerts } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 800, one({ ear: 0.1 }));
  const s = feed(m, 850, 3000, () => ({ faces: 1, marks: [face({ ear: 0.1 })], error: null, shown: false }));
  assert.notEqual(s.status, "tracking");
  assert.equal(s.closedMs, 0);
  assert.equal(s.alert, null);
  assert.equal(alerts.length, 0);
});

// ---------- Codex review (P3): status priority — noface, then hidden, then landmark availability ----------

test("[r-p3] no detected face wins over missing landmarks (loading or failed)", () => {
  for (const error of [null, "landmarker"]) {
    const { m, alerts } = monitor({ alertAfterMs: 1000 });
    feed(m, 0, 900, one({ ear: 0.1 }));
    const s = m.update({ at: 950, faces: 0, marks: null, error });
    assert.equal(s.status, "noface", `error=${error}`);
    assert.equal(s.closedMs, 0);
    assert.equal(s.alert, null);
    assert.equal(alerts.length, 0);
  }
});

test("[r-p3] a hidden preview wins over missing landmarks; availability is checked after both", () => {
  const { m } = monitor({ alertAfterMs: 1000 });
  feed(m, 0, 900, one({ ear: 0.1 }));
  let s = m.update({ at: 950, faces: 1, marks: null, error: "landmarker", shown: false });
  assert.equal(s.status, "hidden");
  assert.equal(s.closedMs, 0);
  s = m.update({ at: 1000, faces: 1, marks: null, error: "landmarker", shown: true });
  assert.equal(s.status, "unavailable");
  s = m.update({ at: 1050, faces: 1, marks: null, error: null, shown: true });
  assert.equal(s.status, "waiting");
  s = m.update({ at: 1100, faces: 0, marks: null, error: null, shown: false });
  assert.equal(s.status, "noface", "no face wins over a hidden preview");
});

// ---------- Head pose, face count and frame-quality status ----------
// Synthetic geometry again: these tests prove the rules (thresholds, holds, resets), not accuracy on real faces.

const FRAME = { w: 640, h: 480 };
const CENTRE_BOX = { x: 220, y: 110, w: 200, h: 260 };
const sampleWith = (extra = {}, opts = {}) => () => ({
  faces: 1, marks: [face(opts)], error: null, boxes: [CENTRE_BOX], frame: FRAME, luma: { frame: 120, face: 120 }, ...extra,
});
const quality = (m) => m.snapshot().quality;
const qualityEvents = (m) => plain(m.snapshot().session.events.filter((e) => e.type === "quality").map((e) => e.detail.level));

test("[pose] a left or right turn reports its direction (the person's own side) and a rounded angle; up/down are directions only", () => {
  const { m } = monitor();
  let s = feed(m, 0, 300, one({ yaw: 0.5 }));
  assert.equal(s.head, "centered");
  assert.ok(Math.abs(s.yawDeg) <= 5);
  // Nose nearer the image-right cheek (yaw > 0.5): the person turned to their left. asin(0.6) = 37°, shown as 35.
  s = feed(m, 350, 700, one({ yaw: 0.8 }));
  assert.equal(s.head, "turned");
  assert.equal(s.yawDeg, 35);
  // Nose nearer the image-left cheek: turned to the person's right.
  s = feed(m, 750, 1100, one({ yaw: 0.2 }));
  assert.equal(s.head, "turned");
  assert.equal(s.yawDeg, -35);
  s = feed(m, 1150, 1500, one({ pitch: 0.7 }));
  assert.equal(s.head, "down");
  s = feed(m, 1550, 1900, one({ pitch: 0.1 }));
  assert.equal(s.head, "up");
  assert.equal(m.snapshot().faces, 1);
});

test("[pose] the head classification itself is unchanged by the angle (same thresholds as before)", () => {
  assert.equal(I.measure(face({ yaw: 0.29 })).head, "turned");
  assert.equal(I.measure(face({ yaw: 0.31 })).head, "centered");
  assert.equal(I.measure(face({ yaw: 0.71 })).head, "turned");
  // 0.7 / 0.3 correspond to about 24 degrees; the angle at the limit
  assert.ok(Math.abs(I.measure(face({ yaw: 0.7 })).yawDeg - 23.58) < 0.1);
});

test("[faces] the face count follows the detector for none, one and several faces, also when landmarks are missing", () => {
  const { m } = monitor();
  assert.equal(feed(m, 0, 100, () => ({ faces: 0, marks: [], error: null })).faces, 0);
  assert.equal(feed(m, 150, 300, one()).faces, 1);
  assert.equal(feed(m, 350, 500, () => ({ faces: 3, marks: [face(), face(), face()], error: null })).faces, 3);
  assert.equal(feed(m, 550, 700, () => ({ faces: 2, marks: null, error: "landmarker" })).faces, 2);
  assert.equal(m.snapshot().head, "unknown", "no head reading without exactly one measured face");
});

test("[quality] normal with a face in view and nothing to warn about; unknown when there is no face to judge", () => {
  const { m } = monitor();
  assert.equal(quality(m), "unknown");
  feed(m, 0, 1500, sampleWith());
  assert.equal(quality(m), "normal");
  feed(m, 1550, 4000, () => ({ faces: 0, marks: [], error: null, boxes: [], frame: FRAME, luma: { frame: 120, face: null } }));
  assert.equal(quality(m), "unknown", "no face: not judged (and not 'Normal')");
  assert.deepEqual(qualityEvents(m), [], "unknown -> normal and normal -> unknown are not logged");
});

test("[quality] low light needs a held reading, has hysteresis and is logged once each way", () => {
  const { m } = monitor();
  feed(m, 0, 1500, sampleWith());
  assert.equal(quality(m), "normal");
  feed(m, 1550, 2500, sampleWith({ luma: { frame: 30, face: 30 } }));
  assert.equal(quality(m), "normal", "less than the hold time: not shown yet");
  feed(m, 2550, 2600, sampleWith({ luma: { frame: 30, face: 30 } }));
  assert.equal(quality(m), "lowLight");
  // 60 is above "enter" (55) but below "exit" (70): still dark
  feed(m, 2650, 5000, sampleWith({ luma: { frame: 60, face: 60 } }));
  assert.equal(quality(m), "lowLight", "hysteresis keeps the warning");
  feed(m, 5050, 7000, sampleWith({ luma: { frame: 110, face: 110 } }));
  assert.equal(quality(m), "normal");
  assert.deepEqual(qualityEvents(m), ["lowLight", "normal"]);
  // 60 from normal never starts a warning
  feed(m, 7050, 10000, sampleWith({ luma: { frame: 60, face: 60 } }));
  assert.equal(quality(m), "normal");
});

test("[quality] low light is judged on the face when there is one, otherwise on the frame; no reading means no warning", () => {
  const { m } = monitor();
  feed(m, 0, 2000, sampleWith({ luma: { frame: 200, face: 30 } })); // dark face against a bright background
  assert.equal(quality(m), "lowLight");
  const none = monitor().m;
  feed(none, 0, 3000, sampleWith({ luma: null }));
  assert.equal(quality(none), "normal", "no brightness reading: nothing is invented");
  const bare = monitor().m;
  feed(bare, 0, 2000, () => ({ faces: 0, marks: [], error: null, luma: { frame: 20, face: null } }));
  assert.equal(quality(bare), "lowLight", "a dark frame with no face is still a light problem");
});

test("[quality] a face cut by the frame, or touching its edge, is Out of Frame / Partial", () => {
  const cut = monitor().m;
  feed(cut, 0, 2000, sampleWith({ boxes: [{ x: -90, y: 110, w: 200, h: 260 }] })); // 45 % outside
  assert.equal(quality(cut), "outOfFrame");
  const touching = monitor().m;
  feed(touching, 0, 2000, sampleWith({ boxes: [{ x: 0, y: 110, w: 200, h: 260 }] }));
  assert.equal(quality(touching), "outOfFrame");
  const bottom = monitor().m;
  feed(bottom, 0, 2000, sampleWith({ boxes: [{ x: 200, y: 300, w: 200, h: 180 }] }));
  assert.equal(quality(bottom), "outOfFrame");
  const inside = monitor().m;
  feed(inside, 0, 2000, sampleWith({ boxes: [{ x: 30, y: 110, w: 200, h: 260 }] }));
  assert.equal(quality(inside), "normal", "near an edge but fully inside");
  // moving back to the middle clears it after the hold time
  feed(cut, 2050, 4000, sampleWith());
  assert.equal(quality(cut), "normal");
  assert.deepEqual(qualityEvents(cut), ["outOfFrame", "normal"]);
});

test("[quality] a face that vanishes next to an edge left the frame; one that vanishes mid-frame did not", () => {
  const edge = monitor().m;
  feed(edge, 0, 2000, sampleWith({ boxes: [{ x: 30, y: 110, w: 200, h: 260 }] }));
  assert.equal(quality(edge), "normal");
  feed(edge, 2050, 3500, () => ({ faces: 0, marks: [], error: null, boxes: [], frame: FRAME, luma: { frame: 120, face: null } }));
  assert.equal(quality(edge), "outOfFrame");
  // after EXIT_MS it is just "no face" again
  feed(edge, 3550, 6500, () => ({ faces: 0, marks: [], error: null, boxes: [], frame: FRAME, luma: { frame: 120, face: null } }));
  assert.equal(quality(edge), "unknown");

  const middle = monitor().m;
  feed(middle, 0, 2000, sampleWith());
  const seen = new Set();
  for (let at = 2050; at <= 5000; at += 50) {
    middle.update({ at, faces: 0, marks: [], error: null, boxes: [], frame: FRAME, luma: { frame: 120, face: null } });
    seen.add(quality(middle));
  }
  assert.ok(!seen.has("outOfFrame"));
});

test("[quality] malformed boxes or frame sizes are ignored, never turned into a warning", () => {
  const { m } = monitor();
  feed(m, 0, 2500, sampleWith({ boxes: [{ x: NaN, y: 0, w: 10, h: 10 }, null, { x: 0, y: 0, w: 0, h: 5 }] })); // valid frame size
  assert.equal(quality(m), "normal", "unusable boxes are skipped (they would all read as touching the edge)");
  const noFrame = monitor().m;
  feed(noFrame, 0, 2500, sampleWith({ frame: { w: 0, h: 0 }, boxes: [{ x: 0, y: 0, w: 50, h: 50 }] }));
  assert.equal(quality(noFrame), "normal", "an unusable frame size is ignored")
});

test("[quality] Recalibration Needed: open-eye readings persistently far from the baseline", () => {
  const high = monitor().m;
  feed(high, 0, 7000, sampleWith({}, { ear: 0.45 })); // 1.5 x the baseline
  assert.equal(quality(high), "normal", "less than the minimum stretch of readings");
  feed(high, 7050, 11000, sampleWith({}, { ear: 0.45 }));
  assert.equal(quality(high), "recalibrate");

  const edge = monitor().m;
  feed(edge, 0, 11000, sampleWith({}, { ear: 0.21 })); // 0.7 x: "open" but next to the closing limit
  assert.equal(quality(edge), "recalibrate");
  assert.equal(edge.snapshot().eyes, "open");

  const fine = monitor().m;
  feed(fine, 0, 12000, sampleWith({}, { ear: 0.3 }));
  assert.equal(quality(fine), "normal");
  assert.deepEqual(qualityEvents(fine), []);
});

test("[quality] recalibration advice goes away after a successful calibration; a failed calibration asks for another", () => {
  const { m } = monitor();
  m.startSession(0);
  feed(m, 0, 11000, sampleWith({}, { ear: 0.45 }));
  assert.equal(quality(m), "recalibrate");
  m.calibrate(11050);
  feed(m, 11050, 14100, sampleWith({}, { ear: 0.45 }));
  assert.equal(m.snapshot().calibration, "done");
  feed(m, 14150, 16500, sampleWith({}, { ear: 0.45 }));
  assert.equal(quality(m), "normal", "0.45 is now the baseline");

  const bad = monitor().m;
  bad.startSession(0);
  bad.calibrate(0);
  feed(bad, 0, 3050, sampleWith({}, { ear: 0.6 }));
  assert.equal(bad.snapshot().calibration, "failed");
  feed(bad, 3100, 5000, sampleWith({}));
  assert.equal(quality(bad), "recalibrate");
  bad.resetCalibration();
  feed(bad, 5050, 7000, sampleWith({}));
  assert.equal(quality(bad), "normal");
});

test("[quality] a closure episode, a turned head or lost tracking never count towards recalibration", () => {
  const { m } = monitor();
  // eyes closed for the whole stretch (ratio 0.3 x): that is an alert, not a miscalibration
  feed(m, 0, 11000, sampleWith({}, { ear: 0.09 }));
  assert.equal(quality(m), "normal");
  const turned = monitor().m;
  feed(turned, 0, 11000, sampleWith({}, { ear: 0.45, yaw: 0.9 }));
  assert.equal(quality(turned), "normal", "a turned head changes the eye shape: not judged");
});

test("[quality] interrupt, pause and the end of a session reset the quality status", () => {
  const { m } = monitor();
  feed(m, 0, 2000, sampleWith({ luma: { frame: 20, face: 20 } }));
  assert.equal(quality(m), "lowLight");
  m.interrupt(2050, "stale");
  assert.equal(quality(m), "unknown");
  assert.equal(m.snapshot().faces, null);
  feed(m, 2100, 4200, sampleWith({ luma: { frame: 20, face: 20 } }));
  assert.equal(quality(m), "lowLight");
  m.endSession(4300);
  assert.equal(quality(m), "unknown");
  feed(m, 5000, 7000, sampleWith({ luma: { frame: 120, face: 120 } }));
  assert.equal(quality(m), "normal", "a new session starts clean (no old low-light state)");
});

test("[r1] the recalibration window stays bounded while a quality warning is shown", () => {
  const { m } = monitor();
  // A dark room for ten minutes at 20 fps: tracked, centered frames the whole time.
  feed(m, 0, 600000, sampleWith({ luma: { frame: 20, face: 20 } }), 50);
  assert.equal(quality(m), "lowLight");
  assert.ok(m.debugRecalSize() <= (12000 / 50) + 2, `window holds ${m.debugRecalSize()} entries`);
});

test("[r2] flapping quality changes never push out 'started' or a cue from a full event list", () => {
  const { m } = monitor({ alertAfterMs: 1000 });
  m.startSession(0);
  // a closure episode that raises a cue ...
  feed(m, 0, 1500, sampleWith({}, { ear: 0.05 }));
  // ... then light flapping around the thresholds for a long time
  let at = 1550;
  for (let i = 0; i < 400; i++) {
    const luma = i % 2 ? 120 : 20;
    for (let k = 0; k < 25; k++, at += 50) m.update({ at, ...sampleWith({ luma: { frame: luma, face: luma } }, {})() });
  }
  const events = m.snapshot().session.events;
  assert.ok(events.length <= 200);
  assert.equal(events[0].type, "started", "the start of the session is kept");
  assert.ok(events.some((e) => e.type === "alert"), "the cue is kept");
});
