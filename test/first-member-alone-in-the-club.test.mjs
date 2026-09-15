// What the FIRST member sees, alone in an empty club.
//
// Live bug hunt, fresh round 2 (2026-09-15). Production was emptied to two
// management accounts and zero content, and an agent walked every surface in
// that state. Three defects had been sitting in plain sight because every
// fixture-seeded club in this suite has two or more members and some content:
// "the club is genuinely empty, and I am the only one in it" had barely been
// rendered before.
//
// The first member to arrive is also the person most likely to decide the app
// is broken and never come back, so these are worth more than their severity
// suggests.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("a club of one does not read '1 חברי מועדון'", () => {
  // Hebrew does not pluralise like that: the noun must be singular for 1.
  // This is the first line of the first tab a new member lands on.
  const at = cloudJs.indexOf("function clubMembersLabel(n)");
  assert.ok(at > -1, "there is a label helper rather than a raw template");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /count === 1 \?/, "the count of one is a separate case");
  assert.ok(!/^\s*return `\$\{count\} חברי מועדון`;/m.test(body.split("count === 1")[0]),
    "and it is not the plural form");
  // The header uses it, rather than re-inlining the plural.
  assert.match(cloudJs, /\$\{clubMembersLabel\(club\.member_count\)\}/,
    "the club header renders through the helper");
  assert.ok(!/\$\{Number\(club\.member_count \|\| 0\)\} חברי מועדון/.test(cloudJs),
    "the hardcoded plural must be gone");
});

test("an ordinary member's profile does not say 'member' twice in a row", () => {
  // PROFILE_ROLE_LABELS.member is "חבר/ה" and the line that follows it
  // hardcodes "חבר/ה מאז", so a plain member read "חבר/ה · חבר/ה מאז ...".
  // Correct-looking only for coach/admin/staff, whose role label differs from
  // the generic noun - which is why it survived: those are the fixtures.
  const at = cloudJs.indexOf("function profileRoleAndSince(");
  assert.ok(at > -1, "the role/since line is built by a helper now");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /roleLabel !== PROFILE_ROLE_LABELS\.member/,
    "the generic member label is recognised and not repeated");
  assert.match(body, /return `\$\{role\} · \$\{since\}`/, "other roles still get both halves");
  // The control: the old inline concatenation must be gone.
  assert.ok(!/\$\{roleLabel \? esc\(roleLabel\) : ""\}\$\{d\.member_since \? ` · חבר\/ה מאז/.test(cloudJs),
    "the blind concatenation must be gone");
});

test("you are never offered a follow button on your own profile", () => {
  // The database refuses it - follows carries check (follower_id <> followed_id)
  // - but follow() only special-cases 23505 (already following, which becomes
  // an unfollow), so a check violation fell through to a generic failure and
  // dead-ended. Reachable in one tap by a member alone in the club: open your
  // own post's byline, which is exactly what a first poster does.
  const at = cloudJs.indexOf("const isSelfProfile =");
  assert.ok(at > -1, "the profile overlay knows whether it is showing you");
  const region = cloudJs.slice(at, at + 260);
  assert.match(region, /pv\.userId === state\.user\.id/, "self is recognised by id");
  assert.match(region, /const followBtn = \(isSelfProfile \|\| d\.allow_follows === false\) \? "" :/,
    "and no follow control is rendered for yourself");
  // The sibling report button already did this; the two must stay consistent.
  assert.match(cloudJs, /const reportProfileBtn = \(state\.user && pv\.userId === state\.user\.id\) \? "" :/,
    "the report button keeps its own self-check");
});

// ===========================================================================
// The join path, round 2 (2026-09-15)
// ===========================================================================
test("a rejected submit keeps what the member already typed", async () => {
  // HIGH, reproduced live on all three forms of the join path. setFieldErrors()
  // calls rerender(), which replaces #content wholesale, and these inputs
  // carry no value= bound back to state - so a password one character short
  // of ten wiped the USERNAME too, a taken username wiped the password and
  // its confirmation, a mistyped login password wiped the username on every
  // attempt, and an invalid club handle wiped a good display name and bio.
  //
  // Every member walks this path once, on a phone, with no self-service
  // password reset behind them. Retyping everything because one rule was
  // missed is how a signup ends.
  const { bootCommunity, waitFor } = await import("./helpers/boot.mjs");
  const { createMockSupabase } = await import("./helpers/mockSupabase.mjs");
  const mock = createMockSupabase({
    profiles: [], invite_redemptions: [], clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], notifications: [],
    notification_preferences: [], challenges: [], onboarding_step_content: [],
  });
  const window = await bootCommunity(mock, { syncEnabled: false, url: "https://example.test/index.html" });

  // Reach the login form, which is the smallest instance of the same bug.
  // The app boots on the training log, so open Community first; "show-login"
  // is then the neutral choice screen's own route to the credential form.
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="show-login"]'), 4000);
  window.document.querySelector('[data-community-action="show-login"]').click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 4000);

  const form = window.document.getElementById("communityLogin");
  form.elements.username.value = "dana_k";
  form.elements.password.value = "wrong-password";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => /שגוי|שגויים/.test(window.document.body.textContent), 4000);

  const after = window.document.getElementById("communityLogin");
  assert.ok(after, "the form is still on screen");
  assert.equal(after.elements.username.value, "dana_k",
    "the username survives a wrong password - it was never the thing that was wrong");
});

test("a SUCCESSFUL submit does not refill the form it just cleared", () => {
  // The other half, and the reason the snapshot is conditional: clearing
  // errors after a successful submit calls setFieldErrors(formId, {}) too,
  // and a form that refilled itself on success would be worse than the bug.
  const at = cloudJs.indexOf("function setFieldErrors(formId, errors)");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /const hasErrors = !!\(errors && Object\.keys\(errors\)\.length\);/,
    "rejection and success are told apart");
  assert.match(body, /const snapshot = hasErrors \? captureFormValues/,
    "nothing is captured on success");
  assert.match(body, /if \(snapshot\) restoreFormValues\(formId, snapshot\);/,
    "and nothing is restored on success");
});
