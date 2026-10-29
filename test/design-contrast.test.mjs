// WCAG 2.2 AA for every palette in both modes, computed from the token values
// index.html ships (test/helpers/tokens.mjs evaluates the <style id="tokens">
// block: var(), light-dark(), color-mix()). Thresholds: 4.5:1 for text (1.4.3),
// 3:1 for UI parts and graphics (1.4.11).
//
// How the PR color is judged: in four of the five palettes accent and PR have
// nearly equal lightness, so a PR is never color alone. The PR badge always
// carries a shape and a label, and its edge is --color-pr, which is why the
// edge is held to 3:1 against the page and the fill only to its own label.
import { test } from "node:test";
import assert from "node:assert";
import { PALETTE_IDS, scopeFor, evaluate, over, contrast, toHex, splitTop, parseRules, tokenBlock } from "./helpers/tokens.mjs";

const MODES = ["light", "dark"];
const TEXT = 4.5, UI = 3;

function resolver(palette, mode) {
  const scope = scopeFor(palette);
  const solid = (expr, backdrop) => {
    const c = evaluate(expr, scope, mode);
    return c[3] < 1 ? over(c, backdrop || evaluate("var(--color-bg)", scope, mode)) : c;
  };
  return { scope, solid, tok: (name, backdrop) => solid(`var(${name})`, backdrop) };
}

const SURFACES = ["--color-bg", "--color-surface", "--color-surface-raised", "--color-surface-sunken"];
const TEXTS = ["--color-text", "--color-text-muted", "--color-accent", "--color-pr", "--color-progress", "--color-danger", "--color-success", "--color-warning", "--color-info", "--color-violet"];

test("the token block defines five palettes", () => {
  const rules = parseRules(tokenBlock());
  for (const id of PALETTE_IDS) assert.ok(rules.some((r) => r.selector === `[data-palette="${id}"]`), `missing [data-palette="${id}"]`);
});

for (const palette of PALETTE_IDS) {
  for (const mode of MODES) {
    test(`${palette} ${mode}: text colors reach 4.5:1 on every surface`, () => {
      const { tok } = resolver(palette, mode);
      const failures = [];
      for (const fg of TEXTS) for (const bg of SURFACES) {
        const bgc = tok(bg);
        const r = contrast(tok(fg, bgc), bgc);
        if (r < TEXT) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      assert.deepEqual(failures, []);
    });

    test(`${palette} ${mode}: text on washes and glass reaches 4.5:1`, () => {
      const { scope, solid, tok } = resolver(palette, mode);
      const failures = [];
      const washes = {
        "accent-soft": tok("--color-accent-soft"),
        "pr-soft": tok("--color-pr-soft"),
        "glass card over bg": solid("var(--color-glass-card)", tok("--color-bg")),
        "glass bar over bg": solid("var(--color-glass-bar)", tok("--color-bg")),
        "glass card over accent wash": solid("var(--color-glass-card)", solid("color-mix(in srgb, var(--pal-accent-fill) 8%, var(--pal-bg))")),
        "glass sheet over accent wash": solid("var(--color-glass-sheet)", solid("color-mix(in srgb, var(--pal-accent-fill) 8%, var(--pal-bg))")),
      };
      for (const [name, bgc] of Object.entries(washes)) {
        for (const fg of ["--color-text", "--color-text-muted", "--color-accent", "--color-pr"]) {
          // a wash is an accent tint of the surface, so only its own ink is judged against it
          if (name === "pr-soft" && fg === "--color-accent") continue;
          if (name === "accent-soft" && fg === "--color-pr") continue;
          const r = contrast(tok(fg, bgc), bgc);
          if (r < TEXT) failures.push(`${fg} on ${name}: ${r.toFixed(2)}`);
        }
      }
      void scope;
      assert.deepEqual(failures, []);
    });

    test(`${palette} ${mode}: type over the scene and the celebration card reads`, () => {
      const { solid, tok } = resolver(palette, mode);
      const white = tok("--color-on-scene");
      const failures = [];
      // The title sits on the scene art at its worst: the deep tone with the accent glow mixed in.
      const worst = solid("color-mix(in srgb, var(--color-scene) 75%, var(--pal-accent-fill))");
      for (const [name, bg] of [["scene", tok("--color-scene")], ["scene with glow", worst]]) {
        const r = contrast(white, bg);
        if (r < 7) failures.push(`on-scene on ${name}: ${r.toFixed(2)}`);
      }
      // The PR card is a bright wash of the PR color: all its type is the page text color.
      const celebrate = tok("--color-celebrate");
      const celebrate2 = solid("color-mix(in srgb, var(--pal-accent-fill) 26%, var(--pal-surface))");
      for (const [name, bg] of [["celebrate", celebrate], ["celebrate end", celebrate2]]) {
        const r = contrast(tok("--color-text", bg), bg);
        if (r < TEXT) failures.push(`--color-text on ${name}: ${r.toFixed(2)}`);
      }
      assert.deepEqual(failures, []);
    });

    test(`${palette} ${mode}: tab labels read on the bar`, () => {
      const { solid, tok } = resolver(palette, mode);
      const bar = tok("--bar-bg");
      for (const fg of ["--tab-inactive", "--tab-active"]) {
        const r = contrast(solid(`var(${fg})`, bar), bar);
        assert.ok(r >= TEXT, `${fg} on the bar: ${r.toFixed(2)}`);
      }
    });

    test(`${palette} ${mode}: filled controls carry readable labels`, () => {
      const { tok } = resolver(palette, mode);
      const pairs = [
        ["--color-on-accent", "--color-accent-fill"],
        ["--color-on-pr", "--color-pr-fill"],
        ["--color-on-danger", "--color-danger"],
      ];
      for (const [fg, bg] of pairs) {
        const r = contrast(tok(fg), tok(bg));
        assert.ok(r >= TEXT, `${fg} on ${bg}: ${r.toFixed(2)} < ${TEXT}`);
      }
    });

    test(`${palette} ${mode}: UI parts reach 3:1 against the page and the card`, () => {
      const { tok } = resolver(palette, mode);
      const parts = ["--color-border-strong", "--color-accent-fill", "--color-progress", "--color-pr", "--color-focus", "--chart-neutral", "--chart-line", "--chart-pr"];
      const failures = [];
      for (const p of parts) for (const bg of ["--color-bg", "--color-surface"]) {
        const bgc = tok(bg);
        const r = contrast(tok(p, bgc), bgc);
        if (r < UI) failures.push(`${p} on ${bg}: ${r.toFixed(2)}`);
      }
      assert.deepEqual(failures, []);
    });

    test(`${palette} ${mode}: the focus ring is visible on the accent button`, () => {
      const { tok } = resolver(palette, mode);
      // The ring sits 2px outside the control, so it is judged against the page,
      // and the control edge against the ring only when they touch (outline-offset).
      assert.ok(contrast(tok("--color-focus"), tok("--color-bg")) >= UI);
    });
  }
}

test("every light-dark() token has its light half in the no-light-dark() fallback", () => {
  const rules = parseRules(tokenBlock());
  const main = rules.filter((r) => !r.at);
  const fb = rules.filter((r) => r.at && /^@supports not/.test(r.at));
  assert.ok(fb.length >= 6, "fallback block missing");
  const lightHalf = (v) => {
    const m = /^light-dark\(([\s\S]*)\)$/.exec(v.trim());
    return m ? splitTop(m[1], ",")[0].trim() : null;
  };
  let checked = 0;
  for (const r of main) {
    for (const [k, v] of Object.entries(r.decls)) {
      if (!v.includes("light-dark(")) continue;
      // A property whose value merely contains light-dark() inside color-mix() is
      // covered by naming it in the fallback with the same light-resolved value.
      const sel = r.selector;
      const counterpart = fb.filter((f) => f.selector === sel || (sel.split(",").map((s) => s.trim()).includes(":root") && f.selector.split(",").map((s) => s.trim()).includes(":root")));
      const hit = counterpart.find((f) => k in f.decls);
      assert.ok(hit, `${sel} { ${k} } uses light-dark() but the fallback block does not set it`);
      const light = lightHalf(v);
      if (light && !/^color-mix/.test(light)) assert.equal(hit.decls[k].toUpperCase(), light.toUpperCase(), `${sel} ${k}: fallback differs from the light half`);
      checked++;
    }
  }
  assert.ok(checked > 60, `only ${checked} light-dark tokens checked`);
});

test("the fallback block evaluates to the same colors as the light theme", () => {
  for (const palette of PALETTE_IDS) {
    const normal = scopeFor(palette);
    const fb = scopeFor(palette, { fallback: true });
    for (const token of ["--color-bg", "--color-surface", "--color-text", "--color-text-muted", "--color-accent", "--color-accent-fill", "--color-pr", "--color-danger", "--color-success", "--color-surface-raised"]) {
      const a = toHex(evaluate(`var(${token})`, normal, "light"));
      const b = toHex(evaluate(`var(${token})`, fb, "light"));
      assert.equal(b, a, `${palette} ${token}: fallback ${b} vs light ${a}`);
    }
  }
});
