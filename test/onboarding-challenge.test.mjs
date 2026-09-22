// 202609220002, part 2. The onboarding challenge's client half.
//
// Who is offered it, what a 30-day window looks like on the way through, and
// what happens at the end are all Postgres's, and are proved against real
// rows in supabase/tests/0119_onboarding_challenge_test.sql. What this file
// owns is the three things only a rendered screen can be wrong about:
//
//   * THE CHOICE IS A CHOICE. Two buttons, neither pre-selected, and nothing
//     in the client calls onboarding_challenge_respond() except a tap on one
//     of them. "Never enroll automatically" is enforced in the schema (the
//     container challenge is a draft, so challenge_participants_join_self
//     refuses), but a client that accepted on the member's behalf would make
//     that enforcement irrelevant.
//   * A DECLINE IS FINAL AND SILENT. No card, no nag, no second ask.
//   * THE CONTAINER NEVER SHOWS UP AS A CLUB CHALLENGE. A member cannot read
//     it at all; a coach can, and must not see it listed beside the club's
//     real challenges.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const daysAgoIso = (d) => new Date(NOW - d * 86400000).toISOString();
const ONBOARDING_ID = "0b0a0d17-0000-4000-8000-000000000001";

function seeded(opts) {
  const o = opts || {};
  const features = [
    { club_id: "club-1", module_key: "onboarding_challenge", enabled: o.moduleOn !== false, config: {} },
    { club_id: "club-1", module_key: "challenges", enabled: true, config: {} },
  ];
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(3) },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: o.role || "member", redeemed_at: daysAgoIso(3) }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: features,
    challenges: o.challenges || [],
    challenge_participants: [], challenge_progress: [],
    community_streaks: [], workout_posts: [], feed_page_rows: [],
    analytics_events: [], notifications: [], notification_preferences: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.state = o.state || null;
  mock.onRpc("onboarding_challenge_state", () => ({ data: mock.state, error: null }));
  mock.onRpc("chal_progress", () => ({ data: { participant_count: 0 }, error: null }));
  return mock;
}
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
}
function card(window) { return window.document.querySelector("[data-onboarding-challenge]"); }

test("a new member is offered the challenge, with the goal, the window and two real choices", async () => {
  const window = await bootCommunity(seeded({
    state: { state: "offered", goal_sessions: 8, window_days: 30, challenge_id: ONBOARDING_ID },
  }), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!card(window), 3000);

  assert.equal(card(window).dataset.onboardingChallenge, "offered");
  const text = card(window).textContent;
  assert.match(text, /8 אימונים/, "the goal is stated");
  assert.match(text, /30 הימים/, "and the window");
  // Tone, and it is load-bearing rather than decoration: a first-week member
  // being handed a target needs to be told out loud that declining is fine,
  // or the "choice" reads as an instruction from the gym.
  assert.match(text, /אפשר גם לוותר/, "declining is named as an acceptable answer, not hidden as the quiet option");
  assert.ok(window.document.querySelector('[data-community-action="onboarding-challenge-accept"]'), "accept is offered");
  assert.ok(window.document.querySelector('[data-community-action="onboarding-challenge-decline"]'), "and so is decline");
});

test("NOBODY IS ENROLLED BY LOOKING - rendering the offer calls no write of any kind", async () => {
  const mock = seeded({ state: { state: "offered", goal_sessions: 8, window_days: 30 } });
  let responds = 0;
  mock.onRpc("onboarding_challenge_respond", () => { responds++; return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!card(window), 3000);

  assert.equal(responds, 0, "no accept/decline was sent by the render");
  assert.equal(mock.db.challenge_participants.length, 0, "and no participant row exists");
});

test("accepting sends exactly one respond(true), and only after the tap", async () => {
  const mock = seeded({ state: { state: "offered", goal_sessions: 8, window_days: 30 } });
  const calls = [];
  mock.onRpc("onboarding_challenge_respond", (args) => {
    calls.push(args);
    mock.state = { state: "accepted", goal_sessions: 8, window_days: 30, progress: 0, days_left: 30 };
    return { data: mock.state, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!card(window), 3000);

  window.document.querySelector('[data-community-action="onboarding-challenge-accept"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls, [{ p_accept: true }]);
  await waitFor(() => card(window) && card(window).dataset.onboardingChallenge === "accepted", 3000);
});

test("declining sends respond(false), and the card then disappears for good rather than asking again", async () => {
  const mock = seeded({ state: { state: "offered", goal_sessions: 8, window_days: 30 } });
  const calls = [];
  mock.onRpc("onboarding_challenge_respond", (args) => {
    calls.push(args);
    mock.state = { state: "declined", responded_at: VERIFIED };
    return { data: mock.state, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!card(window), 3000);

  window.document.querySelector('[data-community-action="onboarding-challenge-decline"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls, [{ p_accept: false }]);
  await waitFor(() => !card(window), 3000);
  assert.equal(card(window), null, "a member who said no is not asked a second time, and is not shown a reminder that they said no");
});

test("an accepted challenge shows progress, days left and where the count comes from", async () => {
  const window = await bootCommunity(seeded({
    state: { state: "accepted", goal_sessions: 8, window_days: 30, progress: 3, days_left: 12 },
  }), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!card(window), 3000);
  const text = card(window).textContent;
  assert.equal(card(window).dataset.onboardingChallenge, "accepted");
  assert.match(text, /3 מתוך 8 אימונים/, "progress against the goal");
  assert.match(text, /נשארו 12 ימים/, "and the time left");
  // WHERE THE NUMBER COMES FROM. A member who does not know it counts their
  // own logged sessions will wait for the gym to mark them present.
  assert.match(text, /נספר לבד מכל אימון שנרשם ביומן/, "the card says the count is automatic and what it counts");
  const bar = card(window).querySelector(".progress-track > div");
  assert.ok(bar, "there is a progress bar");
  assert.equal(bar.style.width, "38%", "3 of 8 rounds to 38%");
});

test("the last day and one day left get their own wording", async () => {
  const one = await bootCommunity(seeded({ state: { state: "accepted", goal_sessions: 8, window_days: 30, progress: 1, days_left: 1 } }), { syncEnabled: false });
  await openBoards(one);
  await waitFor(() => !!card(one), 3000);
  assert.match(card(one).textContent, /נשאר יום אחד/, "singular has its own branch");
  assert.ok(!/נשארו 1 ימים/.test(card(one).textContent), "never 'נשארו 1 ימים'");

  const zero = await bootCommunity(seeded({ state: { state: "accepted", goal_sessions: 8, window_days: 30, progress: 7, days_left: 0 } }), { syncEnabled: false });
  await openBoards(zero);
  await waitFor(() => !!card(zero), 3000);
  assert.match(card(zero).textContent, /היום האחרון/, "and so does the last day");
});

test("completing it says so and names the medal; running out of time is not dressed up as a failure", async () => {
  const done = await bootCommunity(seeded({ state: { state: "completed", goal_sessions: 8, window_days: 30, progress: 8, completed_at: VERIFIED } }), { syncEnabled: false });
  await openBoards(done);
  await waitFor(() => !!card(done), 3000);
  assert.equal(card(done).dataset.onboardingChallenge, "completed");
  assert.match(card(done).textContent, /המדליה כבר אצלך/, "the achievement is named as already earned, not as something to claim");

  const expired = await bootCommunity(seeded({ state: { state: "expired", goal_sessions: 8, window_days: 30, progress: 5 } }), { syncEnabled: false });
  await openBoards(expired);
  await waitFor(() => !!card(expired), 3000);
  assert.equal(card(expired).dataset.onboardingChallenge, "expired");
  const text = expired.document.querySelector("[data-onboarding-challenge]").textContent;
  assert.match(text, /5 מתוך 8/, "it reports what was done");
  assert.match(text, /כל אימון נשאר רשום/, "and closes on the training rather than on the shortfall");
  assert.ok(!/נכשל|לא הצלחת/.test(text), "a window closing is not a failure and must not be worded as one");
});

test("a member who is not eligible sees nothing at all - 'none' is not an empty card", async () => {
  const window = await bootCommunity(seeded({ state: { state: "none" } }), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.body.textContent.includes("אתגרי המועדון"), 3000);
  assert.equal(card(window), null, "no shell, no heading, nothing");
});

test("with the module off the card never renders and the RPC is never called", async () => {
  const mock = seeded({ moduleOn: false, state: { state: "offered", goal_sessions: 8, window_days: 30 } });
  let calls = 0;
  mock.onRpc("onboarding_challenge_state", () => { calls++; return { data: mock.state, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.body.textContent.includes("אתגרי המועדון"), 3000);
  assert.equal(card(window), null, "no card");
  assert.equal(calls, 0, "and the module gate is checked before the read, not after it");
});

test("the container challenge is never listed beside the club's real challenges, not even for a coach", async () => {
  // A member cannot read it at all (challenges_read hides a draft), but a
  // community.challenge.create holder can - and renderChallengesListSection
  // deliberately lists a staff member's own drafts. Without the metric_type
  // filter, every coach's board would carry a permanent "אתגר הכניסה"
  // container card that nobody may open, publish or delete.
  const mock = seeded({
    role: "coach",
    challenges: [
      { id: ONBOARDING_ID, club_id: "club-1", title: "אתגר הכניסה", challenge_type: "consistency", metric_type: "onboarding_first_30_days", status: "draft", start_at: daysAgoIso(10), end_at: "2099-12-31T00:00:00+00", target_value: 8, visibility: "club", created_by: null, config: { onboarding: true } },
      { id: "c-real", club_id: "club-1", title: "מרתון הסקוואט", challenge_type: "cooperative", metric_type: "reps", status: "active", start_at: daysAgoIso(5), end_at: new Date(NOW + 5 * 86400000).toISOString(), target_value: 1000, visibility: "club", created_by: "u1", config: {} },
    ],
    state: { state: "none" },
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => window.document.body.textContent.includes("מרתון הסקוואט"), 3000);
  const boards = window.document.body.textContent;
  assert.ok(!/אתגר הכניסה/.test(boards), "the container is filtered out of the list");
  assert.match(boards, /מרתון הסקוואט/, "and the club's real challenge is still there - the filter is on metric_type, not on 'hide drafts'");
});
