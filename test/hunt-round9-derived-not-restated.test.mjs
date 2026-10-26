// Live bug hunt, fresh round 9 (2026-09-16).
//
// Both findings are the same failure this hunt has been documenting for two
// days: a list that RESTATES another list instead of DERIVING from it. One of
// them was created by my own toggle work the day before.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

test("Escape closes whatever the dialog registry says is open", () => {
  // The Escape handler was a hand-maintained if/else chain naming fifteen
  // dialogs in the same order as CLOUD_DIALOGS - its own first three comments
  // said so, explaining that confirmSheet/sharingSheet/termSheet must come
  // first because each stacks on the one below. The BACKDROP handler forty
  // lines away already read the registry.
  //
  // So when clubWodBoard was added to the registry, clicking the backdrop
  // closed it and Escape did nothing - for keyboard and screen-reader users
  // only, while every other dialog in the app closed fine.
  const at = cloudJs.indexOf('if (e.key !== "Escape") return;');
  assert.ok(at > -1, "the Escape handler exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("});", at));
  assert.match(body, /for \(const d of CLOUD_DIALOGS\) \{\s*\n\s*if \(d\.isOpen\(\)\) \{ e\.preventDefault\(\); d\.close\(\); return; \}/,
    "it walks the registry in order, first match wins - the same behaviour the chain had");
  // The parallel list must be gone, or the drift can come straight back.
  for (const gone of ["closeChallengeView(); return;", "closeNotifCenter(); return;", "closeTermSheet(); return;"]) {
    assert.ok(!body.includes(gone), `the hand-maintained branch "${gone}" must not remain`);
  }
  // The post menu is not a dialog and is still handled after the loop.
  assert.match(body, /if \(state\.posts\.openMenu\) \{ state\.posts\.openMenu = null; rerender\(\); \}/,
    "the post menu keeps its own branch, after the registry walk");
});



// ===========================================================================
// Races, round 9 — both had a sibling that already solved them
// ===========================================================================



test("the local welcome sheet does not cover an invitation", () => {
  // cloud.js is deferred ahead of app.js, so by boot time it may already have
  // captured an invite deep link and routed to the invite-code screen.
  // Opening a focus-trapping full-screen sheet on top of that INTERCEPTED the
  // taps meant for the invite form's own submit button - the first thing every
  // member arriving from a shared link or QR would have hit.
  assert.match(cloudJs, /window\.communityInviteFlowPending = function \(\) \{/,
    "cloud.js can say whether an invitation is on screen");
  const circlesJs = fs.readFileSync(new URL("../src/community/circles.js", import.meta.url), "utf8");
  assert.match(circlesJs, /function inviteFlowPending\(\) \{ return !!\(\(state\.circles\.join\.token \|\| sharingInAppHeld\(\)\) && !inCircles\(\)\); \}/,
    "captured but not yet joined");
  assert.match(appJs, /if \(userName === null && isFreshInstall && !invitePending\) openWelcomeModal\(\);/,
    "and app.js's boot asks before opening its own sheet");
});

test("a member who joins by invite is not asked their name twice", () => {
  // The question is answered, not merely postponed: community signup collects
  // a display name and it is handed to the local log.
  assert.match(cloudJs, /window\.adoptCommunityDisplayName\(payload\.display_name \|\| handle \|\| ""\)/,
    "cloud.js hands the name over when the profile saves");
  const at = appJs.indexOf("window.adoptCommunityDisplayName = function (name)");
  assert.ok(at > -1, "app.js accepts it");
  const body = appJs.slice(at, appJs.indexOf("\n};", at));
  assert.match(body, /if \(!trimmed \|\| userName !== null\) return;/,
    "only when the local log has no name - a deliberately chosen private name is never overwritten");
});

