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

test("the composer label has exactly one definition, and the welcome card uses it", () => {
  // The coupling that broke. Two screens name this control - the fake-input
  // row at the top of the feed, and the onboarding card that tells a member
  // to tap it - and nothing tied them together.
  // The STRING changed with the social feed pass ("מה עשית היום?" - a
  // training club's feed asks what you just did, not what the news is) and
  // this pin moved with it. What the test is actually for did not change at
  // all, and is the reason the string only had to be edited in one place: one
  // definition, quoted by every screen that names the control.
  assert.match(cloudJs, /const POST_COMPOSER_PLACEHOLDER = "מה עשית היום\?";/,
    "one definition of the composer's label");
  const defs = cloudJs.split("\n").filter((l) => l.includes("מה עשית היום?") && !/^\s*\/\//.test(l));
  assert.equal(defs.length, 1, `the label must be written out exactly once, found ${defs.length}:\n${defs.join("\n")}`);

  // The rendered trigger reads it rather than repeating it.
  const at = cloudJs.indexOf("post-composer-trigger-text");
  assert.match(cloudJs.slice(at, at + 120), /\$\{esc\(POST_COMPOSER_PLACEHOLDER\)\}/,
    "the feed's composer renders the constant");

  // And the welcome card's fallback body quotes it, so the instruction names
  // whatever the button actually says.
  const w = cloudJs.indexOf('onboardingStepBodyRaw("welcome")');
  // From the START of that line: the call is wrapped, so a slice beginning at
  // the call itself would not see what wraps it.
  const line = cloudJs.slice(cloudJs.lastIndexOf("\n", w) + 1, cloudJs.indexOf("\n", w));
  assert.match(line, /\$\{POST_COMPOSER_PLACEHOLDER\}/,
    "the welcome card points at the real label, not a remembered one");
  assert.ok(!/כתיבת פוסט/.test(line), "and never at the retired one");

  // ...AND SO DOES A STORED ONE. The fallback above only runs when the row is
  // missing; the seeded row (202609150007) exists, so for nearly every club
  // it is the STORED body that renders - and it still names whichever label
  // was current when that migration was written. A rename that only moved the
  // constant would have recreated the very defect this file exists for, on
  // the first card a new member ever reads.
  // THE STORED BODY IS CORRECTED IN THE DATABASE, NOT HERE. This used to be
  // a client-side rewrite (RETIRED_COMPOSER_LABELS + withCurrentComposerLabel),
  // shipped by #33 as an explicit stopgap because it did not hold the
  // migration slot. 202609230006 is the real repair, and the stopgap went with
  // it: a guarded UPDATE skips a row the club has edited, where the client
  // rewrite silently edited a club's own words on the way to the screen.
  assert.ok(!/withCurrentComposerLabel/.test(cloudJs),
    "the client-side rewrite is gone - the database owns the stored copy");
  // The DECLARATION, not any mention: club.js keeps a comment recording why
  // the stopgap existed and why it went, and that history is worth keeping.
  assert.ok(!/const RETIRED_COMPOSER_LABELS\s*=/.test(cloudJs),
    "and so is its list of retired labels");
});

test("no seeded first-run copy still names the retired button", () => {
  // The seed migration is immutable, so the correction is a later UPDATE -
  // which means the old string is still present in the repo and the check has
  // to be that it was superseded, not that it is absent.
  assert.match(seedSql, /כתיבת פוסט/, "the original seed is untouched, as migrations must be");
  assert.match(fixSql, /update public\.onboarding_step_content/, "and a later migration corrects it");
  assert.match(fixSql, /set body = 'כאן רואים מה קורה במועדון[^']*מה קורה היום\?[^']*'/,
    "to copy naming the control that was on screen when it was written");

  // AND THEN THE COMPOSER WAS RENAMED A THIRD TIME (#33), so that correction
  // went stale too. 202609230006 is the current one, and it must name the
  // label the client actually carries - the two copies of that decision are
  // checked against each other here.
  const current = cloudJs.match(/const POST_COMPOSER_PLACEHOLDER = "([^"]+)"/);
  assert.ok(current, "the composer label has one definition in the client");
  assert.ok(latestFixSql.includes(current[1]),
    `the latest correction must name the current label (${current[1]})`);
  assert.match(latestFixSql, /and updated_by is null/,
    "guarded, so a club that wrote its own words keeps them");
  assert.match(latestFixSql, /body like '%/,
    "and guarded on the stale text too, so it is a true no-op once applied");
});

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
  assert.match(note, /מאמן\/ת|צוות המועדון/, "and routes them to a person who can actually fix it");
  // Rendered on the login screen itself, not filed under help somewhere.
  const login = cloudJs.slice(cloudJs.indexOf('<form id="communityLogin">'));
  assert.match(login.slice(0, 1200), /\$\{LOGIN_RECOVERY_NOTE\}/,
    "shown on the screen where the member is stuck");
});
