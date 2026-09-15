// Every function in the app should be switchable from the admin panel.
// 2026-09-15, on the owner's instruction, after an audit of what actually had
// a toggle and what did not.
//
// Five features ran with no off switch at all. The one that should not have
// been missing is weekly_recap: the MONTHLY club recap has been switchable
// since it shipped, and the WEEKLY one - more frequent, and the one that
// reaches every member rather than only the club's own summary - never was.
// The same drift shape this hunt has been finding all day, here in the
// feature registry itself.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const seedSql = fs.readFileSync(new URL("../supabase/migrations/202609150014_every_function_has_a_switch.sql", import.meta.url), "utf8");

const NEW_KEYS = ["weekly_recap", "comments", "post_photos", "mentions", "outward_share"];

test("each new feature has a toggle in the registry, marked clientOnly", () => {
  for (const key of NEW_KEYS) {
    const at = cloudJs.indexOf(`{ key: "${key}",`);
    assert.ok(at > -1, `${key} must appear in CLUB_MODULE_TOGGLES`);
    const row = cloudJs.slice(at, cloudJs.indexOf("\n", at));
    // These hide a control rather than being enforced by RLS. The panel reads
    // this flag so it does not claim server enforcement it does not have.
    assert.match(row, /clientOnly: true/, `${key} is client-side only and must say so`);
  }
});

test("each new toggle actually gates something", () => {
  // A switch that changes nothing is worse than no switch: it tells an owner
  // the feature is off while it goes on working.
  for (const key of NEW_KEYS) {
    const uses = cloudJs.split(`isModuleEnabled("${key}")`).length - 1;
    assert.ok(uses >= 1, `${key} has a toggle but no gate reading it`);
  }
  // The ones with more than one surface must gate every surface, not the
  // first one someone happened to find.
  assert.ok(cloudJs.split('isModuleEnabled("outward_share")').length - 1 >= 3,
    "outward share has three controls - the PR sheet, the achievement sheet and the earned-medal row");
  assert.ok(cloudJs.split('isModuleEnabled("comments")').length - 1 >= 2,
    "comments are reachable from two post surfaces");
  assert.ok(cloudJs.split('isModuleEnabled("post_photos")').length - 1 >= 2,
    "photos can be attached from the composer and from the PR prompt");
});

test("the feed toggle no longer claims to cover comments", () => {
  // Its label said "פיד (כולל תגובות ותגובות חיזוק)" while comments had no
  // switch of their own. Now they do, so the label must stop claiming them.
  assert.match(cloudJs, /key: "feed", label: "פיד \(כולל תגובות חיזוק\)"/,
    "reactions stay bundled with the feed; comments are their own switch");
});

test("mentions off stops the picker without rewriting old comments", () => {
  // With mentions off an "@" is just a character - no picker, no lookup
  // request. Markers already stored in older comments still render as names:
  // hiding those would be rewriting history rather than switching a feature
  // off.
  const at = cloudJs.indexOf("function onCommentInput(input)");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /isModuleEnabled\("mentions"\) \? \/\(\?:\^\|\\s\)@/,
    "the @ pattern is only evaluated when mentions are on");
  // The renderer must NOT be gated - that is the history-rewriting half.
  const renderAt = cloudJs.indexOf("MENTION_MARKER_RE");
  const renderRegion = cloudJs.slice(renderAt, renderAt + 1200);
  assert.ok(!/isModuleEnabled\("mentions"\)/.test(renderRegion),
    "stored markers keep rendering as names regardless of the toggle");
});

test("a row exists for every new key, defaulting to on", () => {
  // isModuleEnabled() defaults to true for a key with no row, so the app
  // behaves correctly either way - but the PANEL needs a row to render a
  // switch at all.
  for (const key of NEW_KEYS) {
    assert.ok(seedSql.includes(`'${key}'`), `${key} must be seeded`);
  }
  assert.match(seedSql, /on conflict \(club_id, module_key\) do nothing/,
    "the primary key is (club_id, module_key) - naming only module_key fails outright");
  assert.match(seedSql, /select k, true,/, "every new toggle starts on, so nothing changes for an existing club");
});

test("infrastructure and safety controls are deliberately NOT switchable", () => {
  // Recorded so the next audit does not 'complete' the set by adding them.
  // An admin who can silently disable moderation or the audit log is a worse
  // problem than any feature that switch would turn off.
  for (const key of ["moderation", "audit_log", "invites", "bug_reports", "notifications"]) {
    assert.ok(!cloudJs.includes(`{ key: "${key}",`),
      `${key} must stay unswitchable - it is infrastructure or a safety control`);
  }
});
