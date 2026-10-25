// bidiText/bidiHtml: the run-level half of the RTL bidi defect.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The bidi algorithm never touches the
// DOM, so no unit test can see a reordering bug: the text node still reads
// "3×5 @ 60" in logical order after the engine has decided to paint it as
// "60 @ 5×3". Painted order is asserted where it is visible, in Chromium, by
// scripts/browser-check/bidi-rtl-geometry.mjs.
//
// What IS unit-testable, and is what this file locks down, is the thing the
// geometry check has to take on faith: the STRUCTURE the helper emits. Where
// the run boundaries fall, which lines are left alone, that no isolate ever
// straddles a tag, and - the one that has nothing to do with bidi at all -
// that every character of untrusted input still leaves through esc().
// MARKUP NOTE (2026-09-15): the emitted wrapper gained lang="en" alongside
// dir="ltr". The document is lang="he" and was the app's ONLY lang attribute,
// so a screen reader spoke every Latin run - movement names, Rx, WOD, AMRAP,
// benchmark names - through the Hebrew voice. This wrapper already locates
// those runs, so tagging them costs nothing. Every assertion below is
// otherwise unchanged: the run BOUNDARIES, the escaping guarantees and the
// interior-neutral rule are exactly what they were, and those are the
// properties this file exists to defend.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";
import { COMMUNITY_MODULES, communityFile } from "./helpers/community-src.mjs";

const helpersSrc = fs.readFileSync(new URL("../src/shared/safe-helpers.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cloudSrc = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const g = {};
new Function("window", helpersSrc)(g);
const { bidiText, bidiHtml, bidiUnit, bidiUnitHtml, esc } = g.BoxLogSafe;

// Undo esc() and drop the isolation markup, to compare against what was typed.
const unesc = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripped = (html) => unesc(html.replace(/<\/?bdi(?: [^>]*)?>/g, ""));

// ---------------------------------------------------------------------------
// The promotion. This is the half that keeps the rest of the file honest: the
// assertions below describe src/shared/safe-helpers.js, and they only describe
// the app if the app is actually calling it.
// ---------------------------------------------------------------------------

test("there is exactly one definition: app.js and cloud.js bind the helper, they do not re-declare it", () => {
  // The drift failure mode is silent. One copy quietly stops isolating and
  // nobody sees a broken string — only a plausible, valid-looking, different
  // workout. A source-level assertion is the only thing that catches a fourth
  // copy being pasted back in later.
  // Every community file, not cloud.js alone: a fourth copy of bidiText is
  // exactly the kind of thing that gets pasted into a new module.
  for (const [name, src] of [["app.js", appSrc], ["cloud.js", cloudSrc], ...COMMUNITY_MODULES.map((f) => [f, communityFile(f)])]) {
    assert.doesNotMatch(src, /^\s*function bidiText\s*\(/m, `${name} must not re-declare bidiText`);
    assert.doesNotMatch(src, /^\s*function bidiHtml\s*\(/m, `${name} must not re-declare bidiHtml`);
  }
  // `var`, not `const`, in both: cloud.js stopped being an IIFE so that
  // src/community/*.js can share its scope, which put its bidiText and
  // app.js's in the same global lexical environment. Two `const`s there are a
  // redeclaration SyntaxError; two `var`s binding the identical
  // window.BoxLogSafe function are not. What this test is actually about -
  // that neither file re-implements it - is unchanged, and the
  // doesNotMatch pair above is what enforces it.
  assert.match(appSrc, /var bidiText = SAFE\.bidiText;/);
  assert.match(cloudSrc, /var bidiText = window\.BoxLogSafe\.bidiText;/);
  assert.match(cloudSrc, /const bidiHtml = window\.BoxLogSafe\.bidiHtml;/);
});

test("the booted app really has the shared module under it, behaving as asserted above", async () => {
  const window = await bootApp();
  const S = window.BoxLogSafe;
  assert.equal(typeof S.bidiText, "function", "the booted app must expose the promoted helper");
  assert.equal(typeof S.bidiHtml, "function");
  // Same behaviour inside the booted app as in the standalone module — this is
  // what app.js's `const bidiText = SAFE.bidiText` resolves to at runtime.
  assert.equal(S.bidiText("עשיתי 3×5 @ 60 היום"), '<bdi>עשיתי <bdi dir="ltr" lang="en">3×5 @ 60</bdi> היום</bdi>');
  //
  // WHY THE BINDING ITSELF IS ASSERTED AT THE SOURCE LEVEL ABOVE AND NOT HERE.
  // The obvious check — window.eval("bidiText") === S.bidiText, the way
  // test/shared-safe-helpers.test.mjs probes esc/bag/cleanId — cannot work for
  // a `const`, and the reason is a jsdom artifact rather than anything about
  // the app. boot.mjs evaluates the concatenated sources with window.eval();
  // in eval code, function DECLARATIONS land in the global var environment and
  // stay reachable, while top-level `let`/`const` go into a declarative
  // environment that is discarded when the eval returns. So `allWodMovementTags`
  // probes fine and `barWeight`, `LIMITS`, `SAFE` and `bidiText` all raise
  // ReferenceError — none of which is true of the real page, where classic
  // <script> tags share one global lexical environment. app.js's own functions
  // close over that scope either way, which is why every other test in the
  // suite exercises bidiText through the app perfectly happily.
  //
  // The runtime binding is therefore proven where it is actually observable:
  // scripts/browser-check/bidi-rtl-geometry.mjs drives the WOD-history search
  // in real Chromium and asserts the rendered node contains the shared
  // helper's own isolate. That check fails if app.js goes back to a local copy.
});

// ---------------------------------------------------------------------------
// bidiUnit / bidiUnitHtml: the CONTAINER-level half.
//
// What these can and cannot prove is the same split as the file header
// describes for bidiText: the painted order lives in Chromium
// (scripts/browser-check/bidi-measurement-order.mjs measures it, with a
// control that has to fail). What is unit-testable, and is what this section
// locks down, is the STRUCTURE - that the base direction is STATED and not
// inferred, that the run rule inside it is the same one bidiText uses, and
// that nothing about escaping changed.
// ---------------------------------------------------------------------------

test("bidiUnit states an RTL base instead of inferring one - this is the whole difference", () => {
  // The line that made the difference necessary. Its first strong character
  // is the Latin R of "1RM", so first-strong detection (what <bdi> and
  // bidiText do) resolves it LTR and paints "משוער 90 ק״ג 1RM" - the exact
  // string reported from a phone.
  assert.equal(bidiText("1RM משוער 90 ק״ג"), '<bdi>1RM משוער 90 ק״ג</bdi>', "bidiText leaves an LTR-first line to dir=auto, unchanged");
  assert.equal(bidiUnit("1RM משוער 90 ק״ג"), '<bdi dir="rtl">1RM משוער 90 ק״ג</bdi>');
  // And the ordinary case: an RTL-first measurement gets the same stated base
  // rather than a happens-to-agree inferred one.
  assert.equal(bidiUnit("90 ק״ג × 1"), '<bdi dir="rtl">90 ק״ג × 1</bdi>');
});

test("bidiUnit applies the SAME run rule bidiText does, with no first-strong gate", () => {
  // Interior neutrals still split a Latin/numeric run against an RTL base,
  // so the run isolation is still required - a stated base does not make it
  // unnecessary, it only makes the gate unnecessary.
  assert.equal(bidiUnit("הרמתי 3×5 @ 60"), '<bdi dir="rtl">הרמתי <bdi dir="ltr" lang="en">3×5 @ 60</bdi></bdi>');
  // The gate bidiText needs is gone: an LTR-FIRST line gets its runs
  // isolated here, which is safe precisely because the base was stated.
  assert.equal(bidiUnit("43/30 ק״ג"), '<bdi dir="rtl"><bdi dir="ltr" lang="en">43/30</bdi> ק״ג</bdi>');
  // A run with no interior neutral is still left alone - and this one is
  // load-bearing rather than an optimisation. Measured in Chromium: forcing
  // "+12" LTR inside the RTL base paints "12+ ק״ג", while leaving it alone
  // paints "+12 ק״ג".
  assert.equal(bidiUnit("+12 ק״ג"), '<bdi dir="rtl">+12 ק״ג</bdi>');
  assert.equal(bidiUnit("90 ק״ג"), '<bdi dir="rtl">90 ק״ג</bdi>');
});

test("bidiUnit escapes every character of untrusted input, exactly like its siblings", () => {
  const hostile = [
    '<img src=x onerror="alert(1)">',
    "בדיקה <script>alert(1)</script> סוף",
    `אמר 'שלום' & "להתראות" <b>3×5 @ 60</b>`,
    "&lt;already escaped&gt;",
  ];
  for (const raw of hostile) {
    const out = bidiUnit(raw);
    assert.doesNotMatch(
      out.replace(/<\/?bdi(?: [^>]*)?>/g, ""),
      /[<>]/,
      `bidiUnit must not leave a raw angle bracket in the output for ${JSON.stringify(raw)}`,
    );
    assert.equal(stripped(out), raw, "the isolation must not add, drop or reorder a character");
  }
  // And boundaries are still found BEFORE escaping, so `ק"ג` never has the
  // Latin word inside its own entity isolated.
  const q = bidiUnit('הרמתי 100 ק"ג');
  assert.match(q, /ק&quot;ג/);
  assert.doesNotMatch(q, /<bdi dir="ltr" lang="en">[^<]*quot/);
});

test("bidiUnit is total: null/undefined/empty are an empty stated-RTL isolate", () => {
  assert.equal(bidiUnit(null), '<bdi dir="rtl"></bdi>');
  assert.equal(bidiUnit(undefined), '<bdi dir="rtl"></bdi>');
  assert.equal(bidiUnit(""), '<bdi dir="rtl"></bdi>');
  assert.equal(bidiUnit(42), '<bdi dir="rtl">42</bdi>');
});

test("bidiUnitHtml wraps already-escaped HTML without straddling a tag", () => {
  const input = '22.09: <span style="color:var(--chalk);">90 ק&quot;ג</span>';
  const out = bidiUnitHtml(input);
  assert.match(out, /^<bdi dir="rtl">/);
  assert.match(out, /<\/bdi>$/);
  // Lossless over the markup it was handed: only isolates are added.
  assert.equal(out.replace(/<bdi(?: [^>]*)?>/g, "").replace(/<\/bdi>/g, ""), input);
  for (const run of out.match(/<bdi dir="ltr" lang="en">[\s\S]*?<\/bdi>/g) || []) {
    assert.doesNotMatch(run.slice('<bdi dir="ltr" lang="en">'.length, -"</bdi>".length), /[<>]/, "no isolate may contain markup");
  }
});

test("app.js and cloud.js bind bidiUnit, they do not re-declare it", () => {
  // The same drift guard the pair above already has, for the pair below it.
  // A fourth copy of the run finder is the failure mode; a local
  // re-implementation of the wrapper is how one gets in.
  for (const [name, src] of [["app.js", appSrc], ["cloud.js", cloudSrc], ...COMMUNITY_MODULES.map((f) => [f, communityFile(f)])]) {
    assert.doesNotMatch(src, /^\s*function bidiUnit\s*\(/m, `${name} must not re-declare bidiUnit`);
    assert.doesNotMatch(src, /^\s*function bidiUnitHtml\s*\(/m, `${name} must not re-declare bidiUnitHtml`);
  }
  // `var` on BOTH sides, not `const`. app.js and cloud.js are classic scripts
  // sharing one global lexical environment: `var` + `var` binding the same
  // frozen function is legal, and a `const` on either side is a redeclaration
  // SyntaxError that takes the whole app down at parse time.
  // One statement each, not a comma list: test/community-module-split.test.mjs
  // reads top-level declarations a line at a time and would only see the
  // first name of `var a = …, b = …`, silently exempting the second from the
  // cross-file redeclaration check these two most need.
  assert.match(appSrc, /^var bidiUnit = SAFE\.bidiUnit;$/m);
  assert.match(appSrc, /^var bidiUnitHtml = SAFE\.bidiUnitHtml;$/m);
  assert.match(cloudSrc, /var bidiUnit = window\.BoxLogSafe\.bidiUnit;/);
  assert.match(cloudSrc, /var bidiUnitHtml = window\.BoxLogSafe\.bidiUnitHtml;/);
});

// THE RULE, ENFORCED OVER REAL RENDERED SCREENS RATHER THAN OVER SOURCE TEXT.
//
// index.html's `.mono` declares `direction:ltr`. That is correct for a bare
// number and wrong for a number standing next to a Hebrew word, and the
// difference is invisible in every artefact a unit test normally looks at -
// the markup is right either way, and jsdom has no bidi algorithm to run.
//
// So the assertion is structural and it is checked where the strings actually
// land: boot the app, put real data through it, render the screens, and walk
// every `.mono` element on them. Any that contains a Hebrew letter must carry
// a STATED base direction (bidiUnit's `<bdi dir="rtl">`), because the `.mono`
// box it sits in has already stated the wrong one.
//
// A source-level scan was the obvious alternative and is strictly weaker: it
// can only see the call sites someone thought to write, while this sees what
// a screen actually produced, including through helpers three calls deep
// (formatWodEntry, formatLiftedSet, volumeCountsLabel, entrySummary).
const HEBREW = /[\u0590-\u05FF]/;
function unisolatedMonoNodes(window) {
  const bad = [];
  for (const el of window.document.querySelectorAll(".mono")) {
    const text = (el.textContent || "").trim();
    if (!text || !HEBREW.test(text)) continue;
    // The isolate may be the element's own child or wrap a part of it; what
    // matters is that a stated-RTL base exists between the `.mono` box and
    // the Hebrew, for every Hebrew-bearing text node under it.
    const stated = el.querySelector('bdi[dir="rtl"]');
    if (!stated || !HEBREW.test(stated.textContent || "")) bad.push(text.slice(0, 48));
  }
  return bad;
}

test("no rendered .mono readout puts a Hebrew unit in an LTR box without stating its base", async () => {
  const window = await bootApp();
  const doc = window.document;

  await window.addMovement("Bidi Squat", "Squat");
  window.applyFieldValue("step", "weight", 90);
  window.applyFieldValue("step", "reps", 1);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();

  const offenders = {};
  // The progress tab, with a record row expanded: the headline, the estimate
  // line under it, the trend chip and the recent-sets strip.
  doc.getElementById("tabHistoryBtn").click();
  const row = doc.querySelector("#historyListArea [data-action='select-history']");
  if (row) row.click();
  offenders.progress = unisolatedMonoNodes(window);

  // The calendar tab: the day detail and the category volume card.
  doc.getElementById("tabCalendarBtn").click();
  offenders.calendar = unisolatedMonoNodes(window);

  // The workouts library, all three sub-tabs.
  doc.getElementById("tabWodBtn").click();
  offenders.wodLog = unisolatedMonoNodes(window);
  const benchTab = doc.querySelector("button.subtabbtn[data-subtab='benchmarks']");
  if (benchTab) { benchTab.click(); offenders.wodBenchmarks = unisolatedMonoNodes(window); }
  const histTab = doc.querySelector("button.subtabbtn[data-subtab='history']");
  if (histTab) { histTab.click(); offenders.wodHistory = unisolatedMonoNodes(window); }

  // The medals overlay.
  window.openAchievements();
  offenders.medals = unisolatedMonoNodes(window);

  const all = Object.entries(offenders).filter(([, v]) => v.length);
  assert.deepEqual(
    all,
    [],
    "a .mono readout carries Hebrew with no stated base direction — it will paint in the wrong order:\n  "
      + all.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n  "),
  );
});

test("the audit above is not vacuously green: it really does catch an un-isolated readout", async () => {
  // The same shape the app used to emit, injected into a real rendered page.
  // Without this, "no .mono element is missing its isolate" would pass just
  // as happily on a page that has no .mono elements at all.
  const window = await bootApp();
  const probe = window.document.createElement("span");
  probe.className = "mono";
  probe.textContent = "90 ק״ג × 1";
  window.document.getElementById("content").appendChild(probe);
  assert.deepEqual(unisolatedMonoNodes(window), ["90 ק״ג × 1"]);
  // And the fixed form passes.
  probe.innerHTML = window.BoxLogSafe.bidiUnit("90 ק״ג × 1");
  assert.deepEqual(unisolatedMonoNodes(window), []);
});

test("VERSION was bumped for the added helpers, as the module's contract requires", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../src/shared/package.json", import.meta.url), "utf8"));
  const declared = helpersSrc.match(/const VERSION = "([^"]+)";/)[1];
  assert.equal(pkg.version, declared, "package.json must track the VERSION constant");
  // Adding a helper is a MINOR bump under src/shared/README.md's protocol:
  // additive, so a consumer repo still on the previous version does not go
  // out of contract by staying there.
  const [major, minor] = declared.split(".").map(Number);
  assert.ok(major === 1 && minor >= 1, `expected at least 1.1.x for the added bidi helpers, got ${declared}`);
});

// ---------------------------------------------------------------------------
// The property that outranks every bidi property here.
// ---------------------------------------------------------------------------

test("escaping is untouched: every character of untrusted input still leaves through esc()", () => {
  const hostile = [
    '<img src=x onerror="alert(1)">',
    "בדיקה <script>alert(1)</script> סוף",
    `אמר 'שלום' & "להתראות" <b>3×5 @ 60</b>`,
    "&lt;already escaped&gt;",
    "'\"&<>",
  ];
  for (const raw of hostile) {
    const out = bidiText(raw);
    // No markup survives except the isolation this helper itself adds.
    assert.doesNotMatch(
      out.replace(/<\/?bdi(?: [^>]*)?>/g, ""),
      /[<>]/,
      `bidiText must not leave a raw angle bracket in the output for ${JSON.stringify(raw)}`,
    );
    // And it is lossless: the exact input comes back out.
    assert.equal(stripped(out), raw, "the isolation must not add, drop or reorder a character");
  }
});

test("run boundaries are computed BEFORE escaping, so an escape is never mistaken for a word", () => {
  // Post-escape, `ק"ג` reads as `ק&quot;ג` and a character-by-character run
  // finder sees the Latin word `quot` sitting inside a Hebrew word. If the
  // boundaries were found on the escaped string this would isolate it.
  const out = bidiText('הרמתי 100 ק"ג');
  assert.match(out, /ק&quot;ג/, "the quote must still be escaped");
  assert.doesNotMatch(out, /<bdi dir="ltr" lang="en">[^<]*quot/, "an HTML entity must never be isolated as if it were prose");
});

// ---------------------------------------------------------------------------
// The run rule.
// ---------------------------------------------------------------------------

test("a neutral BETWEEN two anchors is interior - this is the whole defect", () => {
  // `×` and `@` resolve to the paragraph's RTL direction (UBA N1 has European
  // numbers act as R for adjacent neutrals), splitting one logical run into
  // three number runs laid out right to left: `60 @ 5×3`.
  assert.equal(bidiText("עשיתי 3×5 @ 60 היום"), '<bdi>עשיתי <bdi dir="ltr" lang="en">3×5 @ 60</bdi> היום</bdi>');
});

test("a neutral between Hebrew and an anchor stays OUTSIDE the run", () => {
  // The parentheses belong to the Hebrew paragraph. The bidi algorithm's own
  // bracket-pair rule (N0) plus mirroring (L4) already paint them correctly -
  // measured, see the geometry check. Swallowing them would be over-isolation.
  assert.equal(bidiText("עם תווית בלוק (A/B/C/D)"), '<bdi>עם תווית בלוק (<bdi dir="ltr" lang="en">A/B/C/D</bdi>)</bdi>');
});

test("a sentence-final '.' is after the last anchor, so it stays outside too", () => {
  assert.equal(
    bidiText("נשבר לי ב-3×5 @ 60. המשך מחר"),
    '<bdi>נשבר לי ב-<bdi dir="ltr" lang="en">3×5 @ 60</bdi>. המשך מחר</bdi>',
  );
});

test("the run neither swallows the Hebrew word before it nor the one after it", () => {
  const out = bidiText("עשיתי 3×5 @ 60 היום");
  const run = out.match(/<bdi dir="ltr" lang="en">([^<]*)<\/bdi>/)[1];
  assert.equal(run, "3×5 @ 60");
  assert.doesNotMatch(run, /[֐-ࣿ]/, "a run must contain no RTL character at all - that is what makes forcing it LTR safe");
});

test("a stretch of CONTIGUOUS anchors is left alone: it cannot reorder against itself", () => {
  // Over an odd (RTL) embedding level UBA I2 raises both L and EN by one, so
  // `100` is a single directional run. Isolating it would be markup for
  // nothing.
  assert.equal(bidiText("הרמתי 100 קילו"), "<bdi>הרמתי 100 קילו</bdi>");
  assert.equal(bidiText("עשיתי Thrusters היום"), "<bdi>עשיתי Thrusters היום</bdi>");
  // Two single-anchor runs separated by Hebrew: each already sits where it
  // was typed, so neither is isolated.
  assert.equal(bidiText("בלוק A ואז בלוק B"), "<bdi>בלוק A ואז בלוק B</bdi>");
});

test("every maximal run in a line is isolated, not just the first", () => {
  const out = bidiText("בשעה 7:30 - 8:30 ואז 3×5 @ 60");
  assert.equal(out, '<bdi>בשעה <bdi dir="ltr" lang="en">7:30 - 8:30</bdi> ואז <bdi dir="ltr" lang="en">3×5 @ 60</bdi></bdi>');
});

// ---------------------------------------------------------------------------
// The gate. Over-isolating is the OTHER bug, and this is what stops it.
// ---------------------------------------------------------------------------

test("an LTR-first line is NOT run-isolated - isolating it re-creates the bug that was already fixed", () => {
  // <bdi> is dir="auto" and HTML's first-strong scan SKIPS characters inside
  // an isolate. Isolating the leading `21-15-9 Thrusters...` run would hide
  // it from that scan, hand the line's base direction to the `ק"ג` further
  // along, and paint `.ג"ק 21-15-9 Thrusters + Pull-ups. Rx 43/30` - the
  // exact pre-fix symptom, with the unit stranded from its number.
  const reported = '21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.';
  assert.equal(bidiText(reported), `<bdi>${esc(reported)}</bdi>`, "an LTR-first line keeps the shipped line-level treatment, unchanged");
  assert.doesNotMatch(bidiText(reported), /dir="ltr"/);
});

test("an all-Hebrew line is untouched, and a line with no strong character is left to <bdi>", () => {
  assert.equal(bidiText("היה קשה אבל סיימתי"), "<bdi>היה קשה אבל סיימתי</bdi>");
  // No strong character anywhere: <bdi>'s own dir="auto" already resolves
  // this LTR, which is right. Nothing to add.
  assert.equal(bidiText("3×5 @ 60"), "<bdi>3×5 @ 60</bdi>");
});

test("the first strong character of a processed line is never moved inside an isolate", () => {
  // The invariant that makes the gate a proof rather than a precaution: if a
  // line's first strong character is RTL then no strong LTR character
  // precedes it, so hiding LTR characters inside isolates cannot move it.
  const lines = ["עשיתי 3×5 @ 60 היום", "עם תווית בלוק (A/B/C/D)", "בשעה 7:30 - 8:30 בבוקר", 'הרמתי 43/30 ק"ג בסוף'];
  for (const line of lines) {
    const out = bidiText(line);
    // Everything before the first isolate must still contain the Hebrew that
    // the engine will resolve the line's direction from.
    const beforeIsolate = out.split('<bdi dir="ltr" lang="en">')[0];
    assert.match(beforeIsolate, /[֐-׿]/, `the line's own first strong character must stay outside every isolate: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Line handling, preserved from the shipped fix.
// ---------------------------------------------------------------------------

test("isolation is per LINE, and rejoining reproduces the original text exactly", () => {
  const out = bidiText("שורה ראשונה\n21-15-9 Thrusters\nעשיתי 3×5 @ 60");
  assert.equal(out.split("\n").length, 3, "a pre-wrap surface must still break exactly where it did");
  assert.equal(stripped(out), "שורה ראשונה\n21-15-9 Thrusters\nעשיתי 3×5 @ 60");
  // Each line resolves from its OWN first strong character: line 2 is LTR and
  // left alone, line 3 is RTL and gets its run isolated.
  const [a, b, c] = out.split("\n");
  assert.equal(a, "<bdi>שורה ראשונה</bdi>");
  assert.equal(b, "<bdi>21-15-9 Thrusters</bdi>");
  assert.equal(c, '<bdi>עשיתי <bdi dir="ltr" lang="en">3×5 @ 60</bdi></bdi>');
});

test("null/undefined are the empty string, as before", () => {
  assert.equal(bidiText(null), "<bdi></bdi>");
  assert.equal(bidiText(undefined), "<bdi></bdi>");
  assert.equal(bidiHtml(null), "<bdi></bdi>");
});

// ---------------------------------------------------------------------------
// bidiHtml: the already-escaped variant.
// ---------------------------------------------------------------------------

test("bidiHtml isolates runs without ever straddling a tag", () => {
  const input = 'תודה <button class="mention" data-id="x">@noam</button> על 3×5 @ 60';
  const out = bidiHtml(input);
  assert.equal(out, '<bdi>תודה <button class="mention" data-id="x">@noam</button> על <bdi dir="ltr" lang="en">3×5 @ 60</bdi></bdi>');
  // Well-formed by construction: a tag BREAKS a run, so an isolate can never
  // contain half of one. Assert it directly rather than trusting the sample.
  for (const run of out.match(/<bdi dir="ltr" lang="en">[\s\S]*?<\/bdi>/g) || []) {
    assert.doesNotMatch(run.slice('<bdi dir="ltr" lang="en">'.length, -"</bdi>".length), /[<>]/, "no isolate may contain markup");
  }
});

test("bidiHtml treats an entity as one neutral character, not as the Latin word inside it", () => {
  // esc() turns `"` into `&quot;`. Character by character that reads as the
  // word `quot`, and unhandled it would isolate a Hebrew word's own escape.
  const out = bidiHtml("ק&quot;ג בלבד");
  assert.equal(out, "<bdi>ק&quot;ג בלבד</bdi>");
  assert.doesNotMatch(out, /dir="ltr"/);
  // And the entity is still passed through untouched when a run IS isolated
  // elsewhere in the same string.
  assert.equal(bidiHtml("הרמתי 3×5 @ 60 ק&quot;ג"), '<bdi>הרמתי <bdi dir="ltr" lang="en">3×5 @ 60</bdi> ק&quot;ג</bdi>');
});

test("bidiHtml never alters the HTML it was handed beyond adding isolates", () => {
  const inputs = [
    'תודה <button class="mention" data-id="a-1">@noam</button> על הכל',
    "Rx 43/30 ק&quot;ג. נשבר לי",
    "שורה <b>מודגשת</b> עם 3×5 @ 60",
    "",
  ];
  for (const input of inputs) {
    const out = bidiHtml(input);
    assert.equal(out.replace(/<bdi(?: [^>]*)?>/g, "").replace(/<\/bdi>/g, ""), input);
  }
});

// ---------------------------------------------------------------------------
// Adversarial input.
// ---------------------------------------------------------------------------

test("a stray bidi control character breaks a run instead of being swallowed by it", () => {
  // A forced-LTR isolate holding half of an unbalanced RLI/PDI pair is a worse
  // string than the one we started with.
  const out = bidiText("עשיתי 3⁧×5 @ 60 היום");
  for (const run of out.match(/<bdi dir="ltr" lang="en">[\s\S]*?<\/bdi>/g) || []) {
    assert.doesNotMatch(run, /[‎-‏‪-‮⁦-⁩]/, "a run must never contain a bidi formatting control");
  }
});

test("pathological input terminates and stays lossless", () => {
  const inputs = [
    "",
    "\n\n\n",
    "×".repeat(500),
    ("עברית 3×5 @ 60 ".repeat(200)),
    "⁩⁦‮",
    "0".repeat(1000),
  ];
  for (const input of inputs) {
    assert.equal(stripped(bidiText(input)), input, `lossless for ${JSON.stringify(input.slice(0, 24))}…`);
  }
});

// ---------------------------------------------------------------------------
// The CALL SITES, in the two files where this pair has already drifted once.
//
// Everything above tests the helper. This tests that the helper is reached.
// Five of the original cloud.js <bdi> pass's call sites were carried into
// src/community/* as bare esc() when cloud.js was split per feature
// (docs/audit/ux-stash-review.md), and the leaderboard rows held the textbook version of
// it: one nameHtml()-wrapped and one not (that module is gone since the
// leaderboards were dropped; the scan below now covers what is left). A member's own typed
// display name is the mixed-script case this whole file exists for — "דני
// Smith" in an RTL row reorders — so a name interpolated into element TEXT
// must go through bidiText(), which escapes and isolates in one step.
//
// Attributes and <option> text are deliberately NOT findings: <bdi> is an
// element, so it cannot live in an attribute value, and it is not valid
// inside <option>. Those keep bare esc(), and the scanner skips both.
// ---------------------------------------------------------------------------

// Every `${...}` in the file, with the HTML its own template literal has
// emitted before it. A plain regex cannot do this: these renderers nest
// templates inside interpolations inside templates, and the JS in between
// carries `<` and `>` of its own (`memberCount > 0 ? …`, `(t) => …`). So walk
// the source with a small stack instead, and let each template frame
// accumulate only its own literal text.
function eachInterpolation(src, visit) {
  const stack = [{ code: true, braces: 0 }];
  let i = 0;
  while (i < src.length) {
    const f = stack[stack.length - 1];
    const c = src[i];
    if (!f.code) {
      if (c === "\\") { f.html += src.substr(i, 2); i += 2; continue; }
      if (c === "`") { stack.pop(); i++; continue; }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ code: true, braces: 0, from: i + 2, tpl: f });
        i += 2;
        continue;
      }
      f.html += c;
      i++;
      continue;
    }
    if (c === "`") { stack.push({ code: false, html: "" }); i++; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2; continue; }
    if (c === "{") { f.braces++; i++; continue; }
    if (c === "}") {
      if (f.braces === 0 && f.from != null) {
        visit(src.slice(f.from, i), f.tpl.html, f.from);
        stack.pop();
      } else f.braces--;
      i++;
      continue;
    }
    i++;
  }
}

// `esc(<expr>)` where <expr> ends in an identifier ending in "name" — name,
// mine.name, prof.display_name, captainName — landing in element TEXT.
// Not nameValue, not title, not an attribute, not <option>.
function bareNameSinks(src) {
  const found = [];
  eachInterpolation(src, (expr, html, at) => {
    const m = expr.trim().match(/^esc\(([^()]*)\)$/);
    if (!m) return;
    const tail = (m[1].trim().match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1] || "";
    if (!/name$/i.test(tail)) return;
    // Inside a start tag — an attribute value — if the last angle bracket
    // still open is a `<`. Those are correct as they stand.
    if (html.lastIndexOf("<") > html.lastIndexOf(">")) return;
    const tag = (html.match(/<([a-zA-Z][\w-]*)[^<]*>[^<]*$/) || [])[1] || "";
    if (tag.toLowerCase() === "option") return;
    found.push(`${src.slice(0, at).split("\n").length}: esc(${m[1].trim()})`);
  });
  return found;
}

test("the scanner below really does catch a bare esc() name — it is not vacuously green", () => {
  const sample = [
    'const a = `<div class="log-row"><span>${esc(name)}</span></div>`;',            // a finding
    'const b = rows.map((t) => `<div>${t.n > 0 ? `<span>${esc(t.name)}</span>` : ""}</div>`);', // a finding, nested
    'const c = `<div><span>${bidiText(name)}</span></div>`;',                        // fixed
    'const d = `<div title="${esc(t.name)}"${n > 0 ? " hidden" : ""}>x</div>`;',     // attribute
    'const e = `<option value="${esc(p.id)}">${esc(name)}</option>`;',               // <option>
    'const f = `<div><span>${esc(nameValue)}</span></div>`;',                        // not a name
  ].join("\n");
  assert.deepEqual(bareNameSinks(sample), ["1: esc(name)", "2: esc(t.name)"]);
});

test("no member display name renders through bare esc() in an RTL paragraph", () => {
  for (const file of ["src/community/reactions.js", "src/community/privacy.js", "src/community/notifications.js", "src/community/achievements.js", "src/community/auth.js", "src/community/share-prompt.js", "cloud.js"]) {
    const found = bareNameSinks(communityFile(file));
    assert.deepEqual(
      found,
      [],
      `${file} renders a member-typed name into element text through esc() instead of bidiText():\n  ${found.join("\n  ")}`,
    );
  }
});
