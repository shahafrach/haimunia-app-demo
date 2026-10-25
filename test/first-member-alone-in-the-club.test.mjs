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
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();




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
