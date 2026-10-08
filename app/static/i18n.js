"use strict";

// UI language: English by default, Korean on request. The choice survives reloads (localStorage);
// if storage is blocked the page still works and the choice lasts until the page closes.
(function () {
  const LANGS = ["en", "ko"];
  const KEY = "lcs.lang";
  const listeners = [];

  function load() {
    try {
      const value = localStorage.getItem(KEY);
      return LANGS.includes(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  let lang = load() || "en";

  function dict(code) {
    return (window.LCS_I18N && window.LCS_I18N[code]) || {};
  }

  function has(key) {
    return key in dict("en");
  }

  function t(key, params = {}) {
    const text = dict(lang)[key] ?? dict("en")[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  }

  // Strings are only ever set as text or attributes, never as HTML.
  function apply(root = document) {
    document.documentElement.lang = lang;
    document.title = t("doc.title");
    root.querySelectorAll("[data-i18n]").forEach((node) => (node.textContent = t(node.dataset.i18n)));
    root.querySelectorAll("[data-i18n-aria]").forEach((node) => node.setAttribute("aria-label", t(node.dataset.i18nAria)));
    root.querySelectorAll("[data-i18n-title]").forEach((node) => node.setAttribute("title", t(node.dataset.i18nTitle)));
    root.querySelectorAll("[data-i18n-alt]").forEach((node) => node.setAttribute("alt", t(node.dataset.i18nAlt)));
    root.querySelectorAll("[data-lang]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.lang === lang)));
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    try {
      localStorage.setItem(KEY, lang);
    } catch (_) {
      /* storage blocked: keep the choice for this page only */
    }
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  window.i18n = {
    t,
    has,
    apply,
    setLang,
    onChange: (fn) => listeners.push(fn),
    get lang() {
      return lang;
    },
  };
})();
