// Live bug hunt, fresh round 9 (2026-09-16).
//
// Both findings are the same failure this hunt has been documenting for two
// days: a list that RESTATES another list instead of DERIVING from it. One of
// them was created by my own toggle work the day before.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

test("Escape closes whatever the dialog registry says is open", () => {
  // The Escape handler was a hand-maintained if/else chain naming fifteen
  // dialogs in the same order as CLOUD_DIALOGS - its own first three comments
  // said so, explaining that confirmSheet/outwardShare/termSheet must come
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

test("the club WOD board is in the registry, so Escape now reaches it", () => {
  assert.match(cloudJs, /key: "clubWodBoard"/, "it is registered");
  // And the registry's order is now load-bearing for Escape as well as paint
  // order - which its own comments already assumed.
  const reg = cloudJs.slice(cloudJs.indexOf("const CLOUD_DIALOGS"), cloudJs.indexOf("const CLOUD_DIALOGS") + 6000);
  const keys = [...reg.matchAll(/key: "([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.equal(keys[0], "confirmSheet", "the stacking dialogs still come first");
  assert.equal(keys[1], "outwardShare");
  assert.equal(keys[2], "termSheet");
  assert.ok(keys.includes("clubWodBoard"), "and the board is present");
});

test("all three photo surfaces honour the post_photos toggle", () => {
  // post_photos was added the day before and wired into the feed composer and
  // the PR-share prompt - and missed in renderShareControl, which Calendar's
  // day detail, the Add tab's today's-sets card and the WOD progress card all
  // render. A club that switched photos off still got the camera offered.
  //
  // These toggles only hide the offer, by design, so a surface that keeps
  // offering is the entire failure.
  // FOUR since the social feed pass added the camera button beside the feed's
  // composer row. It is a fourth SURFACE, not a fourth upload path: it opens
  // the same composer through the same openComposer() and reaches for that
  // composer's own file input, so there is still exactly one piece of photo
  // code in the module. What it does need is its own gate, for the reason
  // this test was written - a club that switched photos off must not be
  // offered a camera - and the count is how a fifth surface that forgets one
  // gets caught.
  const uses = cloudJs.split('isModuleEnabled("post_photos")').length - 1;
  assert.equal(uses, 4, `every photo surface must be gated, found ${uses}`);
  assert.match(cloudJs, /isModuleEnabled\("post_photos"\) \? `<button class="composer-photo-btn" data-community-action="open-composer-photo"/,
    "the feed composer row's camera gates itself");
  const at = cloudJs.indexOf("window.renderShareControl = function (");
  const body = cloudJs.slice(at, at + 2600);
  assert.match(body, /isModuleEnabled\("post_photos"\) \? `<input type="file" id="photo-/,
    "the inline share control gates its own camera");
});

// ===========================================================================
// Races, round 9 — both had a sibling that already solved them
// ===========================================================================

test("a stale mention lookup cannot fill the picker with the wrong member", () => {
  // The picker fired a lookup per keystroke with no debounce and no ordering
  // token; its only guard asked "is this still the same comment box", never
  // "is this response still for the text in it". Correcting "@d" to "@z"
  // could leave Daniel in the dropdown - and pressing Enter then inserted
  // @[Daniel Levi](u-daniel) into a comment written while looking at "@z",
  // mentioning and NOTIFYING the wrong member and attributing it publicly to
  // someone who never typed it.
  const at = cloudJs.indexOf("async function searchMentionPeople");
  assert.ok(at > -1, "the mention lookup exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /const token = \+\+mentionSearchToken;/, "each request takes a token");
  assert.match(body, /if \(token !== mentionSearchToken\) return;/,
    "and a response that is no longer the newest writes nothing back");
  // Ordered correctly: the token check must come BEFORE the results are
  // applied, not after.
  assert.ok(body.indexOf("if (token !== mentionSearchToken) return;") < body.indexOf("mentionPicker.results = results"),
    "the check guards the write");
  // The siblings it copies must still have theirs.
  assert.match(cloudJs, /if \(token !== searchToken\) return;/, "communitySearch keeps its own token");
});

test("a feed page lands only in the scope it was requested for", () => {
  // Boot fires a "for_you" load; tapping "Following" before it resolves let
  // the slow first response land afterwards, so a post from someone the
  // member does not follow appeared under a Following chip still shown as
  // selected. loadMoreFeed() shared the hole.
  const at = cloudJs.indexOf("async function fetchFeedPage");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /const requestedScope = state\.feed\.scope;/,
    "the scope is captured before the request goes out");
  assert.match(body, /if \(state\.feed\.scope !== requestedScope\) return false;/,
    "and a response for a scope the member has left is dropped");
  // Before the rows are appended, not after.
  assert.ok(body.indexOf("requestedScope) return false;") < body.indexOf("state.feed.items.push(row)"),
    "the guard runs before anything is appended");
});

// ===========================================================================
// The seams between areas, round 9 — found by simply USING the app
// ===========================================================================
// Eight rounds hunted by area and by shape. These two live BETWEEN areas, in
// sequences no checklist covered: app.js's boot not knowing what cloud.js had
// just done, and per-page-load state surviving a change of member.
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("the local welcome sheet does not cover an invitation", () => {
  // cloud.js is deferred ahead of app.js, so by boot time it may already have
  // captured an invite deep link and routed to the invite-code screen.
  // Opening a focus-trapping full-screen sheet on top of that INTERCEPTED the
  // taps meant for the invite form's own submit button - the first thing every
  // member arriving from a shared link or QR would have hit.
  assert.match(cloudJs, /window\.communityInviteFlowPending = function \(\) \{/,
    "cloud.js can say whether an invitation is on screen");
  assert.match(cloudJs, /return !!\(state\.ui\.inviteCodeDraft && !state\.redemption\);/,
    "captured but not yet redeemed");
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

test("a brand-new member's first screen of the club is the feed", () => {
  // state.ui.tab is initialised once at script load, so one member could open
  // their own חשבון tab, sign out, and the next person to complete a fresh
  // signup on that device landed on the Account form as their first
  // impression of the club. A coach handing over their phone to sign someone
  // up is exactly how that happens.
  //
  // MY FIRST FIX WAS WRONG and the suite caught it: I reset the tab on
  // sign-out, and state.ui.tab surviving a sign-out is deliberate and
  // documented - a member who signs out and back in returns to where they
  // were, which community-state-namespaces.test.mjs enforces by name. The bug
  // was never that the tab persists across a SESSION; it is that it persisted
  // across a change of PERSON.
  //
  // Completing a first profile is the one moment that is unambiguously a new
  // member, so that is where the reset belongs.
  const at = cloudJs.indexOf("const isFirstProfile = !state.profile;");
  assert.ok(at > -1, "saveProfile knows whether this is a first profile");
  // Searched from `at`, not from the start of the layer: savePrivacyField()
  // in src/community/directory.js also writes `from("profiles").update(`, and
  // it now sits earlier in the concatenation — so the bare indexOf compared
  // saveProfile's flag against a different function's write.
  assert.ok(cloudJs.indexOf('from("profiles").update(', at) > at,
    "and reads it BEFORE the write, since the write is what makes state.profile exist");
  assert.match(cloudJs, /if \(isFirstProfile\) state\.ui\.tab = "feed";/,
    "a first profile lands on the feed");
  // And the sign-out reset must NOT touch it - that is the documented
  // behaviour my first attempt broke.
  const resetAt = cloudJs.indexOf("state.profile = null; state.redemption = null;");
  const resetBlock = cloudJs.slice(resetAt, cloudJs.indexOf("rerender();", resetAt));
  assert.ok(!/state\.ui\.tab\s*=/.test(resetBlock),
    "signing out must leave the sub-tab alone, so a returning member comes back to where they were");
});
