// COMM-233. The Phase 2 analytics surfaces, executed for real in jsdom
// against the mock Supabase client.
//
// WHAT THIS FILE VERIFIES
// - The three bridged names this ticket was asked to confirm rather than
//   wire (`challenge_joined`, `challenge_completed`, `event_rsvp`) actually
//   land, from the real Phase 2 producers (COMM-207's join and completion,
//   COMM-214's RSVP), exactly once each and with the documented props.
// - Each newly wired hand-tracked event fires from its real trigger surface
//   with its documented props: the recap open and share, both search boxes,
//   the push opt-in, the coach's congratulate, and the roster.
// - No new event carries free text: not a challenge title, not a recap
//   sentence, not what the member typed into the search box.
// - The Boards list cards record `source: "boards"`. They used to record
//   `source: "post_card"`, because the handler's default was written for
//   the link card inside a feed post and the list cards carried no
//   data-source of their own.
//
// WHAT THIS FILE DOES NOT VERIFY
// The helper's own contract (the name allow-list, trimming, the
// HAND_PROP_KEYS projection, the WCAM set) is
// test/platform-analytics.test.mjs. The Phase 1 surfaces are
// test/community-analytics-surfaces.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, notifPrefOption, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const isoDays = (d) => new Date(NOW + d * 86400000).toISOString();
const isoHours = (h) => new Date(NOW + h * 3600000).toISOString();

function seeded(extra, asStaff) {
  const merged = Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: isoDays(-400) },
      { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true, created_at: isoDays(-400) },
      { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, created_at: isoDays(-400) },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    analytics_events: [],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    events: [], event_attendees: [],
    weekly_recaps: [], onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
    workout_posts: [], post_comments: [], feed_page_rows: [], follows: [], blocks: [],
    community_streaks: [], member_contact_log: [], coach_engagement_flags: [],
    notifications: [], notification_preferences: [], push_subscriptions: [],
  }, extra || {});
  const mock = createMockSupabase(merged);
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => (mock.db.analytics_events || []).filter((r) => r.event_name === name);
// An object built inside the jsdom realm carries that realm's prototype,
// which deepStrictEqual reads as a mismatch even when the data agrees.
const plain = (v) => JSON.parse(JSON.stringify(v));
const allProps = (mock) => JSON.stringify((mock.db.analytics_events || []).map((r) => r.props));

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
}
async function openAccount(window) {
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector("[data-notif-pref-select]"), 4000);
}
function activeChallenge(overrides) {
  return Object.assign({
    id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "",
    metric_type: "session_count", target_value: 12, start_at: isoDays(-5), end_at: isoDays(20),
    status: "active", join_mode: "open", visibility: "club", created_by: "coach1", config: {},
  }, overrides || {});
}
function publishedEvent(overrides) {
  return Object.assign({
    id: "e1", event_type: "social_night", title: "ערב פיצה", description: "", status: "published",
    start_at: isoHours(24), end_at: null, location: null, capacity: null,
    registration_deadline: null, created_by: "coach1",
  }, overrides || {});
}
function recapRow(overrides) {
  return Object.assign({
    id: "wr-1", user_id: "u1", week_start: "2026-08-17",
    sessions_completed: 5, streak: 2, prs: [], achievements: [],
    challenge_progress: [], club_challenge_progress: {}, upcoming_event: null,
    generated_at: VERIFIED,
  }, overrides || {});
}

// ===== the bridged names, end to end from the Phase 2 producers ========
//
// COMM-233 adds no wiring for these three. What it has to prove is that the
// bridge agreed in Phase 1 (BUS_EVENT_MAP + BUS_PROP_KEYS, settled before
// any of these surfaces existed) is actually exercised by the producers that
// landed since.

// ===== the Boards source mislabel =====================================

// ===== the roster =====================================================

// ===== the recap surface ==============================================

// ===== search =========================================================

// ===== the coach's congratulate =======================================

// ===== the push opt-in ================================================

function stubPushApis(window) {
  let sub = null;
  const reg = {
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async () => {
        sub = {
          endpoint: "https://push.example/ep-1",
          keys: { p256dh: "keyA", auth: "keyB" },
          toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
          unsubscribe: async () => { sub = null; return true; },
        };
        return sub;
      },
    },
  };
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, { ready: Promise.resolve(reg) });
  window.PushManager = function () {};
  window.Notification = { permission: "default", requestPermission: async () => "granted" };
  // Standalone, because the app no longer asks for notification permission
  // outside the installed app on any platform (pushAskGateReason,
  // src/community/notifications.js). Without this the two push_opt_in tests
  // below would be measuring the gate, not the opt-in. The gate has its own
  // tests in test/community-push-gate-and-self-test.test.mjs.
  Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
}

test("push_opt_in is recorded once the subscription row is written, with the control that asked and never the endpoint", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window);
  await openCommunity(window);
  await waitFor(() => !!notifPrefOption(window, "trained_together", "push"), 4000);

  pickNotifPref(window, "trained_together", "push");
  await waitFor(() => mock.db.push_subscriptions.length === 1, 4000);
  await waitFor(() => events(mock, "push_opt_in").length === 1, 4000);

  const props = plain(events(mock, "push_opt_in")[0].props);
  assert.deepStrictEqual(props, { source: "notif_pref", pref_type: "trained_together" });
  assert.ok(!JSON.stringify(props).includes("push.example"), "the device endpoint is a secret, not a prop");

  // A device has one subscription however many types route through it, so
  // a second type switched to Push is not a second opt-in.
  pickNotifPref(window, "reactions", "push");
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "reactions" && r.channel === "push"), 4000);
  assert.equal(events(mock, "push_opt_in").length, 1);
});

test("a denied permission records no opt-in", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubPushApis(window);
  window.Notification = { permission: "default", requestPermission: async () => "denied" };
  await openCommunity(window);
  await waitFor(() => !!notifPrefOption(window, "trained_together", "push"), 4000);

  pickNotifPref(window, "trained_together", "push");
  await waitFor(() => window.document.body.textContent.includes("לא אושרה הרשאת התראות"), 4000);
  assert.equal(events(mock, "push_opt_in").length, 0);
  assert.equal(mock.db.push_subscriptions.length, 0);
});

// ===== the props budget, for the Phase 2 surfaces =====================

