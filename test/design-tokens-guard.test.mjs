// The one-source rule: a color literal may appear only inside the token block of
// tokens.css (between "tokens:start" and "tokens:end"), which index.html,
// privacy.html, terms.html and 404.html all link. Everything else says
// var(--color-...). That covers CSS, inline style="" attributes, SVG attributes
// and strings built in JS. Canvas code reads tokens with getComputedStyle.
//
// Allowed outside the block: the two static <meta name="theme-color"> tags (the
// browser needs a value before any CSS exists; src/theme.js replaces them with
// the live token) and manifest.json (JSON, read before the page loads).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { html, tokensCss, TOKEN_START, TOKEN_END, parseRules, tokenBlock, PALETTE_IDS } from "./helpers/tokens.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const NAMED = "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|brown|navy|teal|cyan|magenta|maroon|olive|lime|aqua|fuchsia|coral|crimson|indigo|ivory|khaki|lavender|salmon|tan|violet|beige|bisque|plum|orchid|turquoise|tomato";
const HEX = /(?<![\w&#/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/g;
const NAMED_IN_CSS = new RegExp(`(?:\\b(?:color|background(?:-color)?|border(?:-(?:top|bottom|left|right|inline|block)[a-z-]*)?(?:-color)?|outline(?:-color)?|fill|stroke|stop-color|caret-color|accent-color|text-decoration-color)\\s*[:=]\\s*["']?|\\bsolid\\s+)(?:${NAMED})\\b`, "gi");

function stripComments(text, kind) {
  const blank = (m) => m.replace(/[^\n]/g, "");
  let t = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (kind === "html") t = t.replace(/<!--[\s\S]*?-->/g, blank);
  if (kind === "js") t = t.split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
  return t;
}

function offenders(file) {
  const rel = path.relative(root, file);
  let text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".html") ? "html" : file.endsWith(".css") ? "css" : "js";
  if (rel === "tokens.css") {
    const a = text.indexOf(TOKEN_START), b = text.indexOf(TOKEN_END) + TOKEN_END.length;
    text = text.slice(0, a) + "\n".repeat(text.slice(a, b).split("\n").length - 1) + text.slice(b);
  }
  if (kind === "html") {
    text = text.split("\n").map((l) => (/<meta name="theme-color"/.test(l) ? "" : l)).join("\n");
  }
  const lines = stripComments(text, kind).split("\n");
  const found = [];
  lines.forEach((line, i) => {
    for (const re of [HEX, FUNC, NAMED_IN_CSS]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) found.push(`${rel}:${i + 1}: ${m[0]}`);
    }
  });
  return found;
}

const FILES = [
  path.join(root, "index.html"),
  path.join(root, "tokens.css"),
  path.join(root, "privacy.html"),
  path.join(root, "terms.html"),
  path.join(root, "404.html"),
  path.join(root, "app.js"),
  path.join(root, "cloud.js"),
  path.join(root, "theme-init.js"),
  path.join(root, "sw.js"),
  path.join(root, "frame-guard.js"),
  ...walk(path.join(root, "src")).filter((f) => f.endsWith(".js")),
];

test("no color literal outside the token block", () => {
  const all = FILES.flatMap(offenders);
  assert.deepEqual(all, [], `${all.length} color literal(s) outside the token layer:\n${all.slice(0, 40).join("\n")}`);
});

test("the token block itself is the single place literals live, and it is not empty", () => {
  const block = tokenBlock();
  assert.ok((block.match(HEX) || []).length > 100, "expected the palettes' hex values inside the token block");
  assert.equal(tokensCss.split(TOKEN_START).length, 2, "exactly one token block");
  assert.ok(html.includes('<link rel="stylesheet" href="./tokens.css" />'), "index.html links tokens.css");
  assert.ok(!html.includes(TOKEN_START), "no second token block inline");
});

test("the old per-theme color blocks are gone", () => {
  const css = html.slice(html.indexOf('<style id="app-css">'));
  assert.ok(!/prefers-color-scheme\s*:\s*dark/.test(css), "no @media (prefers-color-scheme: dark) outside the token layer");
  assert.ok(!/:root\[data-theme="dark"\]/.test(css), "no :root[data-theme=dark] color block outside the token layer");
  assert.ok(!/prefers-color-scheme\s*:\s*dark/.test(tokensCss), "tokens.css has no OS-dark media block either: light-dark() does it");
});

test("every var(--name) used anywhere resolves to a token or a locally declared property", () => {
  const defined = new Set();
  const decl = /(--[\w-]+)\s*:/g;
  const corpus = FILES.map((f) => fs.readFileSync(f, "utf8"));
  for (const text of corpus) { let m; while ((m = decl.exec(text))) defined.add(m[1]); }
  const missing = new Set();
  for (const text of corpus) {
    // a var() with a fallback is optional by design, so only the bare form must resolve
    const use = /var\(\s*(--[\w-]+)\s*\)/g; let m;
    while ((m = use.exec(text))) if (!defined.has(m[1])) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [], "var() references with no definition");
});

test("every palette overrides all eleven slots", () => {
  const rules = parseRules(tokenBlock());
  const base = rules.find((r) => r.selector === ":root, [data-palette]" && "--pal-bg" in r.decls);
  assert.ok(base, "base palette slots");
  const slots = Object.keys(base.decls);
  assert.equal(slots.length, 11);
  for (const id of PALETTE_IDS) {
    const r = rules.find((x) => !x.at && x.selector === `[data-palette="${id}"]`);
    assert.ok(r, id);
    assert.deepEqual(Object.keys(r.decls).sort(), slots.slice().sort(), `${id} must set every slot`);
    for (const v of Object.values(r.decls)) assert.match(v, /^light-dark\(#[0-9A-Fa-f]{6}, #[0-9A-Fa-f]{6}\)$/, `${id}: slots are written once as light-dark(light, dark)`);
  }
});
