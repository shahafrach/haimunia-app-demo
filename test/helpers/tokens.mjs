// Reads the design tokens out of tokens.css and evaluates them, so a test can
// compute real contrast ratios from the values the stylesheet ships instead of
// from a second copy of them. Understands exactly what the token block uses:
// #hex, var(), light-dark(), color-mix(in srgb, ...) and transparent.
import fs from "node:fs";

export const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
export const tokensCss = fs.readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

export const TOKEN_START = "/* tokens:start";
export const TOKEN_END = "/* tokens:end */";

export function tokenBlock(source = tokensCss) {
  const a = source.indexOf(TOKEN_START);
  const b = source.indexOf(TOKEN_END);
  if (a < 0 || b < 0 || b < a) throw new Error("tokens.css has no tokens:start / tokens:end block");
  return source.slice(a, b + TOKEN_END.length);
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** @returns {{at: string|null, selector: string, decls: Record<string,string>}[]} */
export function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  function walk(src, at) {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@")) walk(body, head);
      else {
        const decls = {};
        for (const d of splitTop(body, ";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        rules.push({ at, selector: head, decls });
      }
      i = j;
    }
  }
  walk(text, null);
  return rules;
}

/** Split on a top-level separator (outside parentheses). */
export function splitTop(s, sep) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export const PALETTE_IDS = ["chalk", "slate", "cedar", "sand", "iris"];

/** Custom properties in effect for `palette`: :root / [data-palette] base, then the palette's own rule. */
export function scopeFor(palette, { fallback = false } = {}) {
  const rules = parseRules(tokenBlock());
  const supportsNot = (r) => r.at && /^@supports not/.test(r.at);
  const plain = rules.filter((r) => (!r.at || r.at === null) && !supportsNot(r));
  const fb = rules.filter(supportsNot);
  const scope = {};
  const take = (list, pred) => { for (const r of list) if (pred(r.selector)) Object.assign(scope, r.decls); };
  const isBase = (sel) => sel.split(",").map((s) => s.trim()).some((s) => s === ":root" || s === "[data-palette]");
  const isPal = (sel) => sel.trim() === `[data-palette="${palette}"]`;
  take(plain, isBase); take(plain, isPal);
  if (fallback) { take(fb, isBase); take(fb, isPal); }
  return scope;
}

// ---- Color evaluation ------------------------------------------------------
const hexToRgba = (h) => {
  let x = h.replace("#", "");
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)).concat(1);
};

export function evaluate(expr, scope, mode, depth = 0) {
  if (depth > 40) throw new Error("token cycle near " + expr);
  const e = expr.trim();
  if (/^#[0-9a-fA-F]{3,6}$/.test(e)) return hexToRgba(e);
  if (e === "transparent") return [0, 0, 0, 0];
  let m;
  if ((m = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(e))) {
    if (!(m[1] in scope)) throw new Error(`undefined token ${m[1]}`);
    return evaluate(scope[m[1]], scope, mode, depth + 1);
  }
  if ((m = /^light-dark\(([\s\S]*)\)$/.exec(e))) {
    const [l, d] = splitTop(m[1], ",");
    return evaluate(mode === "dark" ? d : l, scope, mode, depth + 1);
  }
  if ((m = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(e))) {
    const parts = splitTop(m[1], ",").map((p) => p.trim());
    const parse = (p) => {
      const pm = /^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/.exec(p);
      return pm ? { c: pm[1], p: Number(pm[2]) / 100 } : { c: p, p: null };
    };
    let [a, b] = parts.map(parse);
    if (a.p == null && b.p == null) { a.p = 0.5; b.p = 0.5; }
    else if (a.p == null) a.p = 1 - b.p;
    else if (b.p == null) b.p = 1 - a.p;
    const A = evaluate(a.c, scope, mode, depth + 1), B = evaluate(b.c, scope, mode, depth + 1);
    const alpha = A[3] * a.p + B[3] * b.p;
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (i) => (A[i] * A[3] * a.p + B[i] * B[3] * b.p) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  throw new Error("cannot evaluate: " + e);
}

/** Composite fg over an opaque bg. */
export function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
}

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const toHex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Resolve a token to an opaque color in a palette and mode. */
export function colorOf(token, palette, mode, over_ = null) {
  const scope = scopeFor(palette);
  const c = evaluate(`var(${token})`, scope, mode);
  return c[3] < 1 ? over(c, over_ || evaluate("var(--color-bg)", scope, mode)) : c;
}
