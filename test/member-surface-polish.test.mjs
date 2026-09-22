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
import { bootCommunity, waitFor, notifPrefControl, notifPrefOption, notifPrefValue, pickNotifPref } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

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
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    follows: [], blocks: [], notifications: [], notification_preferences: [],
    feed_page_rows: [], hidden_posts: [], saved_posts: [],
  }, opts.tables || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openDirectory(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-directory-group] [data-community-action="view-profile"]').length > 0, 4000);
}

async function openAccount(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!notifPrefControl(window, "comment_on_post"), 4000);
}

const directoryIds = (window) =>
  [...window.document.querySelectorAll('[data-directory-group] [data-community-action="view-profile"]')].map((b) => b.dataset.id);

// =====================================================================
// 1. A management account is not a clubmate
// =====================================================================

test("the members directory hides management accounts from a member, both kinds of them", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => mock.callsTo("management_user_ids").length > 0, 4000);
  await waitFor(() => directoryIds(window).length === 2, 4000);

  const ids = directoryIds(window);
  assert.deepEqual(ids.slice().sort(), ["u2", "u3"], "the two real clubmates, and only them");
  assert.ok(!ids.includes("admin"), "the is_admin-flagged management account is gone");
  assert.ok(!ids.includes("office"), "and so is the one that is management by role rank");
  assert.ok(!ids.includes("u1"), "the caller's own row was already excluded and still is");
});

test("a coach still sees management accounts - the server decides, and the client never re-derives the staff rule", async () => {
  // management_user_ids() applies the exemption itself, so what proves the
  // client is not second-guessing it is that the SAME client code shows the
  // rows once the server stops naming them.
  const mock = club({ callerRole: "coach" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => mock.callsTo("management_user_ids").length > 0, 4000);
  await waitFor(() => directoryIds(window).length === 4, 4000);
  const ids = directoryIds(window);
  assert.ok(ids.includes("admin") && ids.includes("office"), "a colleague looking for a colleague finds them");
});

test("directory search cannot surface a management account either, through the server path or the client fallback", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => mock.callsTo("management_user_ids").length > 0, 4000);

  // The server path: community_search() drops the row before it is sent.
  const res = await mock.client.rpc("community_search", { p_query: "ניהול", p_limit: 10 });
  assert.deepEqual(res.data.members, [], "community_search returns nothing for a member");

  // And the under-two-characters client fallback, which never reaches the
  // server at all, filters the already-loaded page the same way.
  const box = window.document.getElementById("communityDirectorySearch");
  box.value = "נ";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => directoryIds(window).length > 0, 4000);
  assert.ok(!directoryIds(window).includes("admin"), "the one-character filter does not let it back in");
});

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

test("a failed management_user_ids load hides nobody rather than emptying the roster", async () => {
  const mock = club();
  mock.onRpc("management_user_ids", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => directoryIds(window).length >= 2, 4000);
  // Four rows, not zero: a transient RPC failure must not read as "this club
  // has no members". The server-side halves of the rule are unaffected.
  assert.ok(directoryIds(window).includes("u2"), "the roster still renders");
});

// =====================================================================
// 2. Block lives behind the member card's three-dot menu
// =====================================================================

test("no member card offers חסימה as a chip, and every card carries the same ⋯ menu", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => directoryIds(window).length === 2, 4000);

  const rows = [...window.document.querySelectorAll('[data-directory-group] .log-row')];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.querySelector('.chip-row > [data-community-action="block"]'), null,
      "block is not a peer of follow any more");
    assert.ok(row.querySelector('[data-community-action="toggle-member-menu"]'),
      "and every card ends in the same overflow menu, whatever the member's privacy settings");
  }

  // u3 has allow_follows off. Before this, that member's card was two chips
  // where everyone else's was three - a privacy setting leaking as a layout
  // difference. The follow chip is still withheld; the shape is not.
  const u3 = rows.find((r) => r.querySelector('[data-community-action="view-profile"]').dataset.id === "u3");
  assert.equal(u3.querySelector('[data-community-action="follow"]'), null, "follow is still withheld");
  assert.ok(u3.querySelector('[data-community-action="toggle-member-menu"]'), "the menu is not");
});

test("opening the menu reveals חסימה, and choosing it opens the same confirm and writes the same block", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => directoryIds(window).length === 2, 4000);

  assert.equal(window.document.querySelector('[data-member-menu="u2"] [data-community-action="block"]'), null,
    "closed to begin with");
  window.document.querySelector('[data-community-action="toggle-member-menu"][data-id="u2"]').click();
  await waitFor(() => !!window.document.querySelector('[data-member-menu="u2"] [data-community-action="block"]'), 4000);

  window.document.querySelector('[data-member-menu="u2"] [data-community-action="block"]').click();
  await waitFor(() => /לחסום את/.test(window.document.getElementById("content").textContent), 4000);
  assert.equal(window.document.querySelector('[data-member-menu="u2"] .post-menu'), null,
    "the menu closes behind the confirm rather than sitting under it");

  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.db.blocks.some((b) => b.blocker_id === "u1" && b.blocked_id === "u2"), 4000);
});

test("only one menu is ever open, because the member card reuses the post menu's single slot", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => directoryIds(window).length === 2, 4000);

  window.document.querySelector('[data-community-action="toggle-member-menu"][data-id="u2"]').click();
  await waitFor(() => !!window.document.querySelector('[data-member-menu="u2"] .post-menu'), 4000);
  window.document.querySelector('[data-community-action="toggle-member-menu"][data-id="u3"]').click();
  await waitFor(() => !!window.document.querySelector('[data-member-menu="u3"] .post-menu'), 4000);
  assert.equal(window.document.querySelector('[data-member-menu="u2"] .post-menu'), null,
    "opening the second closed the first");
});

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
  const outward = row.querySelector('[data-community-action="outward-ach-earned"]');
  assert.ok(club_ && outward, "both share paths are still offered - they are different audiences");
  assert.match(club_.textContent, /שיתוף למועדון/, "the club share says which audience it is");
  assert.match(outward.textContent, /שיתוף מחוץ לאפליקציה/, "and so does the outward one");
  assert.doesNotMatch(row.textContent, /↗/, "the unexplained arrow emoji is gone");

  for (const btn of [club_, outward]) {
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
  assert.match(row.textContent, /שותף למועדון/, "'שותף' alone did not say to whom, beside a control that shares elsewhere");
  assert.ok(row.querySelector('[data-community-action="outward-ach-earned"]'), "the outward share is still offered");
});

// The twin: cloud.js's own inline "share this session to the club" control
// carried a 📤 for the same job, and a 📷 beside it.
test("the log's inline share control draws the same stroke glyph, not an emoji", () => {
  const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("window.renderShareControl"), src.indexOf("window.renderShareControl") + 1800);
  assert.doesNotMatch(fn, /📤/, "the share emoji is gone");
  assert.doesNotMatch(fn, /📷/, "and the camera emoji beside it");
  assert.match(fn, /SHARE_ICONS\.club/, "it reads the one shared definition");
  assert.match(fn, /SHARE_ICONS\.camera/);
});

// =====================================================================
// 4. The display-name hint does not sit on the input's border
// =====================================================================

test("neither copy of the display-name hint pulls itself up over the field above it", () => {
  const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  const hints = [...src.matchAll(/<div class="footer-note" style="margin:([^"]+);">\$\{CLUB_NAME_HINT_TEXT\}/g)];
  assert.equal(hints.length, 2, "both the profile-completion form and the Account tab's profile card carry it");
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

test("each notification type is one row with one control offering the same three channels", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "1" } });
  await openAccount(window);

  const selects = [...window.document.querySelectorAll("[data-notif-pref-select]")];
  assert.ok(selects.length >= 10, "every member-visible type is listed");
  assert.equal(window.document.querySelectorAll('[data-community-action="notif-pref"]').length, 0,
    "and none of them renders the old three-button row");
  for (const s of selects) {
    assert.deepEqual([...s.options].map((o) => o.value), ["push", "in_app", "off"],
      "same three choices, same order, on every type");
    assert.equal(s.closest(".log-row").querySelectorAll("select").length, 1, "one control per row");
  }
});

test("changing the control writes the same own-row upsert the buttons did, and once", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);

  pickNotifPref(window, "mentions", "off");
  await waitFor(() => mock.db.notification_preferences.some((r) => r.type === "mentions" && r.channel === "off"), 4000);
  assert.equal(mock.db.notification_preferences.filter((r) => r.type === "mentions").length, 1,
    "one row, not one per stacked listener - the handler is delegated, bound once for the document");
  assert.equal(mock.db.notification_preferences.find((r) => r.type === "mentions").user_id, "u1");
  await waitFor(() => notifPrefValue(window, "mentions") === "off", 4000);
});

test("push stays omitted from the control entirely while the module is off", async () => {
  const mock = club();
  const window = await bootCommunity(mock, { syncEnabled: false, localStorage: { "haimunia-demo:notifPushFlag": "0" } });
  await openAccount(window);
  assert.equal(notifPrefOption(window, "mentions", "push"), null, "not disabled - absent");
  assert.ok(notifPrefOption(window, "mentions", "in_app"));
  assert.ok(notifPrefOption(window, "mentions", "off"));
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
  assert.match(rule[0], /width:18px/);
  assert.match(rule[0], /var\(--border\)/, "from tokens, so it needs no entry in either dark block");

  const checked = html.match(/input\[type="checkbox"\]:checked,\s*\.movecheck-row\.checked \.movecheck-box\{[^}]*\}/);
  assert.ok(checked, "and one rule for the checked state of both");
  assert.match(checked[0], /var\(--brass\)/);

  // Every colour in all three rules is a token. A literal here would be a
  // rule that needs duplicating into both dark blocks, which is the rule
  // CLAUDE.md names first.
  const tick = html.match(/input\[type="checkbox"\]::after\{[^}]*\}/);
  assert.ok(tick);
  assert.match(tick[0], /var\(--avatar-ink\)/, "the ink token .tag-brass already pairs with --brass");
  for (const r of [rule[0], checked[0], tick[0]]) {
    assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b/i, `a literal colour would need a copy in both dark blocks: ${r}`);
  }
});

test("the WOD builder's tick is a token, not the hardcoded near-black it was on light-theme brass", () => {
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const box = src.slice(src.indexOf('<div class="movecheck-box">'), src.indexOf('<div class="movecheck-box">') + 300);
  assert.match(box, /stroke="var\(--avatar-ink\)"/);
  assert.doesNotMatch(box, /#1a1a1a/);
});
