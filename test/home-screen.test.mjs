// Home is about me, Circle is about us (docs/circles/decisions.md, "Home and
// recovery"). Home draws the member's own training from the device in every
// state: signed out, signed in with no circle, signed in with circles. The circle
// gate, feed, week and invites are the Circle tab's.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createCirclesMock, bootCommunity, waitFor, click, membership, ME, CIRCLE_A } from "./helpers/circles.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const text = (w) => w.document.getElementById("content").textContent;
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

/** Put sets in the device's own log (IndexedDB) and reload the app's view of it. */
async function seedLog(window, sets) {
  let i = 0;
  for (const s of sets) {
    await window.dbPut({ id: "seed-" + i, ts: Date.now() - i * 1000 - 86400000 * (s.ago || 0), updatedAt: Date.now(), exerciseId: "back-squat", type: "reps", sets: 1, isPR: false, est1RM: 0, durationSeconds: 0, groupId: null, blockLabel: "", ...s, date: daysAgo(s.ago || 0) });
    i++;
  }
  await window.reloadFromDb();
}
async function openHome(window) {
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector("[data-home-circles]"), 4000);
}
const LOG = [
  { weight: 60, reps: 5, ago: 14 }, { weight: 60, reps: 5, ago: 10 }, { weight: 60, reps: 5, ago: 7 }, { weight: 70, reps: 5, ago: 0 },
];

test("signed out: Home shows my training and a one-line circles card, not the sign-up gate", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await seedLog(window, LOG);
  await openHome(window);
  const t = text(window);
  assert.match(t, /השבוע שלי/);
  assert.match(t, /מתוך 3 אימונים השבוע/, "the ring, against the default target");
  assert.match(t, /יעד ברירת מחדל: 3/);
  assert.ok(window.document.querySelector("[data-week-ring]"));
  assert.ok(window.document.querySelector("[data-weeks-met]"), "weeks met");
  assert.ok(window.document.querySelector('[data-last-session="1"] [data-action="log-same-lift"]'), "the last session with a one-tap log of the same lift");
  assert.match(t, /Back Squat/);
  assert.ok(window.document.querySelector('[data-home-prs="1"] [data-last-pr="1"]'), "latest PRs");
  assert.match(window.document.querySelector('[data-home-prs="1"]').textContent, /\+\d+(\.\d+)?%/, "with the percent improvement");
  assert.ok(window.document.querySelector(".home-log-cta"), "the log button");
  const card = window.document.querySelector('[data-home-circles="none"]');
  assert.ok(card, "one compact circles card");
  assert.equal(card.querySelectorAll("button").length, 2, "create and join");
  for (const gateText of ["הוזמנת להצטרף", "יש לי קישור הזמנה", "התחברות", "קישור הזמנה"]) assert.ok(!t.includes(gateText), "no gate copy on Home: " + gateText);
  assert.equal(window.document.getElementById("communityHead"), null, "no signed-in header");
});

test("signed out, first run: it says what to do first", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await openHome(window);
  assert.ok(window.document.querySelector('[data-home-first-run="1"]'));
  assert.match(text(window), /בוחרים תרגיל, רושמים סט אחד/);
  assert.match(text(window), /רישום האימון הראשון/);
  assert.equal(window.document.querySelector('[data-last-session="1"]'), null);
});

test("signed in with no circle: my training, a greeting, and create/join right on Home", async () => {
  const mock = createCirclesMock({ circles: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await seedLog(window, LOG);
  await openHome(window);
  assert.ok(window.document.getElementById("communityHead"), "the greeting header");
  assert.match(text(window), /אני/, "the member's name");
  assert.match(text(window), /השבוע שלי/);
  assert.ok(window.document.querySelector('[data-last-session="1"]'));
  const card = window.document.querySelector('[data-home-circles="none"]');
  assert.ok(card);
  assert.ok(card.querySelector('[data-community-action="c-create-open"]'));
  assert.ok(card.querySelector('[data-community-action="c-join-open"]'));
  assert.match(text(window), /עוד אין לך מעגל/);
  assert.ok(!text(window).includes("הדביקו את קישור ההזמנה"), "no invite gate");
});

test("signed in with circles: the list and the latest few posts; the feed itself stays on the Circle tab", async () => {
  const feed = [1, 2, 3, 4].map((n) => ({ post_id: "p" + n, author_id: "f", author_name: "דנה", author_emoji: "🦁", post_type: "POST_TEXT", title: "פוסט " + n, result_text: "", body: "", metadata: {}, occurred_on: "2026-10-2" + n, published_at: "2026-10-2" + n + "T10:00:00Z", reaction_counts: {}, my_reactions: [] }));
  const mock = createCirclesMock({ circles: [membership()], feed });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await seedLog(window, LOG);
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector("[data-home-posts]"), 4000);
  assert.equal(window.document.querySelectorAll('[data-community-action="c-open-circle"]').length, 1);
  const posts = window.document.querySelectorAll("[data-home-posts] .log-row");
  assert.equal(posts.length, 3, "three at most");
  assert.ok(!window.document.querySelector("#communityHeldPosts"), "no feed on Home");
  assert.ok(!window.document.querySelector('[data-community-action="c-section"]'), "no week/feed/members tabs on Home");
  assert.ok(!window.document.querySelector('[data-community-action="c-invite-open"]'), "no invites on Home");
  assert.ok(window.document.querySelector('[data-last-session="1"]'));
});

test("the one-tap log of the same lift opens the Log tab on that lift", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await seedLog(window, LOG);
  await openHome(window);
  click(window, '[data-action="log-same-lift"]');
  await waitFor(() => window.document.getElementById("tabAddBtn").classList.contains("active"), 3000);
  assert.match(text(window), /Back Squat/);
});

test("Home never renders the Circle gate", () => {
  const src = readFileSync(new URL("../src/community/circles-ui.js", import.meta.url), "utf8");
  const a = src.indexOf("function renderHomeScreen()");
  const home = src.slice(src.indexOf("// ---- Home ---"), src.indexOf("function ICONS_CHEVRON()")).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(a > 0 && !home.includes("renderCircleGate"), "no Home function calls renderCircleGate");
});
