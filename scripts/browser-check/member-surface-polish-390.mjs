#!/usr/bin/env node
// The seven member-surface fixes, measured at 390x844 - the viewport the
// real phone screenshots that produced them came from.
//
// ONE SCRIPT, SEVEN SECTIONS, and deliberately not seven scripts:
// scripts/browser-check/ is one of the directories CLAUDE.md names as
// enumerated from disk (run-all.mjs discovers every *.mjs here), so each
// file added to it is a merge hazard for every other open branch. Seven
// files for one pass of one screen is six hazards more than the work needs.
//
// 390x844 IS THE POINT, not an arbitrary phone. Six of the seven defects
// are about how much room something takes: a chip row that does not fit, a
// preference list scrolled past fifty buttons, a hint tucked under an input
// border. A 420-wide viewport - what the other community scenarios use -
// hides three of them.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VIEWPORT = { width: 390, height: 844 };
const VERIFIED = new Date().toISOString();

function member(id, name, extra) {
  return Object.assign({
    id, handle: id, display_name: name, is_admin: false,
    recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true,
  }, extra || {});
}

const seedTables = {
  profiles: [
    member("u1", "דנה"),
    member("u2", "נועם"),
    // The member whose privacy settings withhold the follow button. Before
    // this pass their card was visibly a different shape from everyone
    // else's, which is the leak the "same layout for every member" half of
    // fix 2 is about.
    member("u3", "נועה", { allow_follows: false }),
    // "ניהול @admin" - the account from the screenshot. Management by the
    // legacy profiles.is_admin flag.
    member("admin", "ניהול", { is_admin: true }),
    // And management by role, which is the other half of
    // is_management_account(): rank staff (40) and above.
    member("office", "משרד"),
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "admin", invite_id: "inv-1", role: "admin", redeemed_at: VERIFIED },
    { user_id: "office", invite_id: "inv-1", role: "staff", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  circle_members: [{ club_id: "club-1", user_id: "u1", role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: { id: "club-1", name: "מעגל הדגמה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null } }],
  achievement_definitions: [
    { id: "ad1", code: "first_workout", name: "האימון הראשון", icon: "🏅", category: "milestone" },
  ],
  member_achievements: [
    { id: "ma1", user_id: "u1", achievement_id: "ad1", visibility: "club", shared_at: null, unlocked_at: VERIFIED },
  ],
  follows: [], blocks: [], reactions: [], post_comments: [],
  // One post, purely so the FEED's own "⋯" menu can be measured beside the
  // member card's: the .post-menu overflow this pass fixes is one rule
  // shared by both, and a fix measured on only one of them is the sibling
  // drift CLAUDE.md is about.
  feed_page_rows: [{
    id: "p1", post_type: "POST_TEXT", author_id: "u2",
    author: { display_name: "נועם", handle: "u2" },
    body: "מי בא לאימון של הערב?", visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [], metadata: {},
  }],
  feed_impressions: [], feed_interactions: [], hidden_posts: [], saved_posts: [],
  notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
// Fix 5's environment, set before boot so nothing has read either value yet.
// navigator.standalone is what pushAskGateReason()'s "inside the installed
// app" condition tests, and a Notification that answers "denied" is the
// exact state the screenshot was taken in.
await page.addInitScript(() => {
  Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
  window.Notification = {
    permission: "default",
    requestPermission: () => Promise.resolve("denied"),
  };
});

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

await page.evaluate(() => window.switchAppTab("me"));
await page.waitForSelector("#content", { timeout: 5000 });

// A page that scrolls sideways at 390px is the failure mode five of these
// seven fixes share, so it is asserted after every section rather than once
// at the end.
async function noHorizontalOverflow(where) {
  const over = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(`no horizontal overflow at 390px — ${where}`, over.scrollWidth <= over.clientWidth + 1,
    `scrollWidth ${over.scrollWidth} vs clientWidth ${over.clientWidth}`);
}

// =====================================================================
// 3. One achievement row, two NAMED share actions, no emoji on either
// =====================================================================
await page.waitForSelector("[data-achievement-id]", { timeout: 8000 });
const ach = await page.evaluate(() => {
  const row = document.querySelector("[data-achievement-id]");
  const btns = [...row.querySelectorAll(".chip-btn")];
  return {
    labels: btns.map((b) => b.textContent.trim()),
    svgs: btns.map((b) => b.querySelectorAll("svg").length),
    strokes: btns.map((b) => {
      const svg = b.querySelector("svg");
      return svg ? svg.getAttribute("stroke") + "/" + svg.getAttribute("fill") : null;
    }),
    rowRight: row.getBoundingClientRect().right,
    rowLeft: row.getBoundingClientRect().left,
  };
});
check("the achievement share control is labelled, and says which audience it goes to",
  ach.labels.length === 1 && ach.labels[0].includes("שיתוף") && ach.labels[0].includes("למעגל"), JSON.stringify(ach.labels));
check("neither label is an emoji glyph", !ach.labels.some((l) => /[←-⇿☀-➿️\u{1F300}-\u{1FAFF}]/u.test(l)),
  JSON.stringify(ach.labels));
check("it carries exactly one stroke icon", ach.svgs.join(",") === "1", ach.svgs.join(","));
check("the icons are stroke, not fill", ach.strokes.every((s) => s === "currentColor/none"), JSON.stringify(ach.strokes));
check("the achievement row stays inside 390px",
  ach.rowLeft >= 0 && ach.rowRight <= VIEWPORT.width + 1, `${ach.rowLeft}..${ach.rowRight}`);
await noHorizontalOverflow("achievements list");

// =====================================================================
// 4. The display-name hint clears the input's border
// =====================================================================
const hint = await page.evaluate(() => {
  const form = document.getElementById("communityProfile");
  if (!form) return null;
  const input = form.querySelector('input[name="displayName"]');
  const next = form.querySelector('input[name="emoji"]');
  if (!input || !next) return null;
  const i = input.getBoundingClientRect(), n = next.getBoundingClientRect();
  return { gap: Math.round((n.top - i.bottom) * 10) / 10 };
});
check("the display-name field sits above the emoji field, not over it",
  !!hint && hint.gap > 0, JSON.stringify(hint));
check("and is clear of it by a readable gap", !!hint && hint.gap >= 4, JSON.stringify(hint));

// =====================================================================
// 6. One compact row per notification type, one switch
// =====================================================================
const prefs = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll("[data-notif-pref-toggle]")];
  return {
    count: boxes.length,
    selects: document.querySelectorAll("[data-notif-pref-select]").length,
    rowsWithButtons: document.querySelectorAll('[data-community-action="notif-pref"]').length,
    allOff: boxes.every((b) => !b.checked),
    rowHeights: boxes.map((b) => Math.round(b.closest(".log-row").getBoundingClientRect().height)),
  };
});
check("every notification type has exactly one switch (four)", prefs.count === 4, String(prefs.count));
check("no type renders the old button row or select any more", prefs.rowsWithButtons === 0 && prefs.selects === 0, JSON.stringify(prefs));
check("every switch starts off", prefs.allOff);
// "Compact" measured, not asserted: a row with a label and one switch fits
// on one or two lines, so it is well under the ~140px the stacked block took.
check("each row is compact", prefs.rowHeights.every((h) => h > 0 && h <= 90),
  prefs.rowHeights.join(","));

// Turning one on writes a preference row.
await page.evaluate(() => {
  const s = document.querySelector('[data-notif-pref-toggle][data-type="reaction"]');
  s.checked = true;
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForFunction(
  () => window.__mock.db.notification_preferences.some((r) => r.type === "reaction" && r.channel !== "off"),
  { timeout: 5000 });
check("turning a switch on writes the notification_preferences row", true);
await noHorizontalOverflow("notification preferences");

// =====================================================================
// 5. The push self-test says what to do next, per platform, with a retry
// =====================================================================
await page.click('[data-community-action="notif-push-self-test"]');
await page.waitForSelector('[data-push-self-test="failed"]', { timeout: 8000 });
const help = await page.evaluate(() => {
  const panel = document.querySelector("[data-push-self-test]");
  const helpEl = panel.querySelector("[data-push-permission-help]");
  return {
    reason: panel.textContent.includes("לא אושרה הרשאת התראות"),
    hasHelp: !!helpEl,
    text: helpEl ? helpEl.textContent : "",
    retries: panel.querySelectorAll('[data-community-action="notif-push-self-test"]').length,
  };
});
check("the self-test still reports the denied permission", help.reason);
check("and now says how to allow it", help.hasHelp);
check("with an iPhone line", /אייפון/.test(help.text), help.text.slice(0, 60));
check("and an Android line", /אנדרואיד/.test(help.text), help.text.slice(0, 60));
check("the iPhone line names the add-to-home-screen step first",
  help.text.indexOf("מסך הבית") > 0 && help.text.indexOf("מסך הבית") < help.text.indexOf("אנדרואיד"));
check("and a retry sits with the instructions", help.retries >= 2, String(help.retries));
await noHorizontalOverflow("push self-test");

// =====================================================================
// 7. One checkbox, everywhere
// =====================================================================
// border-top-width is read but not compared against the 1.5px in the
// stylesheet: Chromium reports the USED value for a border, rounded to a
// device pixel, so a 1.5px border reads back as 1px at dpr 1. What the
// measurement is for is that every box reads back the SAME, which it does
// either way.
const boxes = await page.evaluate(() => {
  const read = (el) => {
    const c = getComputedStyle(el);
    return [c.appearance, c.width, c.height, c.borderRadius, c.borderTopWidth, c.borderTopStyle].join("|");
  };
  const inputs = [...document.querySelectorAll('input[type="checkbox"]')];
  const on = inputs.find((el) => el.checked), off = inputs.find((el) => !el.checked);
  return {
    count: inputs.length,
    styles: [...new Set(inputs.map(read))],
    checkedBg: on ? getComputedStyle(on).backgroundColor : null,
    uncheckedBg: off ? getComputedStyle(off).backgroundColor : null,
    tickOpacity: on ? getComputedStyle(on, "::after").opacity : null,
  };
});
check("the Account tab renders real checkboxes", boxes.count >= 3, String(boxes.count));
check("and every one of them is the same box", boxes.styles.length === 1, boxes.styles.join(" // "));
check("drawn by the app, not by the platform", boxes.styles[0] && boxes.styles[0].startsWith("none|20px|20px|6px|"),
  boxes.styles[0]);
check("a ticked box fills and an unticked one does not",
  !!boxes.checkedBg && !!boxes.uncheckedBg && boxes.checkedBg !== boxes.uncheckedBg,
  `${boxes.checkedBg} vs ${boxes.uncheckedBg}`);
check("and the tick itself is drawn", boxes.tickOpacity === "1", String(boxes.tickOpacity));

// The WOD builder's movement rows were the second style. Same measurement,
// same expected answer - that is the whole of fix 7.
await switchTab(page, "tabWodBtn");
await page.waitForTimeout(300);
const moveBoxStyle = await page.evaluate(async () => {
  const open = document.querySelector('[data-action="open-wod-builder"], [data-action="wod-builder"]');
  if (open) open.click();
  await new Promise((r) => setTimeout(r, 400));
  const el = document.querySelector(".movecheck-box");
  if (!el) return null;
  const c = getComputedStyle(el);
  return [c.appearance, c.width, c.height, c.borderRadius, c.borderTopWidth, c.borderTopStyle].join("|");
});
if (moveBoxStyle === null) {
  console.log("SKIP  the WOD builder's movement checkbox — the builder did not open from this entry point");
} else {
  check("the WOD builder's movement box is the same box", moveBoxStyle === boxes.styles[0],
    `${moveBoxStyle} vs ${boxes.styles[0]}`);
}

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nmember-surface-polish-390: FAILED" : "\nmember-surface-polish-390: all checks passed");
process.exit(failed ? 1 : 0);
