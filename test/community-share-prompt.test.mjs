// The share prompt after real training.
//
// THE FEATURE. A member who logs a workout, a PR or an achievement is asked
// once - "לשתף עם המועדון?", share and not now - and the club feed fills
// itself from what people actually did, instead of only from whoever went
// looking for renderShareControl in Calendar or Progress.
//
// THE FOUR RULES THIS FILE GUARDS, and each of them is a rule because the
// alternative is a feature nobody trusts:
//
//   1. NEVER WITHOUT AN EXPLICIT TAP. Opening a prompt writes nothing.
//   2. THE MEMBER CAN TURN IT OFF, in one switch, for all three prompts.
//   3. EVERY PRIVACY TOGGLE IS RESPECTED, in the sense this repo had already
//      settled twice (achievements.js on the outward share, and
//      community-outward-share.test.mjs): the item-level flag and the club's
//      module switches BLOCK a prompt; the profile-wide toggles govern what
//      other members may READ, are enforced server-side, and are SAID OUT
//      LOUD on the prompt rather than used to withhold a member's own
//      deliberate share.
//   4. ONE RECORD, ONE POST. The workout share upserts on the unique
//      (author_id, source_type, source_record_id) triple and the PR share is
//      pr_share(), which upgrades that same row in place (202609060025).
//      Sharing the workout and then the PR for one logged set leaves one
//      card, not two.
//
// Plus the offline half: all three shares ride the community outbox now, so
// a member who trains where there is no signal is not offered a share that
// can only fail.
//
// Everything below boots the real app.js AND the real community layer, so
// the assertions are about the shipped code path rather than a model of it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource, communityFile } from "./helpers/community-src.mjs";

const VERIFIED = new Date().toISOString();

// pr_share(), modelled on the real one where it matters for rule 4:
// 202609060025 finds a prior POST_WORKOUT for the same record and UPGRADES it
// in place rather than inserting a second post. Without that behaviour here
// the no-duplicate test would be asserting against a stub that could not
// fail.
function installPrShare(mock) {
  mock.onRpc("pr_share", (args, ctx) => {
    const rows = ctx.db.workout_posts || (ctx.db.workout_posts = []);
    const existing = rows.find((r) => r.author_id === "u1"
      && (r.source_type === "strength_entry" || r.source_type === "wod_entry")
      && r.source_record_id === args.record_id);
    if (existing) {
      // The upgrade branch (202609060025): the row is rewritten in place and
      // ITS id comes back, which is what makes a repeat share converge. The
      // id is synthesised here only because this mock's upsert stores the
      // client's payload verbatim and the real table generates the column.
      if (!existing.id) existing.id = "upgraded-post-" + rows.indexOf(existing);
      existing.post_type = "POST_PR";
      existing.body = args.note || null;
      return { data: existing.id, error: null };
    }
    const id = "pr-post-" + rows.length;
    rows.push({ id, author_id: "u1", post_type: "POST_PR", source_type: "strength_entry", source_record_id: args.record_id, body: args.note || null });
    return { data: id, error: null };
  });
}

function seeded(profileOverrides) {
  const mock = createMockSupabase({
    profiles: [Object.assign({
      id: "u1", handle: "dana", display_name: "דנה", is_admin: false,
      recovery_verified_at: VERIFIED, visible_to_club: true,
    }, profileOverrides || {})],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
    workout_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  installPrShare(mock);
  mock.onRpc("ach_share", () => ({ data: "ach-post-1", error: null }));
  return mock;
}

async function bootReady(mock, opts) {
  const window = await bootCommunity(mock, Object.assign({ syncEnabled: false }, opts || {}));
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  return window;
}

function logReps(window, weight, reps = 5) {
  window.applyFieldValue("step", "weight", weight);
  window.applyFieldValue("step", "reps", reps);
  window.applyFieldValue("step", "sets", 1);
  return window.saveSet();
}

// A member's first save is a busy moment: the full-screen arrival card (§1.2
// S4), and the "האימון הראשון" medal behind it. The prompt stands down for
// both - which is the point - so every test that wants to see the prompt logs
// one throwaway set first, answers whatever that opened, and then logs the set
// it actually means.
async function clearTheDecks(window, ms = 600) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const overlay = window.document.getElementById("celebrationOverlay");
    if (overlay && overlay.classList.contains("open")) { window.closeCelebration(); continue; }
    const answer = window.document.querySelector('[data-community-action="ach-not-now"], [data-community-action="workout-not-now"], [data-community-action="pr-not-now"]');
    if (answer) { answer.click(); continue; }
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function logPastTheArrivalCard(window, movement) {
  await window.addMovement(movement, "Deadlift");
  await logReps(window, 100);
  await clearTheDecks(window);
}
// The record the prompt was last opened about, read off the key it remembers
// it by - which is also how "asked once, ever, per record" is stored.
function lastOfferedRecordId(window) {
  const raw = window.localStorage.getItem("haimunia-demo:workoutPromptOffered");
  const list = raw ? JSON.parse(raw) : [];
  const last = list[list.length - 1] || "";
  return last.slice(last.indexOf(":") + 1);
}
// Every strength save that beats what is on file announces itself on the
// product bus with the record id app.js just wrote, which is the least
// invasive way for a test to learn what a save was called.
function captureRecordIds(window) {
  const ids = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, (p) => ids.push(p.record.record_id));
  return ids;
}
async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.querySelector("[data-privacy-field]"), 3000);
}
// The switch, flipped the way a member flips it: the checkbox in the Account
// tab, with no save button, exactly like the privacy toggles above it.
async function setSwitch(window, on) {
  await openAccountTab(window);
  const box = window.document.querySelector("[data-share-prompt-pref]");
  assert.ok(box, "the switch must be on the Account tab");
  box.checked = on;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
}

function promptEl(window) { return window.document.getElementById("workoutPrompt"); }
function sharedPosts(mock) { return mock.db.workout_posts || []; }

// ---------------------------------------------------------------------------
// Rule 1 — the prompt itself, and that it never writes on its own
// ---------------------------------------------------------------------------

test("a logged workout asks once, in two words and two buttons, and posts nothing by itself", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Prompt Deadlift");

  await logReps(window, 101);
  await waitFor(() => !!promptEl(window), 3000);

  const p = promptEl(window);
  assert.match(p.textContent, /לשתף עם המועדון\?/, "the question the ticket asks for, verbatim");
  assert.match(p.textContent, /Prompt Deadlift/, "and it names what it is about");
  assert.ok(p.querySelector('[data-community-action="workout-share"]'), "share");
  assert.ok(p.querySelector('[data-community-action="workout-not-now"]'), "not now");
  // Short: the two controls above and nothing else. No note field, no photo
  // uploader, no visibility picker - a question with a form attached is not a
  // question, it is the composer the member did not open.
  assert.equal(p.querySelectorAll("button, input, textarea, select").length, 2);
  assert.equal(sharedPosts(mock).length, 0, "the prompt alone publishes nothing");
});

test("Share is the only thing that writes, and it writes exactly one post", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Share Deadlift");
  await logReps(window, 102);
  await waitFor(() => !!promptEl(window), 3000);

  promptEl(window).querySelector('[data-community-action="workout-share"]').click();
  await waitFor(() => sharedPosts(mock).length === 1, 3000);
  await waitFor(() => !promptEl(window), 3000);

  const post = sharedPosts(mock)[0];
  assert.equal(post.author_id, "u1");
  assert.equal(post.source_type, "strength_entry");
  assert.ok(post.source_record_id, "keyed to the record it is about, which is what makes it de-duplicable");
  assert.match(String(post.result_text), /102/);
});

test("Not now writes nothing and never asks about that record again", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Quiet Deadlift");
  await logReps(window, 103);
  await waitFor(() => !!promptEl(window), 3000);

  promptEl(window).querySelector('[data-community-action="workout-not-now"]').click();
  await waitFor(() => !promptEl(window), 3000);
  assert.equal(sharedPosts(mock).length, 0);

  // Re-offering the SAME record is the nag this remembers its way out of.
  window.offerWorkoutSharePrompt("strength_entry", lastOfferedRecordId(window));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(promptEl(window), null, "asked once, ever, per record");
});

test("Escape maps to Not now, because the prompt is in the dialog registry", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Escape Deadlift");
  await logReps(window, 104);
  await waitFor(() => !!promptEl(window), 3000);

  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !promptEl(window), 3000);
  assert.equal(sharedPosts(mock).length, 0);
});

test("the member's first-ever save gets its arrival card and no share prompt on top of it", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await window.addMovement("Arrival Deadlift", "Deadlift");
  await logReps(window, 100);

  assert.equal(window.document.getElementById("celebrationOverlay").classList.contains("open"), true,
    "the arrival card is unchanged");
  assert.equal(promptEl(window), null, "and the app does not ask for a post in the same breath");
});

// ---------------------------------------------------------------------------
// One prompt per moment
// ---------------------------------------------------------------------------

test("a save that is a real PR gets the PR prompt, and not the workout prompt as well", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await window.addMovement("Both Deadlift", "Deadlift");
  // Three prior entries is what takes a record past `trivial`, so this one
  // opens the PR prompt (see MIN_ENTRIES_BEFORE_PR in app.js).
  for (const kg of [100, 105, 110]) { await logReps(window, kg); await clearTheDecks(window, 200); }
  await logReps(window, 140);

  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  assert.equal(promptEl(window), null, "one moment, one question");
});

test("an unanswered workout prompt is superseded by a newer, richer offer - never stacked under one", async () => {
  // Found by walking it: log a set, leave the prompt up, log another that is
  // a real PR, and the PR prompt sat parked behind a question about the
  // PREVIOUS set. The plain workout offer is the weakest of the three and is
  // about an older moment, so a newer offer replaces it.
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Parked Deadlift");
  await logReps(window, 105);
  await waitFor(() => !!promptEl(window), 3000);

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED,
    { code: "first_pr", member_achievement_id: "ma-1", visibility: "club" });
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  assert.equal(promptEl(window), null, "one prompt on screen, and it is the newer one");

  // And superseding is not a second chance to ask about that record.
  window.document.querySelector('[data-community-action="ach-not-now"]').click();
  await waitFor(() => !window.document.getElementById("achUnlock"), 3000);
  assert.equal(promptEl(window), null);
});

test("an achievement that unlocks while an EARNED prompt is open is parked, not dropped", async () => {
  // The other direction, and the reason superseding is scoped to the workout
  // prompt: the PR prompt and the medal celebration are about something the
  // member earned, and pulling one out from under their thumb to show the
  // other is how a member misses a medal they are never shown again.
  const mock = seeded();
  const window = await bootReady(mock);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-parked", movement: "Parked Squat", new_result: '200 ק"ג' } });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED,
    { code: "first_pr", member_achievement_id: "ma-7", visibility: "club" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(window.document.getElementById("achUnlock"), null, "nothing paints on top of the open prompt");
  assert.ok(window.document.getElementById("prPrompt"), "and the open prompt is not replaced under the member's thumb");

  window.document.querySelector('[data-community-action="pr-not-now"]').click();
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
});

// ---------------------------------------------------------------------------
// Rule 2 — the switch
// ---------------------------------------------------------------------------

test("the Account tab carries the switch, and it is on until the member says otherwise", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await openAccountTab(window);
  assert.equal(window.document.querySelector("[data-share-prompt-pref]").checked, true,
    "no migration, no default row, no onboarding step - a member who has never touched it is asked");
});

test("switching it off stops all three prompts, and closes the one already on screen", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Off Deadlift");
  await logReps(window, 106);
  await waitFor(() => !!promptEl(window), 3000);

  await setSwitch(window, false);
  assert.equal(promptEl(window), null, "the question the member just said to stop asking is not left on screen");
  assert.equal(sharedPosts(mock).length, 0, "switching it off is not a share");

  // The workout prompt.
  await logReps(window, 107);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(promptEl(window), null);

  // The PR prompt.
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-off", movement: "Off Deadlift", new_result: '200 ק"ג' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.getElementById("prPrompt"), null);

  // The achievement celebration.
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-2", visibility: "club" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.getElementById("achUnlock"), null);
});

test("the switch is about being OFFERED a share, never about being ABLE to share", async () => {
  const mock = seeded();
  const window = await bootReady(mock, { localStorage: { "haimunia-demo:sharePromptsOff": "1" } });
  const ids = captureRecordIds(window);
  await logPastTheArrivalCard(window, "Still Deadlift");
  await logReps(window, 108);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(promptEl(window), null, "not asked");

  // The share control the member goes looking for is untouched.
  assert.notEqual(window.renderShareControl("strength_entry", ids[ids.length - 1]), "");

  // And so is the achievement sheet reached by tapping a medal in
  // "ההישגים שלי": shareEarnedAchievement() opens the sheet DIRECTLY rather
  // than through the coordinator, because a switch that says "do not offer"
  // must never disable a control the member pressed.
  const ach = communityFile("src/community/achievements.js");
  assert.match(ach, /function shareEarnedAchievement\(memberAchievementId, code\) \{[\s\S]*?openAchievementUnlockSheet\(/);
  assert.doesNotMatch(ach.slice(ach.indexOf("function shareEarnedAchievement")), /^[\s\S]{0,600}offerSharePrompt/);
});

// ---------------------------------------------------------------------------
// Rule 3 — the privacy toggles
// ---------------------------------------------------------------------------

test("the profile-wide toggles do not withhold a member's own share - they are a server-side read rule", async () => {
  // visible_to_club and show_achievements DEFAULT TRUE, show_workout_results
  // and show_prs DEFAULT FALSE, and all four answer "what may the club read
  // ABOUT me", which the server decides on every read for every viewer. None
  // answers "may I publish": feed_page has no visible_to_club clause, and
  // renderShareControl and the outward sheet have offered the same share
  // under all four since they shipped (see the pinned reasoning in
  // community-outward-share.test.mjs). A gate here would be this one surface
  // inventing a rule the schema does not have - the sibling drift CLAUDE.md
  // is about, not respect for a toggle.
  const mock = seeded({ visible_to_club: false, show_achievements: false, show_prs: false });
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Hidden Deadlift");
  await logReps(window, 109);
  await waitFor(() => !!promptEl(window), 3000);
  promptEl(window).querySelector('[data-community-action="workout-not-now"]').click();
  await waitFor(() => !promptEl(window), 3000);

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-4", visibility: "club" });
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
});

test("the club's achievements module off silences the medal celebration and nothing else", async () => {
  const mock = seeded();
  mock.db.club_features = [{ module_key: "achievements", enabled: false, config: {} }];
  const window = await bootReady(mock);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-5", visibility: "club" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(window.document.getElementById("achUnlock"), null);

  await logPastTheArrivalCard(window, "Medals Deadlift");
  await logReps(window, 110);
  await waitFor(() => !!promptEl(window), 3000);
});

test("show_workout_results off does not block the share - it is stated on the prompt, with the way to change it", async () => {
  // This toggle DEFAULTS FALSE and governs what other members may READ
  // (feed_page strips result_text and the result metadata keys server-side).
  // Blocking on it would make the prompt dead for every member who has never
  // gone and flipped a default, which is all of them; saying nothing would
  // produce a card with the number missing and no explanation.
  const mock = seeded({ show_workout_results: false });
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Redacted Deadlift");
  await logReps(window, 111);
  await waitFor(() => !!promptEl(window), 3000);

  const p = promptEl(window);
  assert.match(p.textContent, /לא את התוצאה עצמה/, "the member is told before they tap, not after");
  assert.ok(p.querySelector('[data-community-action="open-privacy-settings"]'),
    "a LINK to the privacy screen - never a control that flips someone's privacy toggle for them");

  p.querySelector('[data-community-action="workout-share"]').click();
  await waitFor(() => sharedPosts(mock).length === 1, 3000);
  await waitFor(() => !promptEl(window), 3000);

  // THE TWIN. feed_page redacts a POST_PR's figures under the identical
  // show_workout_results rule (202608310006), so the PR prompt - which had no
  // such sentence before this change - carries the same one, from the same
  // definition.
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-redacted", movement: "Other Lift", new_result: '200 ק"ג' } });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  assert.match(window.document.getElementById("prPrompt").textContent, /לא את התוצאה עצמה/);
});

test("show_workout_results on drops the note, rather than telling every member their results are hidden", async () => {
  const mock = seeded({ show_workout_results: true });
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Visible Deadlift");
  await logReps(window, 112);
  await waitFor(() => !!promptEl(window), 3000);
  assert.doesNotMatch(promptEl(window).textContent, /לא את התוצאה עצמה/);
});

test("a club with the feed module switched off is not offered a feed to post into", async () => {
  const mock = seeded();
  mock.db.club_features = [{ module_key: "feed", enabled: false, config: {} }];
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "NoFeed Deadlift");
  await logReps(window, 113);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(promptEl(window), null);
  await openAccountTab(window);
  assert.equal(window.document.querySelector("[data-share-prompt-pref]"), null,
    "and the switch for it is not offered either");
});

test("an achievement whose own visibility is only_me still offers no share control", async () => {
  // Pre-existing item-level privacy, re-asserted here because it is the third
  // kind of toggle rule 3 covers and the one the coordinator does NOT own.
  const mock = seeded();
  const window = await bootReady(mock);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-6", visibility: "only_me" });
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="ach-share"]'), null);
});

// ---------------------------------------------------------------------------
// Rule 4 — one record, one post
// ---------------------------------------------------------------------------

test("sharing the workout and then the PR for one logged set leaves ONE post, upgraded in place", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Upgrade Deadlift");
  await logReps(window, 114);
  await waitFor(() => !!promptEl(window), 3000);
  promptEl(window).querySelector('[data-community-action="workout-share"]').click();
  await waitFor(() => sharedPosts(mock).length === 1, 3000);
  await waitFor(() => !promptEl(window), 3000);
  const recordId = sharedPosts(mock)[0].source_record_id;

  // The PR prompt for the SAME record, the way it arrives when a member logs
  // the set that finally beats their old best.
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, {
    record: { record_id: recordId, movement: "Upgrade Deadlift", new_result: '114 ק"ג × 5' },
  });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="pr-share"]').click();
  await waitFor(() => !window.document.getElementById("prPrompt"), 3000);

  assert.equal(sharedPosts(mock).length, 1, "one record, one post - pr_share upgrades, it does not duplicate");
  assert.equal(sharedPosts(mock)[0].post_type, "POST_PR", "and the card the club sees is the better one");
  assert.equal(mock.callsTo("pr_share")[0].record_id, recordId);
});

test("sharing the same record twice converges on the post that already exists", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Twice Deadlift");
  await logReps(window, 115);
  await waitFor(() => !!promptEl(window), 3000);
  const recordId = lastOfferedRecordId(window);
  promptEl(window).querySelector('[data-community-action="workout-share"]').click();
  await waitFor(() => sharedPosts(mock).length === 1, 3000);

  // The same record shared a second time - the case a lost response, a double
  // tap or a drained outbox row all reduce to.
  window.localStorage.setItem("haimunia-demo:workoutPromptOffered", "[]");
  window.offerWorkoutSharePrompt("strength_entry", recordId);
  await waitFor(() => !!promptEl(window), 3000);
  promptEl(window).querySelector('[data-community-action="workout-share"]').click();
  await waitFor(() => !promptEl(window), 3000);
  assert.equal(sharedPosts(mock).length, 1, "the unique triple is what makes a re-share an update");
});

test("both workout-share callers go through the one write, with the on-conflict target on it", () => {
  // Rule 4 is a property of ONE function. A second copy of this upsert that
  // drifted by an on-conflict clause would publish a duplicate card for every
  // re-share, and "I fixed the one I was shown" is how that copy appears.
  const posts = communityFile("src/community/posts.js");
  const upserts = [...cloudSource().matchAll(/\.upsert\([^)]*onConflict: "author_id,source_type,source_record_id"/g)];
  assert.equal(upserts.length, 2,
    `exactly two: upsertWorkoutSharePost() and publishAchievement()'s own, found ${upserts.length}`);
  assert.match(posts, /function upsertWorkoutSharePost\(payload\) \{\s*\n\s*return client\.from\("workout_posts"\)\.upsert\(payload, \{ onConflict: "author_id,source_type,source_record_id" \}\);/);
  // And every writer of a workout share reaches it through that one function.
  for (const caller of ["shareWorkoutRecord", "workoutShareOutboxHandler"]) {
    const at = posts.indexOf("function " + caller);
    assert.notEqual(at, -1, caller + " must exist");
  }
  assert.match(posts, /const result = await writeWorkoutSharePost\(payload\);/);
  assert.match(posts, /const \{ queued, error \} = await shareWorkoutRecord\(item, visibility, photoPath\);/);
});

// ---------------------------------------------------------------------------
// The offline outbox
// ---------------------------------------------------------------------------

test("a workout shared with no connection is queued, not lost, and lands as one post on reconnect", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  await logPastTheArrivalCard(window, "Offline Deadlift");
  await logReps(window, 116);
  await waitFor(() => !!promptEl(window), 3000);

  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
  promptEl(window).querySelector('[data-community-action="workout-share"]').click();
  await waitFor(async () => (await window.HaimuniaOutbox.list()).length > 0, 3000);

  // Filtered to the member's own writes: going offline also parks whatever
  // telemetry was in flight, and a silent row is not what this is about.
  const queued = (await window.HaimuniaOutbox.list()).filter((r) => !r.silent);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].action, "workout_share");
  assert.equal(queued[0].userId, "u1", "bound to the member who tapped, not to whoever drains it");
  assert.equal(queued[0].silent, false, "a member's share is visible in the outbox banner, unlike telemetry");
  assert.equal(sharedPosts(mock).length, 0, "nothing reached the server while offline");
  await waitFor(() => !promptEl(window), 3000);

  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));
  await waitFor(() => sharedPosts(mock).length === 1, 5000);
  await waitFor(async () => (await window.HaimuniaOutbox.list()).filter((r) => !r.silent).length === 0, 5000);
  assert.equal(sharedPosts(mock)[0].author_id, "u1");
});

test("a PR shared with no connection is queued too - pr_share and ach_share are queueable actions now", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-offline", movement: "Offline Squat", new_result: '200 ק"ג' } });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);

  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
  window.document.querySelector('[data-community-action="pr-share"]').click();
  await waitFor(async () => (await window.HaimuniaOutbox.list()).length > 0, 3000);

  const queued = await window.HaimuniaOutbox.list();
  assert.equal(queued[0].action, "pr_share");
  assert.ok(queued[0].idempotencyKey, "minted once, at enqueue - the whole reason a retry is safe");
  assert.ok(queued[0].args.p_idempotency_key, "and sent to the server, which is why pr_share had to accept one");
  assert.equal(mock.callsTo("pr_share").length, 0);

  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.dispatchEvent(new window.Event("online"));
  await waitFor(() => mock.callsTo("pr_share").length === 1, 5000);
});

test("the queued share is labelled in Hebrew in the outbox banner, never by its action name", () => {
  const src = cloudSource();
  const at = src.indexOf("function outboxActionLabel(action)");
  const body = src.slice(at, src.indexOf("}[action] || ", at));
  for (const action of ["pr_share", "ach_share", "workout_share"]) {
    assert.ok(body.includes(action + ":"), `${action} needs a Hebrew noun, or a member reads a raw identifier`);
  }
});

test("the new module is loaded by index.html and precached by the service worker", () => {
  // CLAUDE.md: a file the app loads and the precache list does not know about
  // breaks the app offline with no signal.
  const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(indexHtml, /<script defer src="\.\/src\/community\/share-prompt\.js"><\/script>/);
  assert.match(sw, /"\.\/src\/community\/share-prompt\.js"/);
});

test("nothing in the share-prompt module writes to the server", () => {
  // Rule 1, as a property of the file rather than of one flow through it: the
  // coordinator decides what to ASK, and asking has no write in it.
  const src = communityFile("src/community/share-prompt.js");
  assert.doesNotMatch(src, /client\.(rpc|from)\(/,
    "the only write behind this prompt is shareWorkoutRecord() in posts.js, reached from a tap");
});
