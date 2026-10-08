"use strict";

// Page shell: tabs, language switcher and the live camera UI around createCameraController (camera.js).
(function () {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const t = (key, params) => window.i18n.t(key, params);

  const OVERLAYS = ["idle", "insecure", "prompt", "loading", "hidden", "denied", "nocam", "ended", "error"];
  const STREAMING = ["live", "hidden"];
  const ui = { tab: "camera", camState: "idle", camInfo: null, stats: null };

  const video = $("#cam-video");
  const camera = window.createCameraController({
    video,
    view: $("#cam-view"),
    overlay: $("#cam-overlay"),
    makeCanvas: () => document.createElement("canvas"),
    mediaDevices: navigator.mediaDevices,
    isSecureContext: window.isSecureContext,
    createWorker: () => new Worker("/static/detector-worker.mjs", { type: "module" }),
    createImageBitmap: (source) => window.createImageBitmap(source),
    // Only process new video frames when the browser can tell us about them.
    requestFrame: (fn) =>
      video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => fn()) : window.requestAnimationFrame(fn),
    cancelFrame: (id) => (video.cancelVideoFrameCallback ? video.cancelVideoFrameCallback(id) : window.cancelAnimationFrame(id)),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    now: () => performance.now(),
    onState: (state, info) => {
      ui.camState = state;
      ui.camInfo = info;
      if (state === "live") updateDeviceButtons();
      renderCamera();
    },
    onStats: (stats) => {
      ui.stats = stats;
      renderPerf();
    },
  });
  // For manual measurement in the browser console: liveCamera.stats()
  window.liveCamera = camera;

  // ---------- tabs and language ----------
  function setTab(tab) {
    ui.tab = tab;
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#view-camera").hidden = tab !== "camera";
    $("#view-upload").hidden = tab !== "upload";
    if (tab !== "camera" && camera.active) camera.stop(); // leaving the camera tab releases the camera
  }
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.goto)));
  $$("[data-lang]").forEach((b) => b.addEventListener("click", () => window.i18n.setLang(b.dataset.lang)));
  window.i18n.onChange(() => {
    renderCamera();
    renderSettings();
  });

  // ---------- camera ----------
  function renderCamera() {
    const state = ui.camState;
    const info = ui.camInfo || {};
    const streaming = STREAMING.includes(state);
    OVERLAYS.forEach((name) => ($(`#ov-${name}`).hidden = state !== name));
    $("#idle-paused").hidden = !(state === "idle" && info.reason === "hidden");
    const why = { timeout: "hidden.timeout", pending: "hidden.pending" }[info.why] || "hidden.noface";
    $("#hidden-why").textContent = t(why);

    $("#hud").hidden = !streaming;
    $("#mobile-dock").hidden = !streaming;
    const faces = state === "live" ? info.faces : 0;
    $("#chip-faces").textContent = faces === 1 ? t("hud.faces.one") : t("hud.faces", { n: faces });
    $("#chip-faces").classList.toggle("warn", !faces);
    $("#chip-bluroff").hidden = !(state === "live" && info.blurOn === false);

    const on = camera.active || streaming || state === "error";
    $("#cam-toggle-label").textContent = t(on ? "ctrl.off" : "ctrl.on");
    $("#cam-toggle").className = on ? "btn danger-soft" : "btn primary";
    renderPerf();
  }

  function renderPerf() {
    const stats = ui.stats;
    const streaming = STREAMING.includes(ui.camState);
    const size = (stats && stats.frameSize) || (video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null);
    $("#cam-meta").textContent = streaming && size ? t("ctrl.meta.on", size) : t("ctrl.meta.off");
    $("#chip-perf").textContent =
      stats && stats.fps !== null ? t("hud.perf", { fps: stats.fps.toFixed(0), ms: Math.round(stats.latencyMs) }) : t("hud.perf.none");
  }

  async function updateDeviceButtons() {
    if (updateDeviceButtons.done || !navigator.mediaDevices.enumerateDevices) return;
    updateDeviceButtons.done = true;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput").length;
    $$("[data-act=flip]").forEach((b) => (b.hidden = cameras < 2));
  }

  const actions = {
    start: () => camera.start(),
    stop: () => camera.stop(),
    restart: () => camera.restartDetector(),
    flip: async () => {
      await camera.switchCamera();
      // Rear cameras are not mirrored by default.
      setMirror(camera.settings.facingMode === "user");
    },
  };
  $$("[data-act]").forEach((b) => b.addEventListener("click", () => actions[b.dataset.act]()));
  $("#cam-toggle").addEventListener("click", () => {
    if (camera.active || STREAMING.includes(ui.camState) || ui.camState === "error") camera.stop();
    else camera.start();
  });

  function setMirror(on) {
    $("#cam-mirror").setAttribute("aria-pressed", String(on));
    $("#cam-view").classList.toggle("mirrored", on);
    $("#cam-overlay").classList.toggle("mirrored", on);
  }
  $("#cam-mirror").addEventListener("click", () => setMirror($("#cam-mirror").getAttribute("aria-pressed") !== "true"));

  // Hidden page, closed page, device sleep: release the camera and stop the loop.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && camera.active) camera.stop("hidden");
  });
  window.addEventListener("pagehide", () => camera.active && camera.stop());

  // ---------- privacy settings ----------
  function renderSettings() {
    const s = camera.settings;
    $("#t-blur").checked = s.blurOn;
    $("#blur-off-warn").hidden = s.blurOn;
    $("#t-boxes").checked = s.showBoxes;
    $$("[data-method]").forEach((p) => p.setAttribute("aria-pressed", String(p.dataset.method === s.method)));
    $("#t-strength").value = String(s.strength);
    $("#t-strength-value").textContent = t(`privacy.strength.${s.strength}`);
  }
  $("#t-blur").addEventListener("change", (e) => {
    camera.setSettings({ blurOn: e.target.checked });
    renderSettings();
  });
  $("#t-boxes").addEventListener("change", (e) => camera.setSettings({ showBoxes: e.target.checked }));
  $$("[data-method]").forEach((p) =>
    p.addEventListener("click", () => {
      camera.setSettings({ method: p.dataset.method });
      renderSettings();
    }),
  );
  $("#t-strength").addEventListener("input", (e) => {
    camera.setSettings({ strength: Number(e.target.value) });
    renderSettings();
  });

  $$("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      $$("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      ["privacy", "effects", "background"].forEach((m) => ($(`#p-${m}`).hidden = m !== b.dataset.mode));
    }),
  );

  window.i18n.apply();
  renderSettings();
  renderCamera();
})();
