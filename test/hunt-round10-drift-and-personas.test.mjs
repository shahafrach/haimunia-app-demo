// Round 10 of the live bug hunt: the final drift sweep and two unstructured
// member/coach sessions. Nine fixes, and the pattern is the one that has
// dominated all ten rounds - a rule written down in one place and not carried
// to the place beside it. Two of these are drift from round 9's OWN fixes.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const tieBreak = readFileSync(new URL("../supabase/migrations/202609160002_the_tie_break_reaches_every_list.sql", import.meta.url), "utf8");
const welcome = readFileSync(new URL("../supabase/migrations/202609160003_the_welcome_queue_is_for_members.sql", import.meta.url), "utf8");




test("saveWod got saveSet's absurd-weight guard, which every other saveSet fix reached", () => {
  const at = appJs.indexOf("async function saveWod(sanityConfirmed)");
  assert.ok(at > -1, "saveWod takes the confirmation flag saveSet takes");
  const body = appJs.slice(at, at + 4000);
  assert.match(body, /w\.scoreType === "load" && !sanityConfirmed/,
    "a load-format WOD is a max lift and reaches the same celebration overlay");
  // 2026-09-18: the two copies of `best > 0 && weight >= best * N` became one
  // shared predicate when the first-set ceiling was added - the point of this
  // assertion is that saveWod still asks the same question saveSet asks, and
  // it is now stronger than it was, because they are literally the same call.
  assert.match(body, /weightNeedsSanityCheck\(wodWeight, prevBest, firstSetWeightCeiling\(null\)\)/,
    "and asks it through the one predicate saveSet uses, not a second copy of the rule");
  assert.match(appJs, /function weightNeedsSanityCheck\(weight, reference, ceiling\)/);
  const setAt = appJs.indexOf("async function saveSet(sanityConfirmed)");
  assert.match(appJs.slice(setAt, setAt + 4000), /weightNeedsSanityCheck\(weight, reference, firstSetWeightCeiling\(mov && mov\.category\)\)/,
    "saveSet calls the same predicate - one rule, two save paths, which is what this test was always about");
  assert.match(body, /action: "save-wod",/);
  assert.match(appJs, /else if \(c\.action === "save-wod"\) saveWod\(true\);/,
    "and confirming it actually saves");
});

test("the composite cursor reached all three lists round 9 left behind", () => {
  for (const fn of ["admin_member_roster", "admin_incomplete_signups", "admin_invite_list"]) {
    assert.ok(tieBreak.includes(`p_cursor_id is not null`), `${fn} compares a tuple`);
    assert.match(tieBreak, new RegExp(`drop function if exists public\\.${fn}\\(`),
      `${fn}'s old signature is dropped, not left as an overload`);
  }
  // The direction matters: a tuple < only means "earlier in this ordering" when
  // the tuple's columns are ordered the same way ORDER BY orders them.
  assert.ok(!/order by coalesce\(ir\.redeemed_at, p\.created_at\) desc, p\.id\s*$/m.test(tieBreak),
    "the roster tie-break is no longer ascending under a descending date");
  assert.match(tieBreak, /order by coalesce\(ir\.redeemed_at, p\.created_at\) desc, p\.id desc/);
  assert.match(tieBreak, /order by ir\.redeemed_at desc, u\.id desc/);
  assert.match(tieBreak, /order by i\.created_at desc, i\.id desc/);
  // And round 9's own leftovers: create-or-replace with a new arg list
  // OVERLOADS rather than replaces, so production carried both the fixed and
  // the broken function, the broken one still granted to authenticated.
  assert.match(tieBreak, /drop function if exists public\.admin_actions_page\(timestamptz, integer, jsonb\);/);
  assert.match(tieBreak, /drop function if exists public\.notif_list\(timestamptz, integer\);/);
});



test("an ordinary save says so, because silence is what caused the double-tap duplicate", async () => {
  const { bootApp } = await import("./helpers/boot.mjs");
  const window = await bootApp();
  // Pick a movement the way a member does - nothing is pre-selected on a fresh
  // load and saveSet() refuses until one is chosen (COMM-360).
  window.document.getElementById("tabAddBtn").click();
  window.document.querySelector('[data-action="open-picker"]').click();
  const pick = window.document.querySelector('[data-action="pick-movement"]');
  pick.click();
  const movId = pick.dataset.id;
  // The FIRST-ever entry is a celebration, deliberately (arrival, not a medal),
  // so it is not the case this fix is about. The ORDINARY save is the second
  // one onwards, which is where the silence was.
  await window.saveSet();
  window.closeCelebration();
  await window.saveSet();

  // The toast is the whole fix: an ordinary save (no PR, no badge, not the
  // first entry) used to return in silence with the button still enabled and
  // the same numbers loaded, so a member unsure whether the tap registered
  // tapped again.
  const bar = window.document.getElementById("appToastBar");
  assert.ok(bar, "a confirmation is on screen after an ordinary save");
  assert.match(bar.textContent, /נשמר/, "and it says the set was saved");
  assert.ok(bar.textContent.trim().length > "נשמר".length,
    "naming what was saved, so the member can tell WHICH tap landed");

  // And deliberately NOT a dedupe. Three sets of 90x5 is three real rows, so
  // suppressing or merging an identical second save would break the most
  // ordinary flow in the app in order to fix a feedback problem.
  const before = window.entriesFor(movId).length;
  await window.saveSet();
  assert.equal(window.entriesFor(movId).length, before + 1,
    "a second identical set is still a second real set");
});

test("the coach welcome queue excludes staff", () => {
  assert.match(welcome, /and coalesce\(public\.role_rank\(ir\.role\), 10\) < 20/,
    "coaches and above are not newcomers");
  assert.match(welcome, /and not coalesce\(pr\.is_admin, false\)/,
    "nor is a legacy is_admin flag holder");
  // A profile with no redemption row is a real signup mid-flow and must STAY.
  assert.match(welcome, /coalesce\(public\.role_rank\(ir\.role\), 10\)/,
    "a missing role coalesces to member rank, not to staff");
  // The parts that were right must survive the rewrite verbatim.
  assert.match(welcome, /from public\.attendance_log al/, "the aggregate count is unchanged");
  assert.match(welcome, /order by\s*\n\s*m\.joined_on desc,/, "and the work-queue ordering is unchanged");
});
