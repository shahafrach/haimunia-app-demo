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

test("the challenge participants list honours visible_to_club, like the cooperative list already did", () => {
  const at = cloudJs.indexOf("function renderChallengeParticipants(v)");
  assert.ok(at > -1);
  const body = cloudJs.slice(at, at + 1400);
  assert.match(body, /\.filter\(\(p\) => !\(p\.profiles && p\.profiles\.visible_to_club === false\)\)/,
    "a member who turned club visibility off is never NAMED in the participants list");
  // The count must still be the server's, over every participant: opting out of
  // being named is not opting out of being counted, and the cooperative list
  // made exactly that distinction (COMM-203).
  assert.match(body, /v\.progress\.participant_count/, "the count still comes from the server");
});

test("every count string on the manage attention rows has a singular form", () => {
  const at = cloudJs.indexOf("function renderManageAttention");
  const body = cloudJs.slice(at, cloudJs.indexOf("].filter(Boolean)", at));
  assert.match(body, /pendingReports === 1 \?/, "the moderation row had one already");
  assert.match(body, /inactiveCount === 1 \?/, "and the row two lines below it now does too");
  assert.ok(!/\$\{inactiveCount\} חברים/.test(body.split("inactiveCount === 1")[0]),
    "the bare plural is no longer the only branch");
});

test("badge aria-labels come from one helper, so they cannot drift from the visible text again", () => {
  assert.match(cloudJs, /function badgeAria\(t\) \{/, "one helper");
  const at = cloudJs.indexOf("function badgeAria(t) {");
  const body = cloudJs.slice(at, at + 600);
  assert.match(body, /return n === 1 \? one : `\$\{n\} \$\{many\}`;/, "singular drops the numeral");
  // Both sub-tab bars must DERIVE from it rather than each building a string.
  const uses = cloudJs.match(/aria-label="\$\{esc\(badgeAria\(t\)\)\}"/g) || [];
  assert.equal(uses.length, 2, "the community bar and the manage bar both use it");
  assert.ok(!/aria-label="\$\{t\.badge\} דיווחים ממתינים"/.test(cloudJs),
    "and neither one still hand-builds a plural-only label");
  assert.match(cloudJs, /badgeLabelOne: "אתגר אחד מסתיים בקרוב"/, "the boards tab supplies its own singular");
  assert.match(cloudJs, /unread === 1 \? ", התראה אחת חדשה"/, "so does the notification bell");
});

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

test("the client sends the cursor id for all three of those lists", () => {
  for (const [rpc, idField] of [
    ["admin_member_roster", "r.cursorId"],
    ["admin_incomplete_signups", "g.cursorId"],
    ["admin_invite_list", "iv.cursorId"],
  ]) {
    const at = cloudJs.indexOf(`rpc("${rpc}"`);
    assert.ok(at > -1, `${rpc} is called`);
    assert.match(cloudJs.slice(at, at + 300), /p_cursor_id:/, `${rpc} is sent a cursor id`);
    assert.ok(cloudJs.includes(idField), `${rpc}'s pager tracks one (${idField})`);
  }
  // Resetting a list must clear BOTH halves, or page 2 of the next filter
  // starts from the last id of the previous one.
  for (const reset of [
    /r\.items = \[\]; r\.cursor = null; r\.cursorId = null;/,
    /g\.items = \[\]; g\.cursor = null; g\.cursorId = null;/,
    /iv\.items = \[\]; iv\.cursor = null; iv\.cursorId = null;/,
  ]) assert.match(cloudJs, reset);
});

test("the training log is bound to a community identity before it can be published", () => {
  // The log is device-local by design. The bug was that the CLUB-FACING bridge
  // was too: a second member signing in on one phone was offered the first
  // member's results to publish under their own name, and publishing worked.
  assert.match(appJs, /const LOG_OWNER_KEY = "haimunia-demo:logOwnerUserId";/);
  assert.match(appJs, /window\.haimuniaBindLogOwner = async function \(userId\)/);
  // Adopting an unowned log is the COMMON path - training locally and joining
  // the club later - and must not be mistaken for a foreign log.
  const bind = appJs.slice(appJs.indexOf("window.haimuniaBindLogOwner"), appJs.indexOf("window.haimuniaLogIsOwnedByAnotherMember"));
  assert.match(bind, /if \(!logOwnerUserId\) \{/, "an unowned log is adopted, not blocked");
  assert.match(bind, /logOwnedByOther = logOwnerUserId !== id;/);
  // Both bridges gate, including the one that writes.
  const logFor = appJs.slice(appJs.indexOf("window.communityWodLogFor = function"), appJs.indexOf("window.communityWodEntryForAttach = function"));
  assert.match(logFor, /if \(logOwnedByOther\) return \[\];/, "nothing is offered");
  const attach = appJs.slice(appJs.indexOf("window.communityWodEntryForAttach = function"), appJs.indexOf("window.communityWodEntryForAttach") + 900);
  assert.match(attach, /if \(logOwnedByOther\) return null;/, "and nothing can be written");
  // Bound on BOTH session paths - the boot path matters most, because the
  // second member arrives with a session already restored.
  const calls = cloudJs.match(/window\.haimuniaBindLogOwner\(state\.user\.id\)/g) || [];
  assert.equal(calls.length, 2, "bound at boot and on auth state change");
  // Nothing local is deleted or hidden on the strength of an identity guess.
  assert.ok(!/dbClear|clearAllData/.test(bind), "binding never destroys the member's own data");
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
