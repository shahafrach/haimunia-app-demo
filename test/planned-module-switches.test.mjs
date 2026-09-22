// 202609190002. SEVEN SWITCHES THAT ARRIVE BEFORE THEIR FEATURES.
//
// Every earlier module key was added after the feature it gates, and
// test/hunt-round6-every-function-has-a-switch.test.mjs enforces exactly
// that for its own five: "a switch that changes nothing is worse than no
// switch". These seven deliberately break that rule - they name features
// later branches will build - so the thing to pin here is the opposite
// pair of facts:
//
//   * the switch works NOW. It has a row, it renders, it is switchable,
//     and the write goes through the same admin_set_club_feature() as
//     every other module. That is the whole point of landing them early:
//     the branch that builds the feature adds a gate and no migration,
//     and supabase/migrations/ is the one directory two open branches
//     cannot both touch (CLAUDE.md, "Parallel work").
//   * the screen does not LIE about it. A row that gates nothing yet says
//     so ("בפיתוח"), and none of them claims server enforcement it does
//     not have.
//
// Plus the check 202609160006 was written after and could only make once:
// every key the panel offers has a club_features row seeded by SOME
// migration. club_wod reached production through the admin panel and no
// migration, so a fresh database had no row, its guard raised, and the
// whole chain stopped. Seven new keys at once is the moment to make that
// check general rather than scoped to the key that broke.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, seedAdminStepUp, unlockAdminPanel } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const layerJs = cloudSource();
const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);
const seedSql = fs.readFileSync(new URL("202609190002_seven_switches_before_their_features.sql", MIGRATIONS_DIR), "utf8");

// The seven, and which group each belongs to - asserted rather than
// derived, because "it is in one of the two arrays" would pass if a
// later edit moved a coach tool into the members' content list.
const PLANNED = [
  { key: "onboarding_challenge", group: "CLUB_MODULE_TOGGLES" },
  { key: "benchmarks", group: "CLUB_MODULE_TOGGLES" },
  { key: "strength_percentages", group: "CLUB_MODULE_TOGGLES" },
  { key: "gym_display", group: "CLUB_MODULE_TOGGLES" },
  { key: "coach_tasks", group: "COACH_MODULE_TOGGLES" },
  { key: "owner_report", group: "COACH_MODULE_TOGGLES" },
  { key: "arbox_attendance", group: "COACH_MODULE_TOGGLES" },
];
const PLANNED_KEYS = PLANNED.map((p) => p.key);

// Same slicing discipline hunt-round6-every-function-has-a-switch.test.mjs
// uses and for the same reason: notifications.js's NOTIF_PREF_TYPES shares
// this row shape and one of these words, and a bare indexOf over the whole
// layer is exactly the mistake that gets wrong.
function registry(name) {
  const at = cloudJs.indexOf(`const ${name} = [`);
  assert.ok(at > -1, `${name} is still a named registry`);
  return cloudJs.slice(at, cloudJs.indexOf("\n  ];", at));
}
function rowFor(key) {
  const group = PLANNED.find((p) => p.key === key).group;
  const block = registry(group);
  const at = block.indexOf(`{ key: "${key}",`);
  assert.ok(at > -1, `${key} must appear in ${group}`);
  return block.slice(at, block.indexOf("\n", at));
}

// ===========================================================================
// The registry half
// ===========================================================================

test("each planned key is declared once, with a Hebrew label and a one-line Hebrew description", () => {
  const both = registry("CLUB_MODULE_TOGGLES") + registry("COACH_MODULE_TOGGLES");
  for (const key of PLANNED_KEYS) {
    assert.equal(both.split(`{ key: "${key}",`).length - 1, 1,
      `${key} is declared exactly once across both groups - two rows for one key is two switches for one flag`);
    const row = rowFor(key);
    const label = /label: "([^"]+)"/.exec(row);
    const desc = /desc: "([^"]+)"/.exec(row);
    assert.ok(label, `${key} has a label`);
    assert.ok(desc, `${key} has a description - a switch whose feature nobody has seen needs one more than "אירועים" does`);
    assert.match(label[1], /[֐-׿]/, `${key}'s label is Hebrew`);
    assert.match(desc[1], /[֐-׿]/, `${key}'s description is Hebrew`);
    // ONE line. The panel renders it on a single row under the label; a
    // paragraph there turns the switch list into a document nobody reads.
    assert.ok(!desc[1].includes("\n"), `${key}'s description is one line`);
    assert.ok(desc[1].length <= 110, `${key}'s description stays a sentence (got ${desc[1].length} chars)`);
  }
});

test("each planned key is marked both planned and client-only, because it enforces nothing anywhere", () => {
  for (const key of PLANNED_KEYS) {
    const row = rowFor(key);
    assert.match(row, /planned: true/, `${key} has no feature behind it yet and the panel must say so`);
    // The claim a clientOnly row does NOT make. There is no RLS clause and
    // no definer function reading these keys, so "נאכף בשרת" would be false.
    assert.match(row, /clientOnly: true/, `${key} must not claim server enforcement it does not have`);
  }
});

test("a planned key gates nothing yet - and that is asserted, not assumed", () => {
  // The inverse of hunt-round6's "each new toggle actually gates
  // something". If this ever fails it is GOOD news with a stale test
  // attached: someone built the feature. The fix is to clear `planned` on
  // that row in the same commit, which is the whole handover this file
  // exists to force.
  for (const key of PLANNED_KEYS) {
    const gates = layerJs.split(`isModuleEnabled("${key}")`).length - 1;
    assert.equal(gates, 0,
      `${key} now has a gate - drop planned: true from its row so the panel stops saying בפיתוח`);
  }
});

test("no planned key collides with an existing module", () => {
  const existing = (registry("CLUB_MODULE_TOGGLES") + registry("COACH_MODULE_TOGGLES"))
    .match(/\{ key: "([a-z0-9_]+)"/g).map((m) => m.slice(8, -1));
  assert.equal(new Set(existing).size, existing.length, "no module key is declared twice");
  // coach_tasks next to the long-standing coach_tools is one typo away from
  // silently toggling the wrong thing, so both must survive intact.
  assert.ok(existing.includes("coach_tools") && existing.includes("coach_tasks"),
    "coach_tools and coach_tasks are different modules and both exist");
});

// ===========================================================================
// The migration half
// ===========================================================================

test("the migration seeds all seven, disabled", () => {
  for (const key of PLANNED_KEYS) assert.ok(seedSql.includes(`'${key}'`), `${key} must be seeded`);
  assert.match(seedSql, /on conflict \(club_id, module_key\) do nothing/,
    "the primary key is (club_id, module_key), and an admin's own choice is never overwritten by a replay");
  assert.match(seedSql, /select k, false/,
    "every one of these starts OFF - there is no feature to take away, and `true` would claim the club has one");
  // 202609010012's rule, restated where it can be checked: nothing here may
  // turn an existing module off on its way past.
  assert.ok(!/update public\.club_features/.test(seedSql),
    "this migration only inserts - it must not flip a live module");
});

test("every module key the panel offers has a club_features row seeded by some migration", () => {
  // THE GENERAL FORM OF THE club_wod BUG (202609150016/202609160006). A key
  // in the registry with no seed anywhere renders a switch that writes to a
  // row no fresh database has, and the failure shows up as a dead migration
  // chain rather than as a missing switch.
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  // Only the text of `insert into public.club_features ...` statements, so
  // a key that merely appears in a comment or in an unrelated policy does
  // not count as seeded.
  const inserts = files
    .map((f) => fs.readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"))
    .join("\n")
    .split(/insert into public\.club_features/)
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(";")))
    .join("\n");
  assert.ok(inserts.length > 0, "at least one migration seeds club_features");
  const declared = (registry("CLUB_MODULE_TOGGLES") + registry("COACH_MODULE_TOGGLES"))
    .match(/\{ key: "([a-z0-9_]+)"/g).map((m) => m.slice(8, -1));
  const missing = declared.filter((k) => !inserts.includes(`'${k}'`));
  assert.deepEqual(missing, [],
    `these keys have a switch in the panel and no row for it to write: ${missing.join(", ")}`);
});

// ===========================================================================
// The screen half - real render, real click, real RPC
// ===========================================================================

const VERIFIED = new Date().toISOString();
function seeded(features) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    // The seven exactly as 202609190002 leaves them: present and off.
    club_features: (features || PLANNED_KEYS.map((module_key) => ({ club_id: "club-1", module_key, enabled: false, config: {} }))),
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  seedAdminStepUp(mock, "u1", "dana@members.haimuniya.invalid");
  return mock;
}
async function openModuleSettings(window) {
  window.document.getElementById("tabManageBtn").click();
  await unlockAdminPanel(window);
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="moderation"]').click();
  await waitFor(() => !!window.document.querySelector("[data-club-modules-panel]"), 3000);
}

test("all seven render as switches in the system admin panel, off, today", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  for (const key of PLANNED_KEYS) {
    const box = window.document.querySelector(`[data-club-feature="${key}"]`);
    assert.ok(box, `${key} has a switch on the screen`);
    assert.equal(box.disabled, false, `${key} is switchable now, not greyed out until its feature ships`);
    assert.equal(box.checked, false, `${key} starts off`);
  }
});

test("each planned row says in Hebrew that it is not built yet, and that it is not server-enforced", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  for (const { key } of PLANNED) {
    const row = window.document.querySelector(`[data-club-feature="${key}"]`).closest("label");
    assert.match(row.textContent, /בפיתוח/, `${key}'s row says the feature does not exist yet`);
    assert.match(row.textContent, /בתצוגה בלבד/, `${key}'s row does not claim server enforcement`);
    assert.ok(!/נאכף בשרת/.test(row.textContent), `${key} must not carry the server-enforced marker`);
    const label = /label: "([^"]+)"/.exec(rowFor(key))[1];
    const desc = /desc: "([^"]+)"/.exec(rowFor(key))[1];
    assert.ok(row.textContent.includes(label), `${key}'s label is on the screen`);
    assert.ok(row.textContent.includes(desc), `${key}'s description is on the screen, not only in the source`);
  }
});

test("the description is tied to its switch for a screen reader, not folded into the switch's name", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  const box = window.document.querySelector('[data-club-feature="benchmarks"]');
  const describedBy = box.getAttribute("aria-describedby");
  assert.ok(describedBy, "the switch points at its description");
  const target = window.document.getElementById(describedBy);
  assert.ok(target, "and that description is actually in the document");
  assert.match(target.textContent, /Fran/, "it is the right one");
  // The label stays the short name. A checkbox announced as a whole
  // sentence is the failure aria-describedby exists to avoid.
  assert.equal(box.getAttribute("aria-label"), "אימוני בנצ'מרק");
});

test("a live module keeps its server-enforced marker and gains no בפיתוח", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openModuleSettings(window);
  const row = window.document.querySelector('[data-club-feature="events"]').closest("label");
  assert.match(row.textContent, /נאכף בשרת/, "events is gated by a real RLS predicate and says so");
  assert.ok(!/בפיתוח/.test(row.textContent), "events exists");
  // And the one the group blurb used to single out by name, now marked on
  // its own row like every other exception.
  const directory = window.document.querySelector('[data-club-feature="directory"]').closest("label");
  assert.match(directory.textContent, /בתצוגה בלבד/, "directory is a client-side hide and its own row says so");
});

test("switching a planned module on writes it through the same RPC as every other module", async () => {
  const mock = seeded();
  const calls = [];
  mock.onRpc("admin_set_club_feature", (args, ctx) => {
    calls.push(args);
    const row = ctx.db.club_features.find((r) => r.module_key === args.p_module_key);
    if (row) row.enabled = args.p_enabled;
    return { data: null, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openModuleSettings(window);

  const box = window.document.querySelector('[data-club-feature="gym_display"]');
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => calls.length === 1, 3000);

  assert.deepEqual(calls[0], { p_module_key: "gym_display", p_enabled: true });
  assert.equal(window.document.querySelector('[data-club-feature="gym_display"]').checked, true,
    "and the screen reflects the decision the admin just made");
});

test("the blanket 'enforced on the server' sentence is gone from both group blurbs", () => {
  // It was true of six rows on the day it was written and of neither group
  // by the time these seven landed. The markers replaced it; this pins that
  // the prose did not quietly survive alongside them.
  const at = layerJs.indexOf("function renderClubModulesPanel");
  const body = layerJs.slice(at, layerJs.indexOf("\n  }", at));
  assert.ok(!/ואוכף בשרת, לא רק בתצוגה/.test(body),
    "the group blurb no longer claims server enforcement for every row in it");
  assert.ok(!/יוצא דופן: "ספריית חברים"/.test(body),
    "and no longer names directory as the single exception - there are eleven");
  assert.match(body, /נאכף בשרת/, "the blurb explains what the row markers mean");
  assert.match(body, /בפיתוח/, "including the one for a switch whose feature has not been built");
});
