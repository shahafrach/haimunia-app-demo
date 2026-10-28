// @ts-check
"use strict";
// ---- Appearance: palette, theme, transparency ------------------------------
//
// The member's three display choices, kept on the device. Colors are NOT here:
// every color is a token in the one <style id="tokens"> block of index.html,
// and this file only flips the attributes that select among them:
//
//   data-palette       one of PALETTES (always stamped)
//   data-theme         "light" or "dark"; absent means follow the system
//   data-transparency  "on" or "off" (always stamped)
//
// They live in localStorage, not IndexedDB, because theme-init.js has to read
// them synchronously before first paint, and "clear all data" leaves them
// alone. They never sync to the server.
//
// Classic <script>, wrapped in an IIFE; publishes window.BoxLogTheme. Loaded
// before app.js and also before cloud.js so either may call it.

(function () {
  const KEYS = Object.freeze({
    palette: "haimunia-demo:palette",
    theme: "haimunia-demo:theme",
    transparency: "haimunia-demo:transparency",
  });

  /** The palettes in picker order. `id` is the data-palette value. */
  const PALETTES = Object.freeze([
    Object.freeze({ id: "classic", name: "קלאסי" }),
    Object.freeze({ id: "chalk", name: "גיר ופליז" }),
    Object.freeze({ id: "slate", name: "צפחה וגחלת" }),
    Object.freeze({ id: "cedar", name: "ארז וערפל" }),
    Object.freeze({ id: "sand", name: "חול ואופק" }),
    Object.freeze({ id: "iris", name: "שנהב ואירוס" }),
  ]);
  /** "auto" is the stored word for "follow the system". */
  const THEMES = Object.freeze([
    Object.freeze({ id: "light", name: "בהיר" }),
    Object.freeze({ id: "dark", name: "כהה" }),
    Object.freeze({ id: "auto", name: "לפי המערכת" }),
  ]);
  const DEFAULTS = Object.freeze({ palette: "classic", theme: "dark", transparency: "off" });

  /** @param {unknown} v */
  function normalizePalette(v) {
    return PALETTES.some((p) => p.id === v) ? /** @type {string} */ (v) : DEFAULTS.palette;
  }
  /** @param {unknown} v */
  function normalizeTheme(v) {
    return v === "light" || v === "dark" || v === "auto" ? v : DEFAULTS.theme;
  }
  /** @param {unknown} v */
  function normalizeTransparency(v) {
    return v === "on" || v === "off" ? v : DEFAULTS.transparency;
  }
  /** @param {unknown} v */
  function isPalette(v) { return PALETTES.some((p) => p.id === v); }

  /** @param {Storage | null | undefined} storage */
  function read(storage) {
    const get = (/** @type {string} */ k) => { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } };
    return {
      palette: normalizePalette(get(KEYS.palette)),
      theme: normalizeTheme(get(KEYS.theme)),
      transparency: normalizeTransparency(get(KEYS.transparency)),
    };
  }

  /**
   * @param {"palette"|"theme"|"transparency"} kind
   * @param {string} value
   * @param {Storage | null | undefined} storage
   */
  function write(kind, value, storage) {
    try { if (storage) storage.setItem(KEYS[kind], value); } catch (e) { /* private mode: the choice lasts this session only */ }
  }

  /** Does the OS ask for less transparency? Then the switch is forced off. */
  function reducedTransparency() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-transparency: reduce)").matches); } catch (e) { return false; }
  }
  /** Can this browser blur what is behind a surface at all? */
  function blurSupported() {
    try {
      return !!(window.CSS && window.CSS.supports && (window.CSS.supports("backdrop-filter", "blur(1px)") || window.CSS.supports("-webkit-backdrop-filter", "blur(1px)")));
    } catch (e) { return false; }
  }
  /** Does the browser understand light-dark()? If not, only the light theme exists. */
  function darkSupported() {
    try { return !!(window.CSS && window.CSS.supports && window.CSS.supports("color", "light-dark(Canvas, CanvasText)")); } catch (e) { return true; }
  }

  /** The theme that is actually on screen: "light" or "dark". @param {string} theme */
  function resolveTheme(theme) {
    if (!darkSupported()) return "light";
    if (theme === "light" || theme === "dark") return theme;
    try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e) { return "light"; }
  }

  /**
   * Stamp the attributes. Idempotent; safe before any render.
   * @param {Document} doc
   * @param {{palette?: string, theme?: string, transparency?: string}} prefs
   */
  function apply(doc, prefs) {
    const root = doc.documentElement;
    const palette = normalizePalette(prefs.palette);
    const theme = normalizeTheme(prefs.theme);
    const transparency = normalizeTransparency(prefs.transparency);
    root.setAttribute("data-palette", palette);
    if (theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
    root.setAttribute("data-transparency", transparency);
    syncChromeColor(doc);
    return { palette, theme, transparency };
  }

  /**
   * Browser chrome follows the page background. The color comes from the token
   * (a probe element resolves var(--color-bg) to an rgb() string), so there is
   * no second copy of any palette here. The static <meta> tags in index.html
   * carry the first-paint fallback; this replaces them with one live tag.
   * @param {Document} doc
   */
  function syncChromeColor(doc) {
    try {
      const view = doc.defaultView;
      if (!view || !doc.body) return;
      const probe = doc.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;background-color:var(--color-bg)";
      doc.body.appendChild(probe);
      const rgb = view.getComputedStyle(probe).backgroundColor;
      probe.remove();
      const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(rgb || "");
      if (!m) return;
      const hex = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      const tags = doc.querySelectorAll('meta[name="theme-color"]');
      tags.forEach((t, i) => { if (i === 0) { t.setAttribute("content", hex); t.removeAttribute("media"); } else t.remove(); });
    } catch (e) { /* cosmetic only */ }
  }

  /** @type {Record<string, any>} */
  const api = {
    KEYS, PALETTES, THEMES, DEFAULTS,
    normalizePalette, normalizeTheme, normalizeTransparency, isPalette,
    read, write, apply, resolveTheme, syncChromeColor,
    reducedTransparency, blurSupported, darkSupported,
  };
  /** @type {any} */ (window).BoxLogTheme = Object.freeze(api);
})();
