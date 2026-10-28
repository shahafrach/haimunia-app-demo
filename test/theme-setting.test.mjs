// The palette, theme and transparency setting: src/theme.js (the logic the app
// runs with) and theme-init.js (the tiny script that stamps the same choice
// before first paint). They must agree on keys, values and defaults.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const themeSrc = fs.readFileSync(new URL("src/theme.js", root), "utf8");
const initSrc = fs.readFileSync(new URL("theme-init.js", root), "utf8");

function page(stored = {}, { matches = false, supports = true } = {}) {
  const dom = new JSDOM("<!doctype html><html><head><meta name=\"theme-color\" content=\"x\" media=\"(prefers-color-scheme: light)\"><meta name=\"theme-color\" content=\"y\" media=\"(prefers-color-scheme: dark)\"></head><body></body></html>", { url: "https://example.test/", runScripts: "outside-only" });
  const w = dom.window;
  for (const [k, v] of Object.entries(stored)) w.localStorage.setItem("haimunia-demo:" + k, v);
  w.matchMedia = (q) => ({ matches: /prefers-color-scheme: dark/.test(q) ? matches : /reduced-transparency/.test(q) ? !!matches : false, addEventListener() {} });
  w.CSS = { supports: () => supports };
  return w;
}
const load = (w) => { w.eval(themeSrc); return w.BoxLogTheme; };

test("five palettes, in picker order, each with a Hebrew name", () => {
  const T = load(page());
  assert.deepEqual(T.PALETTES.map((p) => p.id), ["chalk", "slate", "cedar", "sand", "iris"]);
  assert.ok(T.PALETTES.every((p) => /[֐-׿]/.test(p.name)));
  assert.deepEqual(T.THEMES.map((t) => t.id), ["light", "dark", "auto"]);
});

test("defaults: chalk, follow the system, transparency off", () => {
  const T = load(page());
  assert.deepEqual({ ...T.DEFAULTS }, { palette: "chalk", theme: "auto", transparency: "off" });
  assert.deepEqual(T.read(page().localStorage), { palette: "chalk", theme: "auto", transparency: "off" });
});

test("normalizers reject anything outside the allowed values", () => {
  const T = load(page());
  assert.equal(T.normalizePalette("iris"), "iris");
  assert.equal(T.normalizePalette("neon"), "chalk");
  assert.equal(T.normalizePalette(undefined), "chalk");
  assert.equal(T.normalizeTheme("dark"), "dark");
  assert.equal(T.normalizeTheme("sepia"), "auto");
  assert.equal(T.normalizeTransparency("on"), "on");
  assert.equal(T.normalizeTransparency("maybe"), "off");
  assert.equal(T.isPalette("slate"), true);
  assert.equal(T.isPalette("__proto__"), false);
});

test("write then read round-trips, and a bad stored value reads back as the default", () => {
  const w = page();
  const T = load(w);
  T.write("palette", "cedar", w.localStorage);
  T.write("theme", "dark", w.localStorage);
  T.write("transparency", "on", w.localStorage);
  assert.deepEqual(T.read(w.localStorage), { palette: "cedar", theme: "dark", transparency: "on" });
  w.localStorage.setItem("haimunia-demo:palette", "<script>");
  assert.equal(T.read(w.localStorage).palette, "chalk");
});

test("storage that throws never breaks the setting", () => {
  const T = load(page());
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.deepEqual(T.read(broken), { palette: "chalk", theme: "auto", transparency: "off" });
  assert.doesNotThrow(() => T.write("palette", "iris", broken));
  assert.deepEqual(T.read(null), { palette: "chalk", theme: "auto", transparency: "off" });
});

test("apply stamps data-palette and data-transparency always, data-theme only when forced", () => {
  const w = page();
  const T = load(w);
  const r = w.document.documentElement;
  T.apply(w.document, { palette: "slate", theme: "light", transparency: "on" });
  assert.equal(r.getAttribute("data-palette"), "slate");
  assert.equal(r.getAttribute("data-theme"), "light");
  assert.equal(r.getAttribute("data-transparency"), "on");
  T.apply(w.document, { palette: "slate", theme: "auto", transparency: "off" });
  assert.equal(r.hasAttribute("data-theme"), false);
  assert.equal(r.getAttribute("data-transparency"), "off");
  T.apply(w.document, { palette: "nope" });
  assert.equal(r.getAttribute("data-palette"), "chalk", "an unknown palette never reaches the attribute");
});

test("resolveTheme: forced themes win; auto asks the system; no light-dark() means light only", () => {
  const dark = load(page({}, { matches: true }));
  assert.equal(dark.resolveTheme("auto"), "dark");
  assert.equal(dark.resolveTheme("light"), "light");
  const light = load(page({}, { matches: false }));
  assert.equal(light.resolveTheme("auto"), "light");
  assert.equal(light.resolveTheme("dark"), "dark");
  const old = load(page({}, { matches: true, supports: false }));
  assert.equal(old.darkSupported(), false);
  assert.equal(old.resolveTheme("dark"), "light", "a browser without light-dark() has only the light theme");
  assert.equal(old.resolveTheme("auto"), "light");
});

test("reduced transparency and missing blur support are both reported", () => {
  assert.equal(load(page({}, { matches: true })).reducedTransparency(), true);
  assert.equal(load(page({}, { matches: false })).reducedTransparency(), false);
  assert.equal(load(page({}, { supports: false })).blurSupported(), false);
  assert.equal(load(page({}, { supports: true })).blurSupported(), true);
});

// ---- theme-init.js: the same choice, stamped before first paint ----------------
function boot(stored) {
  const w = page(stored);
  w.eval(initSrc);
  return w.document.documentElement;
}

test("theme-init.js: nothing stored means chalk, system theme, transparency off", () => {
  const r = boot({});
  assert.equal(r.getAttribute("data-palette"), "chalk");
  assert.equal(r.hasAttribute("data-theme"), false);
  assert.equal(r.getAttribute("data-transparency"), "off");
});

test("theme-init.js stamps the stored choice, and ignores values src/theme.js would reject", () => {
  const r = boot({ palette: "sand", theme: "dark", transparency: "on", textScale: "large" });
  assert.equal(r.getAttribute("data-palette"), "sand");
  assert.equal(r.getAttribute("data-theme"), "dark");
  assert.equal(r.getAttribute("data-transparency"), "on");
  assert.equal(r.getAttribute("data-text-scale"), "large");
  const bad = boot({ palette: "neon", theme: "sepia", transparency: "yes" });
  assert.equal(bad.getAttribute("data-palette"), "chalk");
  assert.equal(bad.hasAttribute("data-theme"), false);
  assert.equal(bad.getAttribute("data-transparency"), "off");
  assert.equal(boot({ theme: "auto" }).hasAttribute("data-theme"), false, "the stored word for the system leaves the attribute off");
});

test("theme-init.js and src/theme.js agree on every palette id and on the storage keys", () => {
  const T = load(page());
  for (const id of T.PALETTES.map((p) => p.id)) assert.equal(boot({ palette: id }).getAttribute("data-palette"), id);
  for (const key of Object.values(T.KEYS)) assert.ok(initSrc.includes(key) || key.endsWith(":theme") || key.endsWith(":palette") || key.endsWith(":transparency"), key);
  for (const key of Object.values(T.KEYS)) assert.ok(initSrc.includes(key), `theme-init.js must read ${key}`);
});

test("the choice never leaves the device: no theme key is written to the cloud or analytics", () => {
  for (const f of ["cloud.js", "src/analytics.js", "src/outbox.js"]) {
    const src = fs.readFileSync(new URL(f, root), "utf8");
    assert.ok(!/haimunia-demo:(palette|theme|transparency)/.test(src), `${f} must not touch the appearance keys`);
  }
});

test("theme-init.js carries no color of its own", () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(initSrc));
  void createRequire;
});
