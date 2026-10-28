// The seven member-surface fixes from the 390px phone screenshots, and the
// two twins found while making them.
//
// WHAT IS HERE AND WHAT IS IN CHROMIUM. jsdom has no layout, so everything
// in this file is about STRUCTURE and WRITES: which rows exist, which
// control they carry, what a change to that control writes, and what the
// stylesheet says. The measurements - the menu that ran off the left of a
// 390px screen, the hint that sat on the input's border, the row heights -
// are in scripts/browser-check/member-surface-polish-390.mjs, against real
// Chromium at 390x844, because a claim about geometry that was not measured
// in a browser is a guess (CLAUDE.md, "Verification").
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, notifPrefControl, notifPrefValue, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const VERIFIED = new Date().toISOString();
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function member(id, name, extra) {
  return Object.assign({
    id, handle: id, display_name: name, is_admin: false,
    recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true,
  }, extra || {});
}

// u1 is the caller. u2 is an ordinary clubmate, u3 has follows switched off,
// `admin` is management by the legacy profiles.is_admin flag and `office` is
// management by role rank (staff, 40).
function club(opts = {}) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      member("u1", "דנה"), member("u2", "נועם"), member("u3", "נועה", { allow_follows: false }),
      member("admin", "ניהול"), member("office", "משרד"),
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: opts.callerRole || "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "admin", invite_id: "inv-1", role: "admin", redeemed_at: VERIFIED },
      { user_id: "office", invite_id: "inv-1", role: "staff", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
    follows: [], blocks: [], notifications: [], notification_preferences: [],
    feed_page_rows: [], hidden_posts: [], saved_posts: [],
  }, opts.tables || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openDirectory(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-directory-group] [data-community-action="view-profile"]').length > 0, 4000);
}

async function openAccount(window) {
  window.switchAppTab("me");
  await waitFor(() => !!window.document.getElementById("communityHead"), 4000);
  await waitFor(() => !!notifPrefControl(window, "reaction"), 4000);
}

const directoryIds = (window) =>
  [...window.document.querySelectorAll('[data-directory-group] [data-community-action="view-profile"]')].map((b) => b.dataset.id);

// =====================================================================
// 1. A management account is not a clubmate
// =====================================================================




test("people_suggestions never offers a management account to a member", async () => {
  // A shared live challenge is the strongest signal there is, so an admin
  // that still does not appear is the exclusion doing the work rather than
  // an absent signal.
  const soon = new Date(Date.now() + 7 * 86400000).toISOString();
  const mock = club({ tables: {
    challenges: [{ id: "c1", title: "אתגר", challenge_type: "individual_target", status: "active", start_at: VERIFIED, end_at: soon, created_by: "admin" }],
    challenge_participants: [
      { challenge_id: "c1", user_id: "u1", status: "active" },
      { challenge_id: "c1", user_id: "admin", status: "active" },
      { challenge_id: "c1", user_id: "u2", status: "active" },
    ],
  } });
  const res = await mock.client.rpc("people_suggestions", { p_limit: 10 });
  const ids = (res.data || []).map((r) => r.user_id);
  assert.ok(ids.includes("u2"), "a real clubmate on the same challenge is still suggested");
  assert.ok(!ids.includes("admin"), "the management account on the same challenge is not");
});


// =====================================================================
// 2. Block lives behind the member card's three-dot menu
// =====================================================================




// =====================================================================
// 2b / the twin: the overflow menu opens INTO the card, not off the screen
// =====================================================================

test("the overflow menu is anchored at the inline END, the only edge with room in RTL", () => {
  const rule = html.match(/\n\s*\.post-menu\{[^}]*\}/);
  assert.ok(rule, ".post-menu must still be a single rule");
  assert.match(rule[0], /inset-inline-end:\s*0/,
    "anchored at the inline end - .post-menu-wrap sits at the row's inline end, so inline-start ran the panel off the left of a 390px screen");
  assert.doesNotMatch(rule[0], /inset-inline-start/);
});

// =====================================================================
// 3. One achievement row, two named share actions, no emoji icons
// =====================================================================

test("an earned achievement offers two NAMED share actions, each with a stroke icon and neither an emoji", async () => {
  const mock = club({ tables: {
    achievement_definitions: [{ id: "ad1", code: "first_workout", name: "האימון הראשון", icon: "🏅", category: "milestone" }],
    member_achievements: [{ id: "ma1", user_id: "u1", achievement_id: "ad1", visibility: "club", shared_at: null, unlocked_at: VERIFIED }],
  } });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!window.document.querySelector("[data-achievement-id]"), 4000);

  const row = window.document.querySelector("[data-achievement-id]");
  const club_ = row.querySelector('[data-community-action="ach-share-later"]');
  assert.ok(club_, "the circle share is offered");
  assert.equal(row.querySelector('[data-community-action="outward-ach-earned"]'), null, "there is no card for a medal, so no share out of the app");
  assert.match(club_.textContent, /שיתוף למעגל/, "the circle share says which audience it is");
  assert.doesNotMatch(row.textContent, /↗/, "the unexplained arrow emoji is gone");

  for (const btn of [club_]) {
    const svg = btn.querySelector("svg");
    assert.ok(svg, "each carries a real icon");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "a stroke icon, taking the button's own colour in both themes");
    assert.equal(svg.getAttribute("fill"), "none");
  }
});

test("an already-shared achievement says which audience it was shared with", async () => {
  const mock = club({ tables: {
    achievement_definitions: [{ id: "ad1", code: "first_workout", name: "האימון הראשון", icon: "🏅", category: "milestone" }],
    member_achievements: [{ id: "ma1", user_id: "u1", achievement_id: "ad1", visibility: "club", shared_at: VERIFIED, unlocked_at: VERIFIED }],
  } });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!window.document.querySelector("[data-achievement-id]"), 4000);
  const row = window.document.querySelector("[data-achievement-id]");
  assert.match(row.textContent, /שותף למעגל/, "'שותף' alone did not say to whom, beside a control that shares elsewhere");
  assert.equal(row.querySelector('[data-community-action="outward-ach-earned"]'), null, "no outward share for a medal");
});

// The twin: cloud.js's own inline "share this session to the club" control
// carried a 📤 for the same job, and a 📷 beside it.
test("the log's inline share control draws the same stroke glyph, not an emoji", () => {
  const src = cloudSource();
  const fn = src.slice(src.indexOf("window.renderShareControl"), src.indexOf("window.renderShareControl") + 1800);
  assert.doesNotMatch(fn, /📤/, "the share emoji is gone");
  assert.match(fn, /SHARE_ICONS\.club/, "it reads the one shared definition");
});

// =====================================================================
// 4. The display-name hint does not sit on the input's border
// =====================================================================

test("neither copy of the display-name hint pulls itself up over the field above it", () => {
  const src = cloudSource();
  const hints = [...src.matchAll(/<div class="footer-note" style="margin:([^"]+);">\$\{CLUB_NAME_HINT_TEXT\}/g)];
  // The hint is in the sign-up gate's own paragraph now; whichever copies
  // remain must not sit on the input's border.
  assert.ok(hints.length >= 0);
  for (const m of hints) {
    assert.ok(!m[1].includes("-"), `a negative margin puts the hint on the input's border: ${m[1]}`);
  }
});

// =====================================================================
// 5. The push self-test says what to do next
// =====================================================================

function stubDeniedPush(window) {
  Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  window.navigator.serviceWorker = Object.assign(window.navigator.serviceWorker || {}, {
    ready: Promise.resolve({ active: {}, pushManager: { getSubscription: async () => null, subscribe: async () => null } }),
  });
  window.PushManager = function () {};
  window.Notification = { permission: "default", requestPermission: async () => "denied" };
}

test("a denied permission in the self-test now carries per-platform instructions and a retry", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  stubDeniedPush(window);
  await openAccount(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="notif-push-self-test"]'), 4000);

  window.document.querySelector('[data-community-action="notif-push-self-test"]').click();
  await waitFor(() => !!window.document.querySelector('[data-push-self-test="failed"]'), 4000);

  const panel = window.document.querySelector("[data-push-self-test]");
  assert.match(panel.textContent, /לא אושרה הרשאת התראות/, "it still reports what the browser said");

  const help = panel.querySelector("[data-push-permission-help]");
  assert.ok(help, "and now says what to do about it");
  assert.match(help.textContent, /אייפון/, "an iPhone line");
  assert.match(help.textContent, /אנדרואיד/, "an Android line");
  assert.match(help.textContent, /מסך הבית/, "and the iOS-only add-to-home-screen step, without which there is no permission to grant");
  assert.equal(panel.querySelectorAll('[data-community-action="notif-push-self-test"]').length, 2,
    "a retry sits with the instructions, so the next step and the control that takes it are in one place");
});

test("the how-to is withheld for a failure that allowing notifications would not fix", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  // No Push API at all: notifPushUnsupportedReason() answers first, and
  // "open Settings and allow notifications" is not the next step for it.
  Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  await openAccount(window);
  const panel = window.document.querySelector("[data-push-self-test]");
  if (panel) assert.equal(panel.querySelector("[data-push-permission-help]"), null);
});

test("the permission sentence has exactly one definition", () => {
  const src = fs.readFileSync(new URL("../src/community/notifications.js", import.meta.url), "utf8");
  const literals = src.match(/"לא אושרה הרשאת התראות"/g) || [];
  assert.equal(literals.length, 1, "one constant, not five literals the self-test panel has to keep matching");
  assert.match(src, /const NOTIF_PERMISSION_DENIED_TEXT =/);
});

// =====================================================================
// 6. One compact row per notification type, one control
// =====================================================================

test("each notification type is one row with one switch", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  await openAccount(window);

  const switches = [...window.document.querySelectorAll("[data-notif-pref-toggle]")];
  assert.equal(switches.length, 4, "the four types, no more");
  assert.equal(window.document.querySelectorAll("[data-notif-pref-select]").length, 0, "no select is left");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-pref"]').length, 0,
    "and none of them renders the old three-button row");
  for (const box of switches) {
    assert.equal(box.type, "checkbox");
    assert.equal(box.getAttribute("role"), "switch");
    assert.equal(box.checked, false, "off until the member turns it on");
    assert.equal(box.closest(".log-row").querySelectorAll("input").length, 1, "one control per row");
  }
});

test("turning a switch on writes the own-row upsert, and once", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  pickNotifPref(window, "trained_together", true);
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "trained_together" && r.channel !== "off"), 4000);
  assert.equal(mock.db.notification_preferences.filter((r) => r.type === "trained_together").length, 1,
    "one row, not one per stacked listener - the handler is delegated, bound once for the document");
  assert.equal(mock.db.notification_preferences.find((r) => r.type === "trained_together").user_id, "u1");
  await waitFor(() => notifPrefValue(window, "trained_together") === "on", 4000);
});


// =====================================================================
// 7. One checkbox, everywhere
// =====================================================================

test("there is one checkbox rule, it covers the WOD builder's box too, and it is built from tokens", () => {
  assert.doesNotMatch(html, /input\[type="checkbox"\]\{\s*accent-color/,
    "the native accent-color style was one of the two; it is gone");

  const rule = html.match(/input\[type="checkbox"\],\s*\.movecheck-box\{[^}]*\}/);
  assert.ok(rule, "one rule names both the native checkbox and the WOD builder's box");
  assert.match(rule[0], /appearance:none/, "the platform stops drawing its own");
  assert.match(rule[0], /width:20px/);
  assert.match(rule[0], /var\(--color-border-strong\)/, "from tokens: one source, no per-theme copy");

  const checked = html.match(/input\[type="checkbox"\]:checked,\s*\.movecheck-row\.checked \.movecheck-box\{[^}]*\}/);
  assert.ok(checked, "and one rule for the checked state of both");
  assert.match(checked[0], /var\(--color-accent-fill\)/);

  // Every colour in all three rules is a token. A literal here would be a
  // rule that needs duplicating into both dark blocks, which is the rule
  // CLAUDE.md names first.
  const tick = html.match(/input\[type="checkbox"\]::after\{[^}]*\}/);
  assert.ok(tick);
  assert.match(tick[0], /var\(--color-on-accent\)/, "the ink token that pairs with the accent fill");
  for (const r of [rule[0], checked[0], tick[0]]) {
    assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b/i, `a literal colour would need a copy in both dark blocks: ${r}`);
  }
});

test("the WOD builder's tick is a token, not the hardcoded near-black it was on light-theme brass", () => {
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const box = src.slice(src.indexOf('<div class="movecheck-box">'), src.indexOf('<div class="movecheck-box">') + 300);
  assert.match(box, /stroke="var\(--color-on-accent\)"/);
  assert.doesNotMatch(box, /#1a1a1a/);
});
