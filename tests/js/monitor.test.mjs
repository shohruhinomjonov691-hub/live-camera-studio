// Alertness monitor (app/static/monitor.js): signals, closure timer, cue, resets, calibration and history.
// The landmarks here are synthetic geometry built to known ratios: these tests prove the timing and reset
// logic, not how accurately MediaPipe finds eyes on real faces. Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../app/static/monitor.js", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../../app/static/detector-worker.mjs", import.meta.url), "utf8");

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
