// Regression tests for the upload flow's async races (app/static/app.js).
// Runs app.js in a vm context with a minimal fake DOM and a controllable fetch.
// No dependencies: node --test tests/js/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../app/static/${path}`, import.meta.url), "utf8");
const APP_JS = read("app.js");
const I18N_JS = [read("i18n/en.js"), read("i18n/ko.js"), read("i18n.js")];

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.listeners = {};
    this.attrs = {};
    this.style = {};
    this.children = [];
    this.hidden = false;
    this.checked = true;
    this.textContent = "";
    this.src = "";
    this.href = "";
    this.files = [];
    this.value = "";
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) {
    delete this.attrs[name];
    if (name === "src") this.src = "";
  }
  replaceChildren() { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  setPointerCapture() {}
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

function okBlob(name) {
  return { ok: true, status: 200, blob: async () => ({ type: "image/jpeg", name }) };
}

function loadApp() {
  const elements = {};
  const calls = []; // every fetch: { url, init, reply }
  let blobUrls = 0;
  const context = {
    console,
    document: {
      getElementById: (id) => (elements[id] ||= new FakeElement(id)),
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
      documentElement: {},
      title: "",
    },
    fetch: (url, init) => {
      const d = deferred();
      calls.push({ url, init, reply: d.resolve });
      return d.promise;
    },
    URL: {
      createObjectURL: (blob) => `blob:${++blobUrls}:${blob.name ?? "file"}`,
      revokeObjectURL() {},
    },
  };
  context.window = context;
  vm.createContext(context);
  I18N_JS.forEach((code) => vm.runInContext(code, context));
  vm.runInContext(APP_JS, context);
  const el = (id) => elements[id];
  const choose = (file) => {
    el("file").files = [file];
    return el("file").listeners.change();
  };
  return { context, el, calls, choose, state: context.faceBlur.state };
}

const flush = () => new Promise((r) => setImmediate(r));
const fileA = { name: "a.jpg", type: "image/jpeg", size: 100 };
const fileB = { name: "b.jpg", type: "image/jpeg", size: 100 };
const detectA = { width: 400, height: 300, count: 1, faces: [{ x: 10, y: 20, w: 30, h: 40 }] };
const detectB = { width: 200, height: 100, count: 1, faces: [{ x: 150, y: 50, w: 20, h: 20 }] };

test("A then B with detect replies in reverse order: A's late reply is ignored", async () => {
  const { el, calls, choose, state } = loadApp();
  choose(fileA);
  choose(fileB);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, fileA);
  assert.equal(calls[1].init.body, fileB);

  // While B is being detected nothing from A is shown or drawable.
  assert.equal(el("workspace").hidden, true);
  assert.equal(state.width, 0);

  calls[1].reply(okJson(detectB));
  await flush();
  assert.deepEqual([state.width, state.height], [200, 100]);
  assert.equal(calls.length, 3, "B's detect starts a blur");
  const blurB = calls[2];
  assert.equal(blurB.url, "/api/blur");
  assert.equal(blurB.init.body, fileB);
  assert.deepEqual(JSON.parse(blurB.init.headers["X-Regions"]), [{ x: 150, y: 50, w: 20, h: 20, source: "auto" }]);

  calls[0].reply(okJson(detectA)); // A arrives last
  await flush();
  assert.equal(state.file, fileB);
  assert.deepEqual([state.width, state.height], [200, 100], "A's dimensions must not overwrite B's");
  assert.deepEqual(state.regions.map((r) => r.x), [150], "A's regions must not be applied");
  assert.equal(calls.length, 3, "A's late reply must not start a blur");

  blurB.reply(okBlob("B-blurred"));
  await flush();
  assert.match(el("preview").src, /B-blurred/);
  assert.equal(el("download").getAttribute("aria-disabled"), "false");
});

test("a pending blur of A is dropped when B is chosen", async () => {
  const { el, calls, choose, state } = loadApp();
  choose(fileA);
  calls[0].reply(okJson(detectA));
  await flush();
  const blurA = calls[1];
  assert.equal(blurA.init.body, fileA);

  choose(fileB);
  assert.equal(el("download").getAttribute("aria-disabled"), "true");
  assert.equal(el("preview").src, "", "A's preview is cleared as soon as B is chosen");

  blurA.reply(okBlob("A-blurred"));
  await flush();
  assert.doesNotMatch(el("preview").src, /A-blurred/);
  assert.equal(el("download").getAttribute("aria-disabled"), "true");
  assert.equal(el("download").href, "#");

  calls[2].reply(okJson(detectB));
  await flush();
  const blurB = calls[3];
  assert.equal(blurB.init.body, fileB);
  blurB.reply(okBlob("B-blurred"));
  await flush();
  assert.match(el("preview").src, /B-blurred/);
  assert.equal(state.file, fileB);
});

test("an error reply for A does not overwrite B's status", async () => {
  const { el, calls, choose } = loadApp();
  choose(fileA);
  choose(fileB);
  calls[1].reply(okJson(detectB));
  await flush();
  calls[0].reply({ ok: false, status: 422, json: async () => ({ detail: "A is broken" }) });
  await flush();
  assert.notEqual(el("status").textContent, "A is broken");
  assert.equal(el("workspace").hidden, false);
});

test("a server error is shown from its code, in the chosen language", async () => {
  const { el, calls, choose, context } = loadApp();
  choose(fileA);
  calls[0].reply({ ok: false, status: 415, json: async () => ({ code: "unsupported_format", detail: "English debug text" }) });
  await flush();
  assert.equal(el("up-error").hidden, false);
  assert.equal(el("up-error-msg").textContent, "Only JPEG or PNG images are accepted.");
  assert.equal(el("up-error-code").textContent, "415 · unsupported_format");
  context.i18n.setLang("ko");
  assert.equal(el("up-error-msg").textContent, "JPEG 또는 PNG 이미지만 사용할 수 있습니다.");
});

test("an unknown error code falls back to a generic message with the HTTP status", async () => {
  const { el, calls, choose } = loadApp();
  choose(fileA);
  calls[0].reply({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
  await flush();
  assert.equal(el("up-error-msg").textContent, "Something went wrong (HTTP 502).");
});
