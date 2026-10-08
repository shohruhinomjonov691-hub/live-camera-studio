// EN/KO coverage and the saved language choice (app/static/i18n.js). Run: node --test tests/js/*.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function loadDicts() {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read("app/static/i18n/en.js"), context);
  vm.runInContext(read("app/static/i18n/ko.js"), context);
  return context.LCS_I18N;
}

function loadI18n(storage) {
  const context = {
    localStorage: storage,
    document: { documentElement: {}, title: "", querySelectorAll: () => [] },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["i18n/en.js", "i18n/ko.js", "i18n.js"]) vm.runInContext(read(`app/static/${file}`), context);
  return context;
}

test("English and Korean have exactly the same keys", () => {
  const { en, ko } = loadDicts();
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(ko)) assert.ok(value.trim(), `empty KO string: ${key}`);
});

test("translations are plain text (never inserted as HTML)", () => {
  const { en, ko } = loadDicts();
  for (const value of [...Object.values(en), ...Object.values(ko)]) assert.doesNotMatch(value, /<[a-z/]/i);
});

test("every key used by the page and scripts exists", () => {
  const { en } = loadDicts();
  const html = read("app/static/index.html");
  const used = [...html.matchAll(/data-i18n(?:-aria|-title|-alt)?="([^"]+)"/g)].map((m) => m[1]);
  for (const file of ["app/static/app.js", "app/static/shell.js"]) {
    const code = read(file);
    used.push(...[...code.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]));
    used.push(...[...code.matchAll(/setStatus\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]));
  }
  // Keys built at runtime
  used.push("privacy.strength.1", "privacy.strength.2", "privacy.strength.3");
  const missing = [...new Set(used)].filter((key) => !(key in en));
  assert.deepEqual(missing, []);
});

test("every backend error code has a translation", () => {
  const { en } = loadDicts();
  const python = ["app/blur.py", "app/image_io.py", "app/main.py"].map(read).join("\n");
  const codes = new Set([...python.matchAll(/ImageError\(\d{3}, "([a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(codes.size >= 7);
  for (const code of [...codes, "network", "unknown"]) assert.ok(`error.${code}` in en, `missing error.${code}`);
});

test("English is the default; the chosen language survives a reload", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const first = loadI18n(storage);
  assert.equal(first.i18n.lang, "en");
  assert.equal(first.i18n.t("tab.camera"), "Live camera");
  first.i18n.setLang("ko");
  assert.equal(first.document.documentElement.lang, "ko");

  const reloaded = loadI18n(storage);
  assert.equal(reloaded.i18n.lang, "ko");
  assert.equal(reloaded.i18n.t("tab.camera"), "라이브 카메라");
  reloaded.i18n.setLang("xx"); // unknown codes are ignored
  assert.equal(reloaded.i18n.lang, "ko");
});

test("blocked storage falls back to English and still switches for the page", () => {
  const storage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const ctx = loadI18n(storage);
  assert.equal(ctx.i18n.lang, "en");
  ctx.i18n.setLang("ko");
  assert.equal(ctx.i18n.lang, "ko");
});

test("parameters are filled in", () => {
  const ctx = loadI18n({ getItem: () => null, setItem() {} });
  assert.equal(ctx.i18n.t("upload.count", { auto: 2, manual: 1 }), "Found automatically: 2 · manual: 1");
  assert.equal(ctx.i18n.t("error.unknown", { status: 502 }), "Something went wrong (HTTP 502).");
});
