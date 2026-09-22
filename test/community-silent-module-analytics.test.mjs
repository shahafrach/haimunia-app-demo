// One event each for the eleven club_features modules that had a switch, a
// surface and no telemetry at all.
//
// WHY THIS FILE EXISTS. docs/audit/usage-queries.sql query 5 reports two
// different findings in one list and they must never be confused: "members do
// not use this" and "nothing measures this". Until this pass, eleven modules -
// announcements, member_of_week, welcome_flow, monthly_recap, club_wod,
// new_member_posts, post_photos, mentions, outward_share, streak_risk_nudges,
// engagement_alerts - could only ever produce the second, which reads exactly
// like the first and is not evidence of anything.
//
// WHAT THIS FILE VERIFIES
// - Each of the eleven writes its one event, at the surface that is the
//   module's own point, with the documented prop shape.
// - No event carries member-identifying content. The mentioned member on
//   mention_inserted, the recognised member on member_of_week_published and
//   the flagged member on engagement_flag_actioned are the three that would
//   hurt most, and each is checked by name.
// - The map in docs/audit/usage-queries.sql and the table in
//   docs/community/metrics.md both name every new event, in all four places
//   the SQL re-declares its map.
// - The WCAM decisions: exactly two of the fourteen new names count, and the
//   other twelve do not.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const BASE = Date.now() - 5 * 60000;

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true },
      { id: "u9", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, allow_mentions: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    announcements: [], workout_posts: [], feed_page_rows: [], analytics_events: [],
    coach_engagement_flags: [], member_contact_log: [], monthly_club_recaps: [],
    notifications: [], notification_preferences: [], reactions: [], post_comments: [],
    follows: [], hidden_posts: [], saved_posts: [], feed_impressions: [], feed_interactions: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

const events = (mock, name) => mock.db.analytics_events.filter((r) => r.event_name === name);
const plain = (v) => JSON.parse(JSON.stringify(v));
const clickTab = (window, tab) => window.document.querySelector(`[data-community-action="set-tab"][data-tab="${tab}"]`).click();

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}
async function openFeed(window, atLeast = 1) {
  await openCommunity(window);
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 4000);
}
// The one-second dwell the COMM-114 fallback arms on every rendered card
// where there is no IntersectionObserver, which jsdom has not.
const dwell = () => new Promise((r) => setTimeout(r, 1200));

function post(id, extra) {
  return Object.assign({
    id, post_type: "POST_TEXT", author_id: "u9",
    author: { display_name: "נועם", handle: "noam" },
    body: "פוסט", visibility: "club",
    created_at: new Date(BASE).toISOString(), published_at: new Date(BASE).toISOString(),
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  }, extra || {});
}

// ===== announcements ==================================================

test("announcement_viewed fires once per visit with the row count, and never a title", async () => {
  const mock = seeded({
    announcements: [
      { id: "a1", title: "שינוי בלוח הזמנים", body: "האימון של שישי מוקדם בשעה", created_at: VERIFIED, pinned_date: null, priority: "normal", expires_at: null, profiles: { handle: "dana", display_name: "דנה" } },
      { id: "a2", title: "ניקיון בוקס", body: "נשמח לעזרה", created_at: VERIFIED, pinned_date: null, priority: "normal", expires_at: null, profiles: { handle: "dana", display_name: "דנה" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => events(mock, "announcement_viewed").length === 1, 5000);

  const props = plain(events(mock, "announcement_viewed")[0].props);
  assert.deepStrictEqual(props, { rows: 2, source: "feed" });
  assert.ok(!JSON.stringify(props).includes("שינוי"), "an announcement's text never reaches analytics");

  // A re-render of the same visit is not a second view.
  clickTab(window, "directory");
  clickTab(window, "feed");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events(mock, "announcement_viewed").length, 1);
});

test("an empty archive is not a view - 'were there notices' and 'did anyone see them' are the same number", async () => {
  const mock = seeded({ announcements: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => events(mock, "club_tab_viewed").length >= 1, 4000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events(mock, "announcement_viewed").length, 0);
});

// ===== new_member_posts ===============================================

test("new_member_post_viewed rides the feed impression guard: once per welcome card per feed session", async () => {
  const mock = seeded({
    feed_page_rows: [
      post("p1", { post_type: "POST_NEW_MEMBER", author_id: "u9", metadata: { member_id: "u9", member_name: "נועם", joined_on: "2026-09-01" } }),
      post("p2"),
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);
  await dwell();

  await waitFor(() => events(mock, "new_member_post_viewed").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "new_member_post_viewed")[0].props), { source: "feed" });
  // Two cards were impressed; only the welcome card produced this name.
  assert.equal(events(mock, "post_impression").length, 2);
  assert.ok(!JSON.stringify(events(mock, "new_member_post_viewed")[0].props).includes("נועם"),
    "the card is about a named newcomer and the count is the whole question");
});

// ===== welcome_flow ===================================================

test("welcome_sent fires after the comment writes, once, and counts for WCAM", async () => {
  const mock = seeded({
    feed_page_rows: [post("p1", { post_type: "POST_NEW_MEMBER", author_id: "u9", metadata: { member_id: "u9", member_name: "נועם", joined_on: "2026-09-01" } })],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const btn = window.document.querySelector('[data-community-action="welcome-member"][data-id="p1"]');
  assert.ok(btn, "the welcome control renders on the card");
  btn.click();
  await waitFor(() => events(mock, "welcome_sent").length === 1, 4000);
  assert.deepStrictEqual(plain(events(mock, "welcome_sent")[0].props), { source: "feed_card" });
  assert.ok(!JSON.stringify(events(mock, "welcome_sent")[0].props).includes("u9"),
    "who was greeted is the newcomer's business; the count is what the switch is judged on");

  // welcomeNewMember() returns early for a post that already carries the
  // welcome, and that early return sits above the track call.
  window.document.querySelector('[data-community-action="welcome-member"][data-id="p1"]').click();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(events(mock, "welcome_sent").length, 1, "one welcome per newcomer, not one per tap");

  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("welcome_sent"), true,
    "it writes a real comment and bypasses the composer, so nothing else counts it");
});

// ===== mentions =======================================================

test("mention_inserted fires on the pick and carries neither the handle nor the id", async () => {
  const mock = seeded({ feed_page_rows: [post("p1")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-input][data-comment-key="p1"]'), 4000);

  const input = window.document.querySelector('[data-comment-input][data-comment-key="p1"]');
  input.value = "כל הכבוד @no";
  input.selectionStart = input.value.length;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-community-action="mention-pick"]'), 4000);

  window.document.querySelector('[data-community-action="mention-pick"]').click();
  await waitFor(() => events(mock, "mention_inserted").length === 1, 4000);

  const props = plain(events(mock, "mention_inserted")[0].props);
  assert.deepStrictEqual(props, { source: "comment" });
  const json = JSON.stringify(props);
  assert.ok(!json.includes("נועם") && !json.includes("noam") && !json.includes("u9"),
    "who tags whom is a social graph, and analytics_events is readable under community.analytics.view");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("mention_inserted"), false,
    "an abandoned draft must make nobody active for the week");
});

// ===== streak_risk_nudges =============================================

test("streak_nudge_opened fires only for a streak_at_risk notification, beside notification_opened", async () => {
  const mock = seeded({
    notifications: [
      { id: "n1", user_id: "u1", type: "streak_at_risk", category: "training", title: "הרצף שלך בסכנה", body: "לא התאמנת שלושה ימים", deep_link: null, source_type: null, source_id: null, read_at: null, created_at: new Date(BASE).toISOString() },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);

  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => events(mock, "streak_nudge_opened").length === 1, 4000);

  assert.deepStrictEqual(plain(events(mock, "streak_nudge_opened")[0].props), { was_unread: true });
  // THE ONE DELIBERATE DOUBLE. Two modules, two rows, one tap - and the
  // member is counted active exactly once, by the older of the two.
  assert.equal(events(mock, "notification_opened").length, 1);
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("streak_nudge_opened"), false);
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("notification_opened"), true);
  assert.ok(!JSON.stringify(events(mock, "streak_nudge_opened")[0].props).includes("התאמנת"),
    "the nudge's body never reaches analytics");
});

test("an ordinary notification writes no nudge row", async () => {
  const mock = seeded({
    notifications: [
      { id: "n1", user_id: "u1", type: "comment_reply", category: "community", title: "תגובה חדשה", body: "נועם הגיב/ה", deep_link: null, source_type: null, source_id: null, read_at: null, created_at: new Date(BASE).toISOString() },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="feed-notifications"]'), 4000);
  window.document.querySelector('[data-community-action="feed-notifications"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-open"]'), 4000);
  window.document.querySelector('[data-community-action="notif-open"]').click();
  await waitFor(() => events(mock, "notification_opened").length === 1, 4000);
  assert.equal(events(mock, "streak_nudge_opened").length, 0);
});

// ===== engagement_alerts ==============================================

function coachSeeded(extra) {
  const mock = seeded(Object.assign({}, extra));
  mock.db.invite_redemptions[0].role = "coach";
  return mock;
}
async function openCoachTab(window) {
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}

test("engagement_flag_actioned records the action and the level, never the flagged member", async () => {
  const mock = coachSeeded({
    coach_engagement_flags: [{ id: "f1", user_id: "u9", level: "significant", status: "open", flagged_at: VERIFIED }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-engage-review"]'), 5000);

  window.document.querySelector('[data-community-action="coach-engage-review"]').click();
  await waitFor(() => events(mock, "engagement_flag_actioned").length === 1, 4000);

  const props = plain(events(mock, "engagement_flag_actioned")[0].props);
  assert.deepStrictEqual(props, { action: "reviewed", level: "significant" });
  const json = JSON.stringify(props);
  assert.ok(!json.includes("u9") && !json.includes("f1") && !json.includes("נועם"),
    "a table of who the club thinks is drifting away is exactly what this module's server gate keeps narrow");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("engagement_flag_actioned"), false,
    "triaging a queue is staff administration, not community participation");
});

test("dismissing a flag records the dismissal, distinct from a review", async () => {
  const mock = coachSeeded({
    coach_engagement_flags: [{ id: "f1", user_id: "u9", level: "mild", status: "open", flagged_at: VERIFIED }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-engage-dismiss"]'), 5000);

  window.document.querySelector('[data-community-action="coach-engage-dismiss"]').click();
  await waitFor(() => mock.db.coach_engagement_flags[0].status === "dismissed", 4000);
  const props = plain(events(mock, "engagement_flag_actioned")[0].props);
  assert.equal(props.action, "dismissed");
});

// ===== member_of_week =================================================

test("member_of_week_published carries the server-resolved category and which control published", async () => {
  const mock = coachSeeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [{
      week_start: "2026-08-31", category: "most_prs", category_label: "שיאים אישיים השבוע",
      rotation_index: 1, free_selection: false, published: null, previous_week_user_id: null,
      candidates: [{ user_id: "u9", handle: "noam", display_name: "נועם", detail: { pr_count: 3 } }],
    }],
    error: null,
  }));
  let published = false;
  mock.onRpc("member_of_week_publish", () => { published = true; return { data: null, error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 5000);

  window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').click();
  await waitFor(() => events(mock, "member_of_week_published").length === 1, 5000);
  assert.ok(published, "the RPC ran before the row was written");

  const props = plain(events(mock, "member_of_week_published")[0].props);
  assert.deepStrictEqual(props, { category: "most_prs", source: "candidate" });
  assert.ok(!JSON.stringify(props).includes("u9"), "the recognised member is never a prop");
  // Counted for the PUBLISHING COACH, on coach_congratulate_sent's reasoning:
  // the row's user_id is the actor.
  assert.equal(events(mock, "member_of_week_published")[0].user_id, "u1");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("member_of_week_published"), true);
});

test("a refused publish writes no row", async () => {
  const mock = coachSeeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [{
      week_start: "2026-08-31", category: "most_prs", category_label: "שיאים אישיים השבוע",
      rotation_index: 1, free_selection: false, published: null, previous_week_user_id: null,
      candidates: [{ user_id: "u9", handle: "noam", display_name: "נועם", detail: { pr_count: 3 } }],
    }],
    error: null,
  }));
  mock.onRpc("member_of_week_publish", () => ({ data: null, error: { message: "week already published" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 5000);

  window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').click();
  await waitFor(() => window.document.body.textContent.includes("כבר פורסם"), 5000);
  assert.equal(events(mock, "member_of_week_published").length, 0);
});

// ===== monthly_recap ==================================================

test("monthly_recap_viewed fires for the published member card, once per visit", async () => {
  const mock = seeded({
    monthly_club_recaps: [{
      id: "mr1", month_start: "2026-08-01", published_at: VERIFIED,
      sessions_total: 412, members_active: 38, new_members: 5, prs_total: 61, challenges_completed: 9,
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector("[data-monthly-recap-section]"), 5000);
  await waitFor(() => events(mock, "monthly_recap_viewed").length === 1, 4000);

  assert.deepStrictEqual(plain(events(mock, "monthly_recap_viewed")[0].props), { source: "account" });
  clickTab(window, "feed");
  clickTab(window, "account");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events(mock, "monthly_recap_viewed").length, 1, "a re-render of the same visit is not a second view");
  assert.equal(window.HaimuniaAnalytics.isActiveMemberEvent("monthly_recap_viewed"), false);
});

test("no published month means no card and no row", async () => {
  const mock = seeded({ monthly_club_recaps: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  clickTab(window, "account");
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-pref"]'), 5000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(window.document.querySelector("[data-monthly-recap-section]"), null);
  assert.equal(events(mock, "monthly_recap_viewed").length, 0);
});

// ===== the allow-list and the two docs ================================

const NEW_NAMES = [
  "announcement_viewed", "member_of_week_published", "welcome_sent", "monthly_recap_viewed",
  "club_wod_result_attached", "new_member_post_viewed", "post_photo_attached", "mention_inserted",
  "outward_share_completed", "streak_nudge_opened", "engagement_flag_actioned",
  "app_opened", "push_permission", "push_self_test",
];
// The eleven club_features keys, and the event each one is answered by.
const MODULE_EVENT = {
  announcements: "announcement_viewed",
  member_of_week: "member_of_week_published",
  welcome_flow: "welcome_sent",
  monthly_recap: "monthly_recap_viewed",
  club_wod: "club_wod_result_attached",
  new_member_posts: "new_member_post_viewed",
  post_photos: "post_photo_attached",
  mentions: "mention_inserted",
  outward_share: "outward_share_completed",
  streak_risk_nudges: "streak_nudge_opened",
  engagement_alerts: "engagement_flag_actioned",
};

test("every new name is a defined constant with a props allow-list, and every prop is an id, enum, count or boolean", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const a = window.HaimuniaAnalytics;
  const known = Object.values(a.EVENTS);
  for (const name of NEW_NAMES) {
    assert.ok(known.includes(name), `${name} must be in EVENTS`);
    assert.ok(a.HAND_PROP_KEYS[name], `${name} must narrow its props, like every hand-tracked name since COMM-233`);
    assert.ok(a.HAND_PROP_KEYS[name].length > 0);
  }
  // The projection is what makes a leak impossible rather than merely
  // avoided: a call site that attaches a caption gets it dropped.
  const projected = plain(a.projectHandProps("mention_inserted", { source: "comment", display_name: "נועם", user_id: "u9" }));
  assert.deepStrictEqual(projected, { source: "comment" });
  const shared = plain(a.projectHandProps("outward_share_completed", { kind: "pr", result: "shared_image", caption: "כתבתי משהו" }));
  assert.deepStrictEqual(shared, { kind: "pr", result: "shared_image" });
});

test("exactly two of the fourteen new names count toward WCAM, and the other twelve are refused by name", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const a = window.HaimuniaAnalytics;
  const counting = NEW_NAMES.filter((n) => a.isActiveMemberEvent(n));
  assert.deepStrictEqual(counting.sort(), ["member_of_week_published", "welcome_sent"]);
});

test("every one of the eleven modules is mapped in docs/audit/usage-queries.sql, in all four copies of the map", () => {
  const sql = fs.readFileSync(new URL("../docs/audit/usage-queries.sql", import.meta.url), "utf8");
  for (const [module, event] of Object.entries(MODULE_EVENT)) {
    // Query 1's own three-column VALUES row.
    assert.match(sql, new RegExp(`\\('${event}',\\s*'${module}',\\s*true\\)`),
      `query 1 must map ${event} to ${module} as a club_features key`);
    // The CTE the three later queries each re-declare.
    const cteRows = sql.split(`('${event}','${module}')`).length - 1;
    assert.equal(cteRows, 3, `${event} must appear in the module_map CTE of queries 2, 4 and 5 - it is declared three times`);
  }
  // The push names ride the module that already had an event.
  assert.match(sql, /\('push_permission',\s*'push_notifications',\s*true\)/);
  assert.match(sql, /\('push_self_test',\s*'push_notifications',\s*true\)/);
  // app_opened is a session, so it is mapped to shell and excluded from the
  // module queries exactly as club_tab_viewed is.
  assert.match(sql, /\('app_opened',\s*'shell',\s*false\)/);
  assert.match(sql, /not in \('club_tab_viewed', 'app_opened', 'write_failed'\)/);
  // The stale finding is corrected rather than deleted: the file still quotes
  // what it used to say, which is how a reader of an old query result learns
  // why the numbers changed. What must not survive is the CLAIM.
  assert.match(sql, /MODULES THAT EMIT NOTHING\. None,/);
  assert.match(sql, /This block used to read/, "the correction keeps the sentence it corrects");
});

test("docs/community/metrics.md names every new event with its trigger surface and its WCAM answer", () => {
  const doc = fs.readFileSync(new URL("../docs/community/metrics.md", import.meta.url), "utf8");
  for (const name of NEW_NAMES) {
    const row = doc.split("\n").find((l) => l.startsWith(`| \`${name}\``));
    assert.ok(row, `the tracked-events table must carry a row for ${name}`);
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    assert.equal(cells.length, 4, `${name}'s row must fill all four columns`);
    assert.ok(cells[1].length > 10, `${name} must name where it fires from`);
    assert.match(cells[3], /^(yes|no)\b/, `${name} must answer the WCAM column`);
  }
  // The two that count say so in the table as well as in the code.
  assert.match(doc, /\| `welcome_sent` \|[\s\S]*?\| yes \|/);
  assert.match(doc, /\| `member_of_week_published` \|[\s\S]*?\| yes, for the coach \|/);
  // The gate and the self-test are documented, not only implemented.
  assert.ok(doc.includes("## How the app asks for notification permission"));
  assert.ok(doc.includes("## The push self-test"));
});

test("the source names a call site for every new event, so a constant cannot ship unwired", () => {
  const files = [
    "../cloud.js", "../src/community/posts.js", "../src/community/club.js",
    "../src/community/coach-tools.js", "../src/community/comments.js",
    "../src/community/feed.js", "../src/community/notifications.js",
    "../src/community/outward.js",
  ].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  const constantFor = {
    announcement_viewed: "A.ANNOUNCEMENT_VIEWED",
    member_of_week_published: "A.MEMBER_OF_WEEK_PUBLISHED",
    welcome_sent: "A.WELCOME_SENT",
    monthly_recap_viewed: "A.MONTHLY_RECAP_VIEWED",
    club_wod_result_attached: "A.CLUB_WOD_RESULT_ATTACHED",
    new_member_post_viewed: "A.NEW_MEMBER_POST_VIEWED",
    post_photo_attached: "A.POST_PHOTO_ATTACHED",
    mention_inserted: "A.MENTION_INSERTED",
    outward_share_completed: "A.OUTWARD_SHARE_COMPLETED",
    streak_nudge_opened: "A.STREAK_NUDGE_OPENED",
    engagement_flag_actioned: "A.ENGAGEMENT_FLAG_ACTIONED",
    app_opened: "A.APP_OPENED",
    push_permission: "A.PUSH_PERMISSION",
    push_self_test: "A.PUSH_SELF_TEST",
  };
  for (const [name, constant] of Object.entries(constantFor)) {
    assert.ok(files.includes(`track(${constant}`), `${name} must have a real call site, not only a constant`);
  }
  // And the names are never spelled as free text at a call site, which is the
  // whole point of the allow-list living in one file.
  for (const name of NEW_NAMES) {
    assert.ok(!files.includes(`track("${name}"`), `${name} must be reached through the constant`);
  }
});
