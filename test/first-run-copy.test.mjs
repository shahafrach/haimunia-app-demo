// The first sixty seconds, and the copy that governs them.
//
// Pre-launch review, 2026-09-15. Three defects, all in seeded copy, none of
// them catchable by any test that existed: a test can assert that a string
// RENDERS, and every one of these strings rendered perfectly. What none of
// them could assert is that the string was TRUE.
//
//   1. The welcome card told a new member to tap "כתיבת פוסט". The feed
//      redesign had already renamed that control to "מה קורה היום?", so the
//      first card anyone ever saw pointed at a button not on the screen.
//   2. The intro carousel promised that opening hours, dress code, equipment
//      rules and the cancellation policy were "always available in the
//      Community tab". That sentence existed in exactly one place in the
//      codebase - its own default row. None of that content exists.
//   3. The login screen offered no route at all for a forgotten password,
//      though a working one exists (an admin resets it from the roster).
//
// These assertions are deliberately about MEANING, not markup, which is why
// they read oddly compared to the rest of the suite. That is the point: the
// defect class here is copy that is well-formed and wrong.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const seedSql = fs.readFileSync(new URL("../supabase/migrations/202609030004_onboarding_step_content.sql", import.meta.url), "utf8");
const introSql = fs.readFileSync(new URL("../supabase/migrations/202609050007_intro_carousel_content.sql", import.meta.url), "utf8");
const fixSql = fs.readFileSync(new URL("../supabase/migrations/202609150007_first_run_copy_tells_the_truth.sql", import.meta.url), "utf8");
// The THIRD correction: #33 renamed the composer again, so 202609150007's copy
// went stale in its turn. 202609230006 is the current one.
const latestFixSql = fs.readFileSync(new URL("../supabase/migrations/202609230006_the_welcome_card_names_the_button_again.sql", import.meta.url), "utf8");



test("the first-run corrections never overwrite the club's own words", () => {
  // updated_by is null until a human saves that row from the panel, and the
  // pin trigger sets it server-side. Every correction is guarded on it, so
  // this fixes defaults and silently skips anything the club has made its own
  // - which is the entire reason those editors exist.
  const updates = fixSql.split("update public.").slice(1);
  assert.ok(updates.length >= 3, `expected the three corrections, found ${updates.length}`);
  for (const u of updates) {
    assert.match(u, /where step = '[a-z_]+'\s*\n\s*and updated_by is null;/,
      `an unguarded update would clobber a real edit:\n${u.slice(0, 200)}`);
  }
});

test("the carousel no longer promises club information this app does not hold", () => {
  // The broken promise, made on screen 2 of a member's first session and
  // broken by screen 3. Worse than saying nothing: it teaches them the app is
  // not to be relied on before they have used a single feature of it.
  assert.match(introSql, /זמין תמיד בלשונית הקהילה/, "the original seed is untouched");
  assert.match(fixSql, /update public\.intro_carousel_content[\s\S]*?where step = 'club_rules'/,
    "and a later migration replaces it");
  const fixedRules = /set body = '([^']*)'\s*\n\s*where step = 'club_rules'/.exec(fixSql);
  assert.ok(fixedRules, "the club_rules correction is present");
  assert.ok(!/זמין תמיד בלשונית הקהילה/.test(fixedRules[1]),
    "the new copy must not repeat the promise");
  assert.ok(!/שעות הפעילות[^']*זמין/.test(fixedRules[1]), "nor a reworded version of it");

  // Screen 3 told a new member to book a session. Booking is Arbox's job by
  // deliberate scope decision - this app is opened AFTER training - so the
  // instruction had no route and set the wrong expectation of what they had
  // just installed.
  const fixedStart = /set body = '([^']*)'\s*\n\s*where step = 'getting_started'/.exec(fixSql);
  assert.ok(fixedStart, "the getting_started correction is present");
  assert.ok(!/קבעו אימון/.test(fixedStart[1]),
    "it must not tell a member to book something this app cannot book");
  assert.match(fixedStart[1], /אחרי האימון/,
    "and should say what the app IS for - recording training after it happens");
});

test("the login screen says what to do when the password is gone", () => {
  // There is no email reset and there never will be - email delivery is
  // permanently out of scope, deliberately. But the consequence of that
  // decision was never written anywhere a member could read it, so a locked
  // out member met a form that refused them with no route out at all. The
  // realistic outcome is not that they ask; it is that they stop opening the
  // app and nobody learns why.
  assert.match(cloudJs, /const LOGIN_RECOVERY_NOTE = /, "the note exists");
  const at = cloudJs.indexOf("const LOGIN_RECOVERY_NOTE = ");
  const note = cloudJs.slice(at, cloudJs.indexOf("\n", at));
  assert.match(note, /שכחתם את הסיסמה/, "it names the situation in the member's own words");
  assert.match(note, /אי אפשר לאפס/, "and says plainly that there is no reset, rather than promising a person who can fix it");
  assert.match(note, /הזמנה חדשה/, "and names the way back in");
  // Rendered on the login screen itself, not filed under help somewhere.
  const login = cloudJs.slice(cloudJs.indexOf('<form id="communityLogin">'));
  assert.match(login.slice(0, 1200), /\$\{LOGIN_RECOVERY_NOTE\}/,
    "shown on the screen where the member is stuck");
});
