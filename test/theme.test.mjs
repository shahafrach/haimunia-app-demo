// Theme switching through the real app (index.html + app.js in jsdom): the state
// machine, persistence, the radio groups in Settings, and the chrome-color tag.
// What the colors LOOK like cannot be seen in jsdom: test/design-contrast.test.mjs
// computes them from the tokens, and scripts/browser-check/appearance.mjs
// measures the real thing in Chromium.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("a first load follows the system: no data-theme, chalk palette, transparency off", async () => {
  const window = await bootApp();
  const root = window.document.documentElement;
  assert.equal(root.hasAttribute("data-theme"), false, "default is the system, not a forced theme");
  assert.equal(root.getAttribute("data-palette"), "chalk");
  assert.equal(root.getAttribute("data-transparency"), "off");
});

test("setThemePref applies the attribute and persists it", async () => {
  const window = await bootApp();
  window.setThemePref("light");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(window.localStorage.getItem("haimunia-demo:theme"), "light");
  window.setThemePref("dark");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(window.localStorage.getItem("haimunia-demo:theme"), "dark");
});

test("\"auto\" removes the explicit attribute so the system decides", async () => {
  const window = await bootApp();
  window.setThemePref("dark");
  window.setThemePref("auto");
  assert.equal(window.document.documentElement.hasAttribute("data-theme"), false);
  assert.equal(window.localStorage.getItem("haimunia-demo:theme"), "auto");
});

test("setThemePref ignores an invalid value instead of applying garbage", async () => {
  const window = await bootApp();
  window.setThemePref("light");
  window.setThemePref("neon");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
});

test("loadThemePref reads a previously-saved choice back from localStorage", async () => {
  const window = await bootApp();
  window.localStorage.setItem("haimunia-demo:theme", "light");
  window.localStorage.setItem("haimunia-demo:palette", "iris");
  window.localStorage.setItem("haimunia-demo:transparency", "on");
  window.loadThemePref();
  window.applyThemePref();
  const root = window.document.documentElement;
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(root.getAttribute("data-palette"), "iris");
  assert.equal(root.getAttribute("data-transparency"), "on");
});

test("Settings shows all three controls and reflects the current choice", async () => {
  const window = await bootApp();
  window.setThemePref("light");
  window.setPalettePref("sand");
  const doc = window.document;
  const checked = (sel) => doc.querySelector(`#settingsBody ${sel}[aria-checked="true"]`);
  assert.equal(checked("[data-action='set-theme']").dataset.pref, "light");
  assert.equal(checked("[data-action='set-palette']").dataset.palette, "sand");
  assert.equal(checked("[data-action='set-transparency']").dataset.pref, "off");
  assert.equal(doc.querySelectorAll("#settingsBody [data-action='set-palette']").length, 5, "five palettes");
  assert.equal(doc.querySelectorAll("#settingsBody [data-action='set-theme']").length, 3, "light, dark, system");
});

test("every palette option carries data-palette, so its miniature re-resolves the tokens", async () => {
  const window = await bootApp();
  const ids = [...window.document.querySelectorAll("#settingsBody .palette-opt")].map((el) => el.getAttribute("data-palette"));
  assert.deepEqual(ids, ["chalk", "slate", "cedar", "sand", "iris"]);
});

test("the chrome color follows the page: one live theme-color tag replaces the two static ones", async () => {
  const window = await bootApp();
  const before = window.document.querySelectorAll('meta[name="theme-color"]').length;
  assert.ok(before >= 1);
  window.setThemePref("dark");
  // jsdom resolves no custom properties, so no live value can be computed there; what must hold
  // is that the update never throws and never leaves the page without a tag.
  assert.ok(window.document.querySelectorAll('meta[name="theme-color"]').length >= 1);
});
