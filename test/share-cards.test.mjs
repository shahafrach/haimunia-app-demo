// Share cards (src/share-cards.js): the pure layout half. No canvas needed -
// the layout builders decide which text and which fields reach the image.
// Painting is covered in Chromium by scripts/browser-check/share-cards.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const sc = require("../src/share-cards.js");

const PR = {
  memberName: "דנה", memberEmoji: "🔥", lift: "סקוואט", percent: 7.5,
  weight: 102.5, previousWeight: 95, unit: "kg", date: "2026-10-26",
};

test("starts with @ts-check and is pure (no network, storage or supabase)", () => {
  const src = fs.readFileSync(new URL("../src/share-cards.js", import.meta.url), "utf8");
  assert.ok(src.startsWith("// @ts-check"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\b(fetch|XMLHttpRequest|supabase|localStorage|sessionStorage|indexedDB|WebSocket|sendBeacon)\b/i.test(code));
});

test("number formatting", () => {
  assert.equal(sc.formatNumber(72.5), "72.5");
  assert.equal(sc.formatNumber(80), "80");
  assert.equal(sc.formatNumber(80.04), "80");
  assert.equal(sc.formatNumber(1234.56), "1,234.6");
  assert.equal(sc.formatNumber("x"), null);
  assert.equal(sc.formatNumber(null), null);
  assert.equal(sc.formatImprovement(7.5), "+7.5%");
  assert.equal(sc.formatImprovement(10), "+10%");
  assert.equal(sc.formatImprovement(0), null);
  assert.equal(sc.formatImprovement(-3), null);
  assert.equal(sc.formatPercent(84.6), "85%");
  assert.equal(sc.formatPercent(5000), "999%");
  assert.equal(sc.formatPercent(undefined), null);
  assert.equal(sc.formatDate("2026-10-26"), "26.10.2026");
  assert.equal(sc.formatDate("nope"), "");
  assert.equal(sc.weeksMetText(1), "שבוע אחד ביעד");
  assert.equal(sc.weeksMetText(6), "6 שבועות ביעד");
});

test("truncation of long names is by code point and never splits an emoji", () => {
  assert.equal(sc.truncate("דנה", 18), "דנה");
  const long = "א".repeat(40);
  const t = sc.truncate(long, 18);
  assert.equal(Array.from(t).length, 18);
  assert.ok(t.endsWith("…"));
  const emoji = sc.truncate("😀".repeat(30), 5);
  assert.equal(Array.from(emoji).length, 5);
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji.replace("…", "")));
  // Bidi controls and newlines in a name cannot survive into the image.
  assert.equal(sc.truncate("a‮b\nc", 18), "a b c");
});

test("PR card: percent is the hero; absolute weight only when showWeight is true", () => {
  const hidden = sc.buildPrLayout(PR);
  assert.equal(hidden.kind, "lift");
  assert.equal(hidden.hero, "+7.5%");
  assert.equal(hidden.weightText, null);
  assert.equal(sc.buildPrLayout({ ...PR, showWeight: false }).weightText, null);
  assert.equal(sc.buildPrLayout({ ...PR, showWeight: "true" }).weightText, null);
  assert.equal(sc.buildPrLayout({ ...PR, showWeight: 1 }).weightText, null);
  const shown = sc.buildPrLayout({ ...PR, showWeight: true });
  assert.equal(shown.weightText, "102.5 kg");
  // Nothing in the hidden layout mentions either weight.
  const json = JSON.stringify(hidden);
  assert.ok(!json.includes("102.5") && !json.includes("95"));
  assert.equal(hidden.dateText, "26.10.2026");
  assert.equal(hidden.member.emoji, "🔥");
});

test("PR card: percent is derived from the two weights when missing, without exposing them", () => {
  const l = sc.buildPrLayout({ ...PR, percent: undefined });
  assert.equal(l.hero, "+7.9%");
  assert.equal(l.weightText, null);
  // No previous best: a first PR says so rather than inventing a percent.
  const first = sc.buildPrLayout({ memberName: "דנה", lift: "דדליפט", date: "2026-10-26" });
  assert.equal(first.hero, "שיא חדש");
  assert.equal(first.heroLabel, "");
});

test("PR card: benchmark shows the result and Rx or scaled, never a percent or weight", () => {
  const rx = sc.buildPrLayout({ memberName: "דנה", showWeight: true, weight: 100, percent: 9,
    benchmark: { name: "Fran", result: "8:42", rx: true } });
  assert.equal(rx.kind, "benchmark");
  assert.equal(rx.hero, "8:42");
  assert.equal(rx.badge, "Rx");
  assert.equal(rx.weightText, null);
  assert.ok(!JSON.stringify(rx).includes("9%"));
  const scaled = sc.buildPrLayout({ memberName: "דנה", benchmark: { name: "Fran", result: "12:10", rx: false } });
  assert.equal(scaled.badge, "מותאם");
});

const WEEK = {
  circleName: "החבר'ה", circleEmoji: "💪", type: "friends",
  weeks: [{ label: "19.10 - 25.10", members: [
    { name: "דנה", emoji: "🔥", percent: 100, weeksMet: 6, weight: 80, rank: 1 },
    { name: "יוסי", emoji: "🏃", percent: 50, weeksMet: 1 },
    { name: "נועה", emoji: "🧘", percent: 90, paused: true, weeksMet: 3 },
  ] }],
};

test("week card: percent of own target, paused marked, weeks met, input order kept", () => {
  const l = sc.buildWeekLayout(WEEK);
  assert.equal(l.columns.length, 1);
  const rows = l.columns[0].rows;
  assert.deepEqual(rows.map((r) => r.name), ["דנה", "יוסי", "נועה"]);
  assert.equal(rows[0].percentText, "100%");
  assert.equal(rows[0].done, true);
  assert.equal(rows[0].metText, "6 שבועות ביעד");
  assert.equal(rows[1].percentText, "50%");
  assert.equal(rows[1].fraction, 0.5);
  assert.equal(rows[1].metText, "שבוע אחד ביעד");
  assert.equal(rows[2].paused, true);
  assert.equal(rows[2].percentText, null);
  assert.equal(rows[2].fraction, 0);
});

test("week card: no rankings and no weights anywhere in the layout", () => {
  // The first row carries adversarial weight and rank fields.
  const json = JSON.stringify(sc.buildWeekLayout(WEEK));
  assert.ok(!/weight|rank|position|"80"/i.test(json));
  // Sorting is never applied: a lower percent first stays first.
  const l = sc.buildWeekLayout({ ...WEEK, weeks: [{ members: [{ name: "a", percent: 10 }, { name: "b", percent: 99 }] }] });
  assert.deepEqual(l.columns[0].rows.map((r) => r.name), ["a", "b"]);
  // Over-target is shown honestly but the bar is capped.
  const over = sc.buildWeekLayout({ ...WEEK, weeks: [{ members: [{ name: "a", percent: 140 }] }] });
  assert.equal(over.columns[0].rows[0].percentText, "140%");
  assert.equal(over.columns[0].rows[0].fraction, 1);
});

test("week card: couple shows two weeks side by side; friends only one", () => {
  const two = { members: [{ name: "א", percent: 80 }, { name: "ב", percent: 100 }] };
  const couple = sc.buildWeekLayout({ circleName: "אנחנו", type: "couple",
    weeks: [{ label: "השבוע", members: two.members }, { label: "שבוע שעבר", members: two.members }, { label: "extra", members: [] }] });
  assert.equal(couple.columns.length, 2);
  assert.deepEqual(couple.columns.map((c) => c.title), ["השבוע", "שבוע שעבר"]);
  const friends = sc.buildWeekLayout({ circleName: "x", type: "friends", weeks: [two, two] });
  assert.equal(friends.columns.length, 1);
});

test("week card: long names truncate, big circles split into two columns, capped at 20", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: "חבר " + "ארוך".repeat(10) + i, percent: i }));
  const l = sc.buildWeekLayout({ circleName: "ק".repeat(60), circleEmoji: "💪", type: "friends", weeks: [{ members: many }] });
  assert.equal(l.columns.length, 2);
  assert.equal(l.columns[0].rows.length + l.columns[1].rows.length, 20);
  assert.ok(Array.from(l.columns[0].rows[0].name).length <= 18);
  assert.ok(Array.from(l.circle.name).length <= 28);
});

test("empty and malformed input does not throw", () => {
  assert.doesNotThrow(() => sc.buildPrLayout(undefined));
  assert.doesNotThrow(() => sc.buildWeekLayout({}));
  assert.deepEqual(sc.buildWeekLayout({ weeks: "x" }).columns, []);
});

test("colours come from CSS tokens, with a fallback when there is no document", () => {
  const c = sc.readColors();
  for (const k of ["bg", "surface", "border", "chalk", "steel", "energy", "brass", "green"]) assert.match(c[k], /^#[0-9a-f]{6}$/i);
});

test("wired in: one script tag and one OPTIONAL_ASSETS entry", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.equal(html.split('src="./src/share-cards.js"').length - 1, 1);
  const optional = sw.slice(sw.indexOf("const OPTIONAL_ASSETS"), sw.indexOf("const ASSETS"));
  assert.ok(optional.includes('"./src/share-cards.js"'));
});
