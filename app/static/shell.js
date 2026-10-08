"use strict";

// Page shell: tabs, language switcher and the live camera UI around createCameraController (camera.js).
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
    tab: "camera", camState: "idle", camInfo: null, stats: null, effect: "off", effectAlert: false, snapshots: [],
    segmenter: "off", bgImageInfo: null, bgImageError: null,
  };
  const MAX_SNAPSHOTS = 6;

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
    onEffect: (status) => {
      ui.effect = status;
      renderEffect();
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
  };

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
    renderEffect();
    renderShots();
    renderBackground();
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

  function selectMode(mode) {
    $$("[data-mode]").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.mode === mode)));
    ["privacy", "effects", "background"].forEach((m) => ($(`#p-${m}`).hidden = m !== mode));
    // Privacy mode means face blur ON (which turns glasses OFF). The controller drops the frame in flight
    // and, if blur was off, wipes the preview at once until a blurred frame arrives.
    if (mode === "privacy") camera.setSettings({ blurOn: true });
    renderAllSettings();
  }
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => selectMode(b.dataset.mode)));

  window.i18n.apply();
  renderSettings();
  renderEffect();
  renderShots();
  renderBackground();
  renderCamera();
})();
