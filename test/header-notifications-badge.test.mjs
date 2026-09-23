// Fresh-eyes audit: the one always-visible header control (every screen,
// not just Community) was wired only to the offline "what's new" release
// notes. A member could have unread reactions/comments/achievement
// notifications sitting behind the Community tab's own small bell chip and
// never see any signal for it anywhere else. Real community notifications
// now take priority on the header; release notes moved into Settings as
// their own permanent row. This file covers both halves of that fix: the
// cloud.js bridge (window.communityUnreadCount / window.openCommunityNotifCenter)
// and app.js's header routing (updateNotificationsBadge / openHeaderNotifications),
// plus that Settings' own "מה חדש" row is unaffected by social unread state.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function baseSeed(extra) {
  return Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  }, extra || {});
}

test("no community configured: header badge falls back to release notes, no bridge functions exist", async () => {
  const window = await bootApp();
  assert.equal(typeof window.communityUnreadCount, "undefined", "cloud.js never loaded in this boot");
  // Must not throw with the bridge absent.
  window.updateNotificationsBadge();
  const badge = window.document.getElementById("notificationsBadge");
  assert.ok(badge, "badge element exists regardless of community state");
});

test("signed into community with unread notifications: header badge shows the social count and aria-label names it", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [
      { id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED },
      { id: "n2", user_id: "u1", type: "comment", read_at: null, created_at: VERIFIED },
    ],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 2, 3000);

  window.updateNotificationsBadge();
  const badge = window.document.getElementById("notificationsBadge");
  assert.equal(badge.style.display, "flex");
  assert.equal(badge.textContent, "2");
  const btn = window.document.getElementById("notificationsBellBtn");
  assert.match(btn.getAttribute("aria-label"), /2 חדשות/);
});

test("tapping the header bell with unread community notifications opens the notification center, not the changelog", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [{ id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED }],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 1, 3000);

  window.document.getElementById("notificationsBellBtn").click();
  await waitFor(() => !!window.document.querySelector("[data-notif-center]"), 3000);
  assert.ok(window.document.querySelector("[data-notif-center]"), "the real notification center opened");
  // The offline release-notes overlay must specifically NOT be the one that opened.
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), false,
    "the changelog overlay must not open when there is real community unread");
});

test("no unread community notifications: the header bell still serves UNSEEN release notes", async () => {
  const mock = createMockSupabase(baseSeed({ notifications: [] }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => typeof window.communityUnreadCount === "function" && window.communityUnreadCount() === 0, 3000);

  // A device that has not caught up. bootCommunity() starts fresh, which the
  // app bootstraps to "already current", so the catch-up state has to be set
  // up rather than assumed - and it is the state this test is actually about.
  await window.dbSetSetting("haimunia-demo:lastSeenVersion", "0.0.0");
  await window.loadLastSeenVersion();
  assert.ok(window.unseenReleaseNotes().length > 0, "the fixture must have something unseen to serve");

  window.document.getElementById("notificationsBellBtn").click();
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), true,
    "with nothing unread in Community but release notes unseen, the header bell serves them");
});

// THIS TEST REPLACES THE SECOND HALF OF THE ONE ABOVE, which used to assert
// that the bell opens the release-notes overlay with nothing unread FULL
// STOP - including when there is nothing unseen either. That is the defect
// reported from a real phone: "the מה חדש sheet opens with only אין עדכונים
// חדשים". A member whose badge is counting community notifications the
// centre cannot open (signed out of it, module off, not configured) tapped a
// badge saying three things were waiting and got a full-screen changelog
// saying nothing was.
//
// The property the old assertion was defending - that the bell is not dead
// when Community has nothing to say - is kept, and is what the test above
// now proves. What changed is the empty case.
test("nothing unread and nothing unseen: the bell answers, and does not open an empty changelog", async () => {
  const mock = createMockSupabase(baseSeed({ notifications: [] }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => typeof window.communityUnreadCount === "function" && window.communityUnreadCount() === 0, 3000);
  assert.equal(window.unseenReleaseNotes().length, 0, "a fresh device is bootstrapped as already caught up");

  window.document.getElementById("notificationsBellBtn").click();
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), false,
    "an empty changelog is not an answer to a notifications tap");
  assert.match(window.document.getElementById("appToastDock").textContent, /אין התראות/,
    "but the tap is answered rather than swallowed");
});

test("Settings' own 'מה חדש' row always opens release notes, even with unread community notifications pending", async () => {
  const mock = createMockSupabase(baseSeed({
    notifications: [{ id: "n1", user_id: "u1", type: "reaction", read_at: null, created_at: VERIFIED }],
  }));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityUnreadCount && window.communityUnreadCount() === 1, 3000);

  window.document.getElementById("navMenuBtn").click();
  window.document.querySelector("[data-action='open-settings']").click();
  const row = window.document.querySelector("[data-action='open-release-notes']");
  assert.ok(row, "Settings renders a dedicated release-notes row");
  row.click();
  assert.equal(window.document.getElementById("notificationsOverlay").classList.contains("open"), true,
    "Settings' changelog row must always mean release notes, never Community's notification center");
});
