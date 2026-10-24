"use strict";

// Page shell: views, language switcher, the live camera UI around createCameraController (camera.js) and the
// alertness monitor UI around createAlertnessMonitor (monitor.js).
(function () {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const t = (key, params) => window.i18n.t(key, params);

  const OVERLAYS = ["idle", "insecure", "prompt", "loading", "hidden", "denied", "nocam", "ended", "error"];
  const STREAMING = ["live", "hidden"];
  // Error card per failed stage: [title, body, button] keys and the stage code shown with the error's class name,
  // so a report tells a camera, video, detector-loading and detector failure apart.
  const ERROR_CARDS = {
    camera: { keys: ["error.title.camera", "error.body.camera", "error.cta.retry"], stage: "camera" },
    play: { keys: ["error.title.play", "error.body.play", "error.cta.retry"], stage: "video" },
    load: { keys: ["error.title.load", "error.body.load", "error.cta"], stage: "detector-load" },
    detector: { keys: ["error.title", "error.body", "error.cta"], stage: "detector-run" },
    worker: { keys: ["error.title", "error.body", "error.cta"], stage: "worker" },
    render: { keys: ["error.title", "error.body", "error.cta"], stage: "render" },
  };
  // effectAlert: the glasses effect failed (and blur came back). Cleared only by Dismiss or a retry.
  const ui = {
    tab: "monitor", camState: "idle", camInfo: null, stats: null, effect: "off", effectAlert: false, snapshots: [],
    segmenter: "off", bgImageInfo: null, bgImageError: null, mon: null, histSel: null, histKey: "", lastBeep: 0,
    overlay: true, // the user's landmark-overlay choice; drawn only in the Live Monitor view
  };
  const MAX_SNAPSHOTS = 6;
  const CAMERA_VIEWS = ["monitor", "effects"];
  const PAGE_KEYS = {
    monitor: ["page.monitor", "page.monitor.sub"],
    effects: ["page.effects", "page.effects.sub"],
    history: ["page.history", "page.history.sub"],
    settings: ["page.settings", "page.settings.sub"],
    upload: ["page.upload", "page.upload.sub"],
  };

  // ---------- alertness monitor ----------
  // Capture times are performance.now() values; events are shown in wall-clock time.
  const toWall = (at) => Date.now() - (performance.now() - at);
  const MONITOR_STORE = "lcs.monitor";
  function loadMonitorSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(MONITOR_STORE) || "null");
      return saved && typeof saved === "object" ? { alertAfterMs: saved.alertAfterMs, sound: saved.sound !== false } : {};
    } catch (_) {
      return {};
    }
  }
  function saveMonitorSettings(settings) {
    try {
      localStorage.setItem(MONITOR_STORE, JSON.stringify({ alertAfterMs: settings.alertAfterMs, sound: settings.sound }));
    } catch (_) {
      /* storage blocked: the choice lasts until the page closes */
    }
  }
  const monitor = window.createAlertnessMonitor({
    toWall,
    settings: loadMonitorSettings(),
    onChange: (snapshot) => {
      ui.mon = snapshot;
      renderMonitor();
    },
  });

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
      monitorLifecycle(state, info);
      renderCamera();
      renderMonitor();
    },
    // Landmarks of each processed frame (or why there are none) feed the alertness monitor.
    onAnalysis: (sample) => monitor.update(sample),
    drawLandmarks: (ctx, marks, width) => window.alertnessMonitorInternals.drawMonitorLandmarks(ctx, marks, width),
    onStats: (stats) => {
      ui.stats = stats;
      renderPerf();
    },
    onEffect: (status) => {
      ui.effect = status;
      renderEffect();
      renderMonitor();
    },
    // The glasses effect failed while on: the controller turned glasses off and blur back on.
    // Say so (sticky) and sync the toggles.
    onBackground: (status) => {
      ui.segmenter = status;
      renderBackground();
    },
    onEffectFallback: () => {
      ui.effectAlert = true;
      renderAllSettings();
    },
  });
  // For manual measurement in the browser console: liveCamera.stats()
  window.liveCamera = camera;
  // For tests: the snapshot flow without DOM events.
  window.liveCameraShell = {
    takeSnapshot,
    loadBackgroundImage,
    snapshots: () => ui.snapshots.slice(),
    selectMode: (mode) => selectMode(mode),
    setTab: (tab) => setTab(tab),
    monitor,
  };
  // The monitor reads landmarks from every processed frame (eyes, mouth, head); it never changes the blur.
  camera.setSettings({ monitor: true });

  // ---------- views and language ----------
  function setTab(tab) {
    if (!PAGE_KEYS[tab]) return;
    ui.tab = tab;
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("#view-camera").hidden = !CAMERA_VIEWS.includes(tab);
    $("#monitor-panel").hidden = tab !== "monitor";
    $("#mon-extras").hidden = tab !== "monitor";
    $("#fx-panel").hidden = tab !== "effects";
    $("#view-history").hidden = tab !== "history";
    $("#view-settings").hidden = tab !== "settings";
    $("#view-upload").hidden = tab !== "upload";
    // The photo upload releases the camera (as before). History and Settings keep monitoring running.
    if (tab === "upload" && camera.active) camera.stop();
    applyOverlay();
    renderPage();
    renderMonitor();
    if (tab === "history") renderHistory(true);
    if (tab === "settings") renderMonitorSettings();
  }
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$("[data-tab-go]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tabGo)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.goto)));
  $("#cam-status").addEventListener("click", () => setTab("monitor"));

  function renderPage() {
    const [title, sub] = PAGE_KEYS[ui.tab];
    $("#page-title").textContent = t(title);
    $("#page-sub").textContent = t(sub);
  }
  $$("[data-lang]").forEach((b) => b.addEventListener("click", () => window.i18n.setLang(b.dataset.lang)));
  window.i18n.onChange(() => {
    renderPage();
    renderCamera();
    renderSettings();
    renderEffect();
    renderShots();
    renderBackground();
    renderMonitor();
    renderMonitorSettings();
    renderHistory(true);
  });

  // ---------- camera ----------
  function renderCamera() {
    const state = ui.camState;
    const info = ui.camInfo || {};
    const streaming = STREAMING.includes(state);
    OVERLAYS.forEach((name) => ($(`#ov-${name}`).hidden = state !== name));
    $("#idle-paused").hidden = !(state === "idle" && info.reason === "hidden");
    const why =
      {
        timeout: "hidden.timeout",
        pending: "hidden.pending",
        bgPending: "hidden.bgPending",
        bgLoading: "hidden.bgLoading",
        bgError: "hidden.bgError",
        bgInvalid: "hidden.bgInvalid",
        stale: "hidden.stale",
      }[info.why] || "hidden.noface";
    $("#hidden-why").textContent = t(why);
    if (state === "error") {
      const card = ERROR_CARDS[info.kind] || ERROR_CARDS.detector;
      ["#error-title", "#error-body", "#error-cta"].forEach((selector, i) => {
        const node = $(selector);
        node.dataset.i18n = card.keys[i]; // a later language switch keeps the right text
        node.textContent = t(card.keys[i]);
      });
      $("#error-code").textContent = t("error.code", { stage: card.stage, name: info.name || "Error" });
    }

    $("#hud").hidden = !streaming;
    $("#mobile-dock").hidden = !streaming;
    const faces = state === "live" ? info.faces : 0;
    $("#chip-faces").textContent = faces === 1 ? t("hud.faces.one") : t("hud.faces", { n: faces });
    $("#chip-faces").classList.toggle("warn", !faces);
    // Faces are visible whenever blur is off and a frame is on screen: say so on the preview itself.
    $("#chip-bluroff").hidden = !(streaming && !camera.settings.blurOn);

    const on = camera.active || streaming || state === "error";
    $("#cam-toggle-label").textContent = t(on ? "ctrl.off" : "ctrl.on");
    $("#cam-toggle").className = on ? "btn danger-soft" : "btn primary";
    // Snapshots only while a fully processed frame is on screen (not pending, hidden, error or stopped).
    $$("[data-act=snap]").forEach((b) => (b.disabled = state !== "live"));
    if (state !== "live") $("#snap-toast").hidden = true;
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
    snap: takeSnapshot,
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
    camera.setSettings({ mirror: on }); // a background image is drawn the right way round for the preview
    $("#cam-mirror").setAttribute("aria-pressed", String(on));
    $("#cam-view").classList.toggle("mirrored", on);
    $("#cam-overlay").classList.toggle("mirrored", on);
  }
  $("#cam-mirror").addEventListener("click", () => setMirror($("#cam-mirror").getAttribute("aria-pressed") !== "true"));

  // ---------- snapshots ----------
  // The snapshot is the visible processed canvas, flipped exactly like the preview when Mirror is on.
  // canvas.toBlob("image/png") encodes raw pixels: no EXIF, GPS or text metadata; boxes and HUD are not
  // part of that canvas. Nothing is uploaded; the blob lives in this tab until removed or the page closes.
  function isMirrored() {
    return $("#cam-mirror").getAttribute("aria-pressed") === "true";
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // Bumped on pagehide: a snapshot still being encoded at that moment is discarded when it finishes.
  let snapshotGeneration = 0;

  async function takeSnapshot() {
    const canvas = camera.snapshot({ mirror: isMirrored() });
    if (!canvas) return;
    const generation = snapshotGeneration;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || generation !== snapshotGeneration) return;
    const shot = { url: URL.createObjectURL(blob), name: `live-camera-studio-${stamp()}.png`, w: canvas.width, h: canvas.height };
    ui.snapshots.unshift(shot);
    ui.snapshots.splice(MAX_SNAPSHOTS).forEach((old) => URL.revokeObjectURL(old.url));
    renderShots();
    const flash = $("#snap-flash");
    flash.hidden = true;
    void flash.offsetWidth; // restart the animation
    flash.hidden = false;
    $("#snap-toast-thumb").src = shot.url;
    $("#snap-toast-meta").textContent = t("toast.meta", shot);
    $("#snap-toast-download").href = shot.url;
    $("#snap-toast-download").download = shot.name;
    $("#snap-toast").hidden = false;
  }

  function renderShots() {
    const list = $("#shots");
    list.replaceChildren();
    $("#shots-empty").hidden = ui.snapshots.length > 0;
    ui.snapshots.forEach((shot, index) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = shot.url;
      img.alt = "";
      const actions = document.createElement("span");
      actions.className = "shot-actions";
      const download = document.createElement("a");
      download.href = shot.url;
      download.download = shot.name;
      download.setAttribute("aria-label", t("shots.downloadAria", { n: index + 1 }));
      download.append(icon("M12 3v12M7 10l5 5 5-5M5 21h14"));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", t("shots.removeAria", { n: index + 1 }));
      remove.append(icon("M18 6L6 18M6 6l12 12"));
      remove.addEventListener("click", () => {
        ui.snapshots = ui.snapshots.filter((s) => s !== shot);
        URL.revokeObjectURL(shot.url);
        if ($("#snap-toast-download").href === shot.url) $("#snap-toast").hidden = true;
        renderShots();
      });
      actions.append(download, remove);
      li.append(img, actions);
      list.append(li);
    });
  }

  function icon(d) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  // ---------- glasses effect ----------
  function renderEffect() {
    const s = camera.settings;
    $("#t-glasses").checked = s.glasses;
    $("#t-glasses-size").value = String(s.glassesSize);
    $("#t-glasses-size-value").textContent = `${s.glassesSize}%`;
    const note = $("#effect-blur-note");
    note.textContent = t(s.glasses ? "effects.faceVisible" : "effects.exclusive");
    note.classList.toggle("warn-line", s.glasses);
    const status = $("#effect-status");
    const loading = s.glasses && ui.effect === "loading";
    status.hidden = !loading;
    if (loading) status.textContent = t("effects.loading");
    // Independent of the glasses toggle (the failure itself turned glasses off).
    $("#effect-alert").hidden = !ui.effectAlert;
    $("#effect-alert-text").textContent = t("effects.error");
  }
  $("#effect-alert-dismiss").addEventListener("click", () => {
    ui.effectAlert = false;
    renderEffect();
  });
  $("#t-glasses").addEventListener("change", (e) => {
    if (e.target.checked) ui.effectAlert = false; // an explicit retry
    camera.setSettings({ glasses: e.target.checked }); // ON turns face blur OFF; OFF leaves blur as it is
    renderAllSettings();
  });
  $("#t-glasses-size").addEventListener("input", (e) => {
    camera.setSettings({ glassesSize: Number(e.target.value) });
    renderEffect();
  });

  // ---------- background ----------
  // The image is decoded and kept in this browser only (an ImageBitmap); it is never uploaded.
  const BG_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const BG_MAX_BYTES = 10 * 1024 * 1024;
  const BG_MAX_PIXELS = 25_000_000;
  const BG_MAX_SIDE = 8000;
  const BG_KEEP_SIDE = 1920; // stored at most this large
  let backgroundGeneration = 0;

  async function loadBackgroundImage(file) {
    const generation = ++backgroundGeneration; // a newer choice makes older decodes stale
    ui.bgImageError = null;
    if (!BG_TYPES.includes(file.type)) return bgImageFailed("bg.err.type", generation);
    if (file.size > BG_MAX_BYTES) return bgImageFailed("bg.err.size", generation);
    ui.bgImageInfo = null;
    renderBackground();
    let bitmap;
    try {
      bitmap = await window.createImageBitmap(file);
    } catch (_) {
      return bgImageFailed("bg.err.decode", generation);
    }
    if (generation !== backgroundGeneration) return bitmap.close();
    const { width, height } = bitmap;
    if (width * height > BG_MAX_PIXELS || Math.max(width, height) > BG_MAX_SIDE) {
      bitmap.close();
      return bgImageFailed("bg.err.pixels", generation);
    }
    const scale = Math.min(1, BG_KEEP_SIDE / Math.max(width, height));
    if (scale < 1) {
      let small;
      try {
        small = await window.createImageBitmap(bitmap, {
          resizeWidth: Math.round(width * scale),
          resizeHeight: Math.round(height * scale),
          resizeQuality: "high",
        });
      } catch (_) {
        bitmap.close();
        return bgImageFailed("bg.err.decode", generation);
      }
      bitmap.close();
      if (generation !== backgroundGeneration) return small.close();
      bitmap = small;
    }
    camera.setBackgroundImage(bitmap);
    camera.setSettings({ background: "image" });
    ui.bgImageInfo = { w: width, h: height };
    renderBackground();
  }

  function bgImageFailed(key, generation) {
    if (generation !== backgroundGeneration) return;
    ui.bgImageError = key;
    renderBackground();
  }

  function renderBackground() {
    const bg = camera.background;
    const s = camera.settings;
    $$("[data-bg]").forEach((pill) => {
      const on = pill.dataset.bg === bg.mode;
      pill.setAttribute("aria-pressed", String(on));
      pill.setAttribute("aria-checked", String(on));
      if (pill.dataset.bg === "image") pill.disabled = !bg.hasImage; // no image mode before an image is chosen
    });
    $("#bg-blur-field").hidden = bg.mode !== "blur";
    $("#t-bg-blur").value = String(s.bgBlur);
    $("#t-bg-blur-value").textContent = t(`privacy.strength.${s.bgBlur}`);
    $("#bg-remove").hidden = !bg.hasImage;
    $("#bg-image-info").hidden = !(bg.hasImage && ui.bgImageInfo);
    if (ui.bgImageInfo) $("#bg-image-info").textContent = t("bg.imageInfo", ui.bgImageInfo);
    $("#bg-image-error").hidden = !ui.bgImageError;
    if (ui.bgImageError) $("#bg-image-error").textContent = t(ui.bgImageError);
    const statusKey = bg.mode === "off" ? null : { loading: "bg.loading", error: "bg.error" }[ui.segmenter];
    $("#bg-status").hidden = !statusKey;
    $("#bg-status").classList.toggle("error", ui.segmenter === "error");
    if (statusKey) $("#bg-status-text").textContent = t(statusKey);
    $("#bg-retry").hidden = !(bg.mode !== "off" && ui.segmenter === "error");
    $("#bg-status-text").hidden = false;
  }

  $$("[data-bg]").forEach((pill) =>
    pill.addEventListener("click", () => {
      camera.setSettings({ background: pill.dataset.bg });
      renderBackground();
    }),
  );
  $("#t-bg-blur").addEventListener("input", (e) => {
    camera.setSettings({ bgBlur: Number(e.target.value) });
    renderBackground();
  });
  $("#bg-pick").addEventListener("click", () => $("#bg-file").click());
  $("#bg-file").addEventListener("change", () => {
    const file = $("#bg-file").files[0];
    $("#bg-file").value = "";
    if (file) loadBackgroundImage(file);
  });
  $("#bg-remove").addEventListener("click", () => {
    backgroundGeneration++;
    camera.setBackgroundImage(null); // also switches an image background off
    ui.bgImageInfo = null;
    ui.bgImageError = null;
    renderBackground();
  });
  $("#bg-retry").addEventListener("click", () => camera.retryBackground());

  // Hidden page, closed page, device sleep: release the camera and stop the loop.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && camera.active) camera.stop("hidden");
  });
  window.addEventListener("pagehide", () => {
    snapshotGeneration++;
    backgroundGeneration++; // an image still being decoded is discarded
    camera.dispose(); // stops the camera and closes the background image
    ui.snapshots.forEach((shot) => URL.revokeObjectURL(shot.url));
    ui.snapshots = [];
  });

  // ---------- privacy settings ----------
  function renderSettings() {
    const s = camera.settings;
    $("#t-blur").checked = s.blurOn;
    $("#m-blur").checked = s.blurOn;
    $("#m-overlay").checked = ui.overlay;
    $("#blur-off-warn").hidden = s.blurOn;
    $("#t-boxes").checked = s.showBoxes;
    $$("[data-method]").forEach((p) => p.setAttribute("aria-pressed", String(p.dataset.method === s.method)));
    $("#t-strength").value = String(s.strength);
    $("#t-strength-value").textContent = t(`privacy.strength.${s.strength}`);
  }
  $("#t-blur").addEventListener("change", (e) => {
    camera.setSettings({ blurOn: e.target.checked }); // ON turns glasses OFF and wipes the preview at once
    renderAllSettings();
  });

  /** Toggles, notes and the HUD always show the controller's real settings. */
  function renderAllSettings() {
    renderSettings();
    renderEffect();
    renderCamera();
  }
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

  $("#m-blur").addEventListener("change", (e) => {
    camera.setSettings({ blurOn: e.target.checked }); // ON turns glasses OFF and wipes the preview at once
    renderAllSettings();
  });
  $("#m-overlay").addEventListener("change", (e) => {
    ui.overlay = e.target.checked;
    applyOverlay();
  });
  /** The landmark overlay belongs to the Live Monitor; the Effects view shows the effects alone. */
  function applyOverlay() {
    camera.setSettings({ showLandmarks: ui.overlay && ui.tab === "monitor" });
  }

  function selectMode(mode) {
    $$("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.mode === mode)));
    ["privacy", "effects", "background"].forEach((m) => ($(`#p-${m}`).hidden = m !== mode));
    // Privacy mode means face blur ON (which turns glasses OFF). The controller drops the frame in flight
    // and, if blur was off, wipes the preview at once until a blurred frame arrives.
    if (mode === "privacy") camera.setSettings({ blurOn: true });
    renderAllSettings();
  }
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => selectMode(b.dataset.mode)));

  // ---------- alertness monitor UI ----------
  const STREAM_STATES = ["live", "hidden"];
  const END_REASONS = { idle: "stopped", ended: "ended", error: "error", denied: "stopped", nocam: "stopped", insecure: "stopped" };

  /** Sessions follow the camera: every stop, end, error or hidden page ends one; stale frames interrupt it. */
  function monitorLifecycle(state, info) {
    const now = performance.now();
    if (state === "hidden" && info && (info.why === "stale" || info.why === "timeout")) monitor.interrupt(now, info.why);
    if (END_REASONS[state] && monitor.snapshot().active) {
      const reason = state === "idle" && info && (info.reason === "hidden" || info.reason === "ended") ? info.reason : END_REASONS[state];
      monitor.endSession(now, reason);
    }
  }

  const fmtSec = (ms) => (ms / 1000).toFixed(1);
  const locale = () => (window.i18n.lang === "ko" ? "ko-KR" : "en-US");
  const fmtTime = (wall) => new Date(wall).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtClock = (wall) => new Date(wall).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  const fmtDate = (wall) => new Date(wall).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    return m ? t("time.min", { m, s: total % 60 }) : t("time.sec", { s: total });
  }

  const STATUS = {
    waiting: ["mon.st.waiting", "mon.st.waiting.sub", "wait"],
    tracking: ["mon.st.tracking", "mon.st.tracking.sub", "ok"],
    noface: ["mon.st.noface", "mon.st.noface.sub", "warn"],
    multiple: ["mon.st.multiple", "mon.st.multiple.sub", "warn"],
    invalid: ["mon.st.invalid", "mon.st.invalid.sub", "warn"],
    turned: ["mon.st.turned", "mon.st.turned.sub", "warn"],
    paused: ["mon.st.paused", "mon.st.paused.sub", "wait"],
    unavailable: ["mon.st.unavailable", "mon.st.unavailable.sub", "danger"],
  };

  function eventText(e) {
    const d = e.detail || {};
    const label = t(`ev.${e.type}`);
    let detail = "";
    if (e.type === "alert") detail = t("ev.alert.detail", { s: fmtSec(d.closedMs), t: fmtSec(d.afterMs) });
    else if (e.type === "reopened") detail = t("ev.reopened.detail", { s: fmtSec(d.closedMs) });
    else if (e.type === "stopped" || e.type === "alertEnded") detail = t(`ev.reason.${d.reason}`);
    else if (e.type === "lost") detail = t("ev.lost.detail");
    return { label, detail };
  }

  function renderMonitor() {
    const snap = ui.mon || monitor.snapshot();
    const streaming = STREAM_STATES.includes(ui.camState);
    const active = streaming || ui.camState === "loading";
    const onMonitor = ui.tab === "monitor";
    $("#mon-guide").hidden = active;
    $("#mon-live").hidden = !active;
    $("#mon-steps").hidden = active;
    $("#mon-chart-card").hidden = !active;
    $("#mon-events-card").hidden = !(active || (snap.session && snap.session.events.length));

    // Signals: only measured values; "—" when there is no tracked face.
    const tracked = snap.status === "tracking" || snap.status === "turned";
    $("#sig-eyes").textContent = snap.eyes === "unknown" ? "—" : t(`signals.eyes.${snap.eyes}`);
    $("#sig-mouth").textContent = tracked && snap.mouth !== "unknown" ? t(`signals.mouth.${snap.mouth}`) : "—";
    $("#sig-head").textContent = tracked && snap.head !== "unknown" ? t(`signals.head.${snap.head}`) : "—";
    $("#sig-eyes").className = snap.eyes === "closed" ? "warn" : snap.eyes === "open" ? "ok" : "";
    const after = fmtSec(snap.settings.alertAfterMs);
    $("#mon-closure").textContent =
      snap.status === "tracking" ? t(snap.eyes === "closed" ? "mon.closure.closed" : "mon.closure.open", { s: fmtSec(snap.closedMs), t: after }) : t("mon.closure.none", { t: after });
    $("#mon-closure").classList.toggle("warn", snap.eyes === "closed");

    const status = snap.status;
    const [titleKey, bodyKey, tone] = STATUS[status] || STATUS.waiting;
    // The cue has its own card above; this card keeps describing the tracking state.
    $("#mon-status-title").textContent = t(titleKey);
    $("#mon-status-body").textContent = t(status === "waiting" && ui.effect === "loading" ? "mon.st.loading.sub" : bodyKey);
    $("#mon-status-dot").className = `status-dot ${tone}`;
    $("#mon-retry").hidden = status !== "unavailable";

    const alert = snap.alert;
    $("#mon-alert").hidden = !alert;
    if (alert) $("#mon-alert-title").textContent = t("alert.title", { s: fmtSec(alert.closedMs) });
    $("#global-alert").hidden = !(alert && !onMonitor);
    if (alert) $("#global-alert-text").textContent = t("alert.global", { s: fmtSec(alert.closedMs) });
    soundFor(alert, snap.settings.sound);

    $("#mon-pause-label").textContent = t(snap.paused ? "mon.resume" : "mon.pause");
    $("#mon-pause").disabled = !snap.active;
    $("#m-sound").checked = snap.settings.sound;

    const showStatus = active && !CAMERA_VIEWS.includes(ui.tab);
    $("#cam-status").hidden = !showStatus;
    if (showStatus) $("#cam-status-text").textContent = t(snap.paused ? "cam.status.paused" : "cam.status.on");

    if (onMonitor && active) {
      drawChart(snap);
      renderEvents(snap);
    }
    if (ui.tab === "history") renderHistory(false);
    if (ui.tab === "settings") renderCalibration(snap);
  }

  function drawChart(snap) {
    const canvas = $("#mon-chart");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const points = snap.chart;
    $("#chart-empty").hidden = points.length > 0;
    $("#chart-note").textContent = t(snap.calibrated ? "chart.calibrated" : "chart.default");
    const internals = window.alertnessMonitorInternals;
    const y = (v) => h - 6 - (Math.max(0, Math.min(1.3, v)) / 1.3) * (h - 12);
    ctx.strokeStyle = "rgba(245, 184, 74, 0.6)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y(internals.CLOSE_RATIO));
    ctx.lineTo(w, y(internals.CLOSE_RATIO));
    ctx.stroke();
    ctx.setLineDash([]);
    if (!points.length) return;
    const end = points[points.length - 1].at;
    const x = (at) => w - ((end - at) / 30000) * w;
    ctx.strokeStyle = "#38d6f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let prev = null;
    for (const p of points) {
      // A gap (no tracked face) breaks the line instead of joining unrelated samples.
      if (prev === null || p.at - prev > 1000) ctx.moveTo(x(p.at), y(p.value));
      else ctx.lineTo(x(p.at), y(p.value));
      prev = p.at;
    }
    ctx.stroke();
  }

  function renderEvents(snap) {
    const list = $("#mon-events");
    const events = snap.session ? snap.session.events : [];
    const key = `${snap.session && snap.session.id}:${events.length}:${window.i18n.lang}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    list.replaceChildren();
    events.slice(-8).reverse().forEach((e) => list.append(eventRow(e, "li")));
  }

  function eventRow(e, tag) {
    const { label, detail } = eventText(e);
    const row = document.createElement(tag);
    row.className = `ev ev-${e.type}`;
    const cells = tag === "tr" ? ["td", "td", "td"] : ["span", "b", "span"];
    [fmtTime(e.wall), label, detail].forEach((text, i) => {
      const cell = document.createElement(cells[i]);
      cell.textContent = text;
      row.append(cell);
    });
    return row;
  }

  // ---------- sound ----------
  // Browsers allow audio only after a user gesture, so the context is created on the first click or key press.
  let audio = null;
  function unlockAudio() {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!audio && Context) audio = new Context();
      if (audio && audio.state === "suspended") audio.resume();
    } catch (_) {
      audio = null;
    }
  }
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("keydown", unlockAudio);

  function beep() {
    if (!audio) return;
    try {
      const t0 = audio.currentTime;
      for (const offset of [0, 0.32]) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.24);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.26);
      }
    } catch (_) {
      /* no sound on this device */
    }
  }

  /** Beep when a cue starts, then every 4 s while it lasts (unless muted or dismissed). */
  function soundFor(alert, enabled) {
    if (!alert || !enabled) {
      if (!alert) ui.lastBeep = 0;
      return;
    }
    const now = performance.now();
    if (!ui.lastBeep || now - ui.lastBeep >= 4000) {
      ui.lastBeep = now;
      beep();
    }
  }

  // ---------- monitor controls ----------
  $("#mon-alert-dismiss").addEventListener("click", () => monitor.dismissAlert());
  $("#mon-pause").addEventListener("click", () => {
    const now = performance.now();
    if (monitor.snapshot().paused) monitor.resume(now);
    else monitor.pause(now);
  });
  $("#mon-retry").addEventListener("click", () => camera.retryLandmarks());
  function setSound(on) {
    monitor.setSettings({ sound: on });
    saveMonitorSettings(monitor.snapshot().settings);
    renderMonitorSettings();
  }
  $("#m-sound").addEventListener("change", (e) => setSound(e.target.checked));
  $("#s-sound").addEventListener("change", (e) => setSound(e.target.checked));
  $("#s-duration").addEventListener("change", (e) => {
    monitor.setSettings({ alertAfterMs: Number(e.target.value) * 1000 });
    saveMonitorSettings(monitor.snapshot().settings);
    renderMonitorSettings(); // shows the clamped value
  });
  $("#s-calibrate").addEventListener("click", () => monitor.calibrate(performance.now()));
  $("#s-cal-reset").addEventListener("click", () => monitor.resetCalibration());
  $("#s-clear").addEventListener("click", () => {
    $("#s-clear-confirm").hidden = false;
    $("#s-clear-done").hidden = true;
  });
  $("#s-clear-no").addEventListener("click", () => ($("#s-clear-confirm").hidden = true));
  $("#s-clear-yes").addEventListener("click", () => {
    monitor.clearHistory();
    ui.histSel = null;
    $("#s-clear-confirm").hidden = true;
    $("#s-clear-done").hidden = false;
    renderHistory(true);
  });

  function renderMonitorSettings() {
    const s = monitor.snapshot().settings;
    $("#s-sound").checked = s.sound;
    $("#m-sound").checked = s.sound;
    $("#s-duration").value = String(s.alertAfterMs / 1000);
    renderCalibration(monitor.snapshot());
  }

  function renderCalibration(snap) {
    const ready = snap.status === "tracking" && !snap.paused;
    const running = snap.calibration === "running";
    $("#s-calibrate").disabled = !ready || running;
    const key = running ? "set.cal.running" : snap.calibration === "failed" ? "set.cal.failed" : snap.calibrated ? "set.cal.done" : ready ? "set.cal.ready" : "set.cal.needCamera";
    $("#s-cal-status").textContent = t(key);
    $("#s-cal-status").classList.toggle("error", snap.calibration === "failed");
    $("#s-cal-reset").hidden = !snap.calibrated;
  }

  // ---------- history ----------
  function renderHistory(force) {
    const sessions = monitor.history();
    const current = sessions.find((x) => x.id === ui.histSel) || sessions[0] || null;
    const key = `${sessions.length}:${sessions.map((x) => x.events.length).join(",")}:${current && current.id}:${window.i18n.lang}`;
    if (!force && key === ui.histKey) return;
    ui.histKey = key;
    const list = $("#hist-list");
    list.replaceChildren();
    $("#hist-empty").hidden = sessions.length > 0;
    sessions.forEach((x) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hist-item";
      button.setAttribute("aria-pressed", String(current && x.id === current.id));
      const date = document.createElement("b");
      date.textContent = fmtDate(x.startedAt);
      const time = document.createElement("span");
      time.textContent = `${fmtClock(x.startedAt)} – ${x.endedAt ? fmtClock(x.endedAt) : t("hist.now")}`;
      const tag = document.createElement("span");
      tag.className = x.alerts ? "tag warn" : "tag";
      tag.textContent = x.endedAt ? t("hist.cueCount", { n: x.alerts }) : t("hist.running");
      button.append(date, time, tag);
      button.addEventListener("click", () => {
        ui.histSel = x.id;
        renderHistory(true);
      });
      li.append(button);
      list.append(li);
    });
    $("#hist-detail").hidden = !current;
    if (!current) return;
    const end = current.endedAt || Date.now();
    $("#hist-running").hidden = Boolean(current.endedAt);
    $("#hist-date").textContent = fmtDate(current.startedAt);
    $("#hist-time").textContent = `${fmtClock(current.startedAt)} – ${current.endedAt ? fmtClock(current.endedAt) : t("hist.now")}`;
    $("#hist-duration").textContent = fmtDuration(end - current.startedAt);
    $("#hist-cues").textContent = String(current.alerts);
    const body = $("#hist-events");
    body.replaceChildren();
    current.events.forEach((e) => body.append(eventRow(e, "tr")));
    drawTimeline(current, end);
  }

  const EVENT_COLORS = { alert: "#f5b84a", lost: "#ff7b7b", multiple: "#ff7b7b", invalid: "#ff7b7b", stopped: "#7f8ea3" };
  function drawTimeline(session, end) {
    const canvas = $("#hist-timeline");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const span = Math.max(1000, end - session.startedAt);
    const x = (wall) => 10 + ((wall - session.startedAt) / span) * (w - 20);
    ctx.strokeStyle = "#2b3a4f";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(10, 22);
    ctx.lineTo(w - 10, 22);
    ctx.stroke();
    for (const e of session.events) {
      ctx.fillStyle = EVENT_COLORS[e.type] || "#38d6f0";
      ctx.beginPath();
      ctx.arc(x(e.wall), 22, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#95a0b1";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(fmtClock(session.startedAt), 4, 36);
    ctx.textAlign = "right";
    ctx.fillText(fmtClock(end), w - 4, 36);
  }

  window.i18n.apply();
  renderPage();
  renderMonitorSettings();
  renderMonitor();
  renderSettings();
  renderEffect();
  renderShots();
  renderBackground();
  renderCamera();
})();
