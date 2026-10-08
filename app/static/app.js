"use strict";

const MAX_BYTES = 10 * 1024 * 1024;
const t = (key, params) => window.i18n.t(key, params);
const MIN_DRAW_PX = 6; // minimum manual box size in original image pixels

const state = {
  file: null,
  width: 0,
  height: 0,
  regions: [], // {id, x, y, w, h, source} in original image pixels
  nextId: 1,
  resultUrl: null,
  originalUrl: null,
  // Every accepted file starts a new session; async results from an older session are dropped,
  // so a slow detect/blur for file A can never apply A's regions or preview to file B.
  session: 0,
  blurSeq: 0,
  draft: null,
  status: null, // {key, params, tone}; kept as a key so it re-renders when the language changes
  errorInfo: null, // {code, status} of the last failed detect, shown in the error card
};

let dragStart = null;

const el = {
  file: document.getElementById("file"),
  status: document.getElementById("status"),
  workspace: document.getElementById("workspace"),
  count: document.getElementById("count"),
  toggle: document.getElementById("toggle-boxes"),
  draw: document.getElementById("draw-mode"),
  hint: document.getElementById("draw-hint"),
  download: document.getElementById("download"),
  preview: document.getElementById("preview"),
  overlay: document.getElementById("overlay"),
  regions: document.getElementById("regions"),
  empty: document.getElementById("up-empty"),
  error: document.getElementById("up-error"),
  errorMsg: document.getElementById("up-error-msg"),
  errorCode: document.getElementById("up-error-code"),
};

/**
 * Map a point on the responsive preview to original image pixels.
 * The overlay has exactly the displayed image size, so a linear scale per axis is exact.
 */
function toImagePoint(clientX, clientY, rect, width, height) {
  const x = ((clientX - rect.left) / rect.width) * width;
  const y = ((clientY - rect.top) / rect.height) * height;
  return {
    x: Math.min(width, Math.max(0, x)),
    y: Math.min(height, Math.max(0, y)),
  };
}

function rectFromPoints(a, b) {
  const x0 = Math.round(Math.min(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y));
  const x1 = Math.round(Math.max(a.x, b.x));
  const y1 = Math.round(Math.max(a.y, b.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

window.faceBlur = { toImagePoint, rectFromPoints, state };

/** tone: "" (neutral), "ok" or "error". */
function setStatus(key, params = {}, tone = "") {
  state.status = key ? { key, params, tone } : null;
  renderStatus();
}

function renderStatus() {
  const s = state.status;
  el.status.textContent = s ? t(s.key, s.params) : "";
  el.status.classList.toggle("error", Boolean(s && s.tone === "error"));
  el.status.classList.toggle("ok", Boolean(s && s.tone === "ok"));
}

/** The server sends a stable `code`; its English `detail` is never shown. */
async function errorInfo(response) {
  let code = null;
  try {
    const body = await response.json();
    if (body && typeof body.code === "string") code = body.code;
  } catch (_) {
    /* not JSON */
  }
  return { code, status: response.status };
}

function errorKey(info) {
  return info.code && window.i18n.has(`error.${info.code}`) ? `error.${info.code}` : "error.unknown";
}

function showErrorCard(info) {
  el.empty.hidden = true;
  el.workspace.hidden = true;
  el.error.hidden = false;
  state.errorInfo = info;
  renderErrorCard();
  setStatus(null);
}

function renderErrorCard() {
  if (el.error.hidden || !state.errorInfo) return;
  const info = state.errorInfo;
  el.errorMsg.textContent = t(errorKey(info), { status: info.status });
  el.errorCode.textContent = [info.status, info.code].filter(Boolean).join(" · ");
}

function resetResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  el.download.href = "#";
  el.download.setAttribute("aria-disabled", "true");
}

async function onFileSelected() {
  const file = el.file.files[0];
  if (!file) return;
  el.file.value = "";

  // Client-side checks keep the current photo; the server checks again.
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    setStatus("error.unsupported_format", {}, "error");
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus("error.file_too_large", {}, "error");
    return;
  }

  // Invalidate everything that belongs to the previous file before any await.
  const session = ++state.session;
  state.blurSeq++; // drops a pending blur of the previous file
  resetResult();
  if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
  state.originalUrl = null;
  state.file = file;
  state.width = 0;
  state.height = 0;
  state.regions = [];
  state.nextId = 1;
  state.draft = null;
  dragStart = null;
  el.preview.removeAttribute("src");
  el.workspace.hidden = true;
  el.error.hidden = true;
  el.empty.hidden = true;
  setDrawMode(false);
  setStatus("upload.detecting");

  let data;
  try {
    const response = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (session !== state.session) return;
    if (!response.ok) {
      const info = await errorInfo(response);
      if (session === state.session) showErrorCard(info);
      return;
    }
    data = await response.json();
  } catch (_) {
    if (session === state.session) showErrorCard({ code: "network", status: null });
    return;
  }
  if (session !== state.session) return; // another file was chosen while this one was detected

  state.width = data.width;
  state.height = data.height;
  state.regions = data.faces.map((f) => ({ id: state.nextId++, ...f, source: "auto" }));
  state.originalUrl = URL.createObjectURL(file);
  el.preview.src = state.originalUrl;
  el.workspace.hidden = false;
  render();
  await requestBlur();
}

async function requestBlur() {
  if (!state.file || !state.width) return;
  const session = state.session;
  const file = state.file;
  const seq = ++state.blurSeq;
  // A result is current only if no newer blur started and no other file was chosen.
  const current = () => seq === state.blurSeq && session === state.session;
  el.download.setAttribute("aria-disabled", "true");
  setStatus("upload.blurring");

  const regions = state.regions.map(({ x, y, w, h, source }) => ({ x, y, w, h, source }));
  try {
    const response = await fetch("/api/blur", {
      method: "POST",
      headers: { "Content-Type": file.type, "X-Regions": JSON.stringify(regions) },
      body: file,
    });
    if (!current()) return;
    if (!response.ok) {
      const info = await errorInfo(response);
      if (current()) setStatus(errorKey(info), { status: info.status }, "error");
      return;
    }
    const blob = await response.blob();
    if (!current()) return;
    resetResult();
    state.resultUrl = URL.createObjectURL(blob);
    el.preview.src = state.resultUrl;
    el.download.href = state.resultUrl;
    el.download.download = downloadName(file.name, blob.type);
    el.download.setAttribute("aria-disabled", "false");
    setStatus(state.regions.length ? "upload.ready" : "upload.noRegions", {}, state.regions.length ? "ok" : "");
  } catch (_) {
    if (current()) setStatus("error.network", {}, "error");
  }
}

function downloadName(original, type) {
  const base = original.replace(/\.[^.]+$/, "") || "image";
  return `${base}-blurred.${type === "image/png" ? "png" : "jpg"}`;
}

function percentStyle(node, r) {
  node.style.left = `${(r.x / state.width) * 100}%`;
  node.style.top = `${(r.y / state.height) * 100}%`;
  node.style.width = `${(r.w / state.width) * 100}%`;
  node.style.height = `${(r.h / state.height) * 100}%`;
}

function render() {
  const autoCount = state.regions.filter((r) => r.source === "auto").length;
  const manualCount = state.regions.length - autoCount;
  el.count.textContent = t("upload.count", { auto: autoCount, manual: manualCount });

  el.overlay.replaceChildren();
  state.regions.forEach((r, index) => {
    const box = document.createElement("div");
    box.className = `box ${r.source}`;
    percentStyle(box, r);
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    box.append(label);
    el.overlay.append(box);
  });
  if (state.draft) {
    const draft = document.createElement("div");
    draft.className = "box draft";
    percentStyle(draft, state.draft);
    el.overlay.append(draft);
  }
  el.overlay.classList.toggle("hide-boxes", !el.toggle.checked);

  el.regions.replaceChildren();
  if (!state.regions.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("upload.none");
    el.regions.append(li);
    return;
  }
  state.regions.forEach((r, index) => {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = `tag ${r.source}`;
    tag.textContent = t(r.source === "auto" ? "tag.auto" : "tag.manual");
    const text = document.createElement("span");
    text.className = "what";
    text.textContent = t("region.size", { n: index + 1, w: r.w, h: r.h });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn";
    remove.textContent = t("region.remove");
    remove.setAttribute("aria-label", t("region.removeAria", { n: index + 1 }));
    remove.addEventListener("click", () => {
      state.regions = state.regions.filter((item) => item.id !== r.id);
      render();
      requestBlur();
    });
    li.append(tag, text, remove);
    el.regions.append(li);
  });
}

function setDrawMode(on) {
  el.draw.setAttribute("aria-pressed", String(on));
  el.overlay.classList.toggle("drawing", on);
  el.hint.hidden = !on;
}

el.overlay.addEventListener("pointerdown", (event) => {
  if (el.draw.getAttribute("aria-pressed") !== "true" || !state.width) return;
  event.preventDefault();
  el.overlay.setPointerCapture(event.pointerId);
  const rect = el.overlay.getBoundingClientRect();
  dragStart = toImagePoint(event.clientX, event.clientY, rect, state.width, state.height);
  state.draft = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
  render();
});

el.overlay.addEventListener("pointermove", (event) => {
  if (!dragStart) return;
  const rect = el.overlay.getBoundingClientRect();
  const point = toImagePoint(event.clientX, event.clientY, rect, state.width, state.height);
  state.draft = rectFromPoints(dragStart, point);
  render();
});

function finishDrag(event) {
  if (!dragStart) return;
  const rect = el.overlay.getBoundingClientRect();
  const point = toImagePoint(event.clientX, event.clientY, rect, state.width, state.height);
  const box = rectFromPoints(dragStart, point);
  dragStart = null;
  state.draft = null;
  if (box.w >= MIN_DRAW_PX && box.h >= MIN_DRAW_PX) {
    state.regions.push({ id: state.nextId++, ...box, source: "manual" });
    render();
    requestBlur();
  } else {
    render();
  }
}

el.overlay.addEventListener("pointerup", finishDrag);
el.overlay.addEventListener("pointercancel", () => {
  dragStart = null;
  state.draft = null;
  render();
});

el.file.addEventListener("change", onFileSelected);
el.toggle.addEventListener("change", render);
el.draw.addEventListener("click", () => setDrawMode(el.draw.getAttribute("aria-pressed") !== "true"));
document.querySelectorAll("[data-pick-file]").forEach((button) => button.addEventListener("click", () => el.file.click()));
window.i18n.onChange(() => {
  renderStatus();
  renderErrorCard();
  if (!el.workspace.hidden) render();
});
