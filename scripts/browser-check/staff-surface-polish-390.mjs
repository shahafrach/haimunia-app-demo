#!/usr/bin/env node
// The six staff-surface findings from real phone screenshots, measured at the
// width they were found at: 390x844, a phone, not the 420x900 the rest of
// this directory uses. Every one of them is a geometry or a
// what-is-actually-on-screen claim, which is why they are here and not in the
// node suite - jsdom reports every rect as 0x0 at (0,0), so it cannot fail on
// a field that escapes its card or on six empty states that fill two screens.
//
//   1. The coach board stacked six four-slot empty cards. One line each now,
//      with ONE summary at the top when nothing needs attention.
//   2. Member of the week took a typed @handle. It is a member search over the
//      roster the Directory tab already loads.
//   3. Three solid-orange primaries competing on one screen. One main action
//      per screen; the rest are .chip-btn.secondary outlines.
//   4. The announcement form's expiry field escaping the card's inline-end
//      edge on iOS - width-bounded now, and bounded here.
//   5. The Account tab pointed staff at a "ניהול" bottom-tab item that has not
//      existed since 2026-09-15.
//   6. Two staff-only lists loose among the member's own settings, now one
//      labelled staff area.
//
// WHAT THIS FILE CANNOT SEE, stated rather than implied. Finding 4's original
// symptom is a WebKit behaviour: a native date/time control sizes to its
// segment text and iOS will not shrink it below that, so `width:100%` is
// ignored. Chromium honours the 100% and never reproduced the overflow at any
// width tested (320/360/390). What is asserted below is therefore the
// INVARIANT the fix restores - the expiry field is bounded by its card and is
// the same width as its sibling fields - which holds in both engines and is
// what a regression would break. The WebKit half is unverified here.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const PHONE = { width: 390, height: 844 };
const VERIFIED = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// A coach, a club, and six members with names - enough for the picker to have
// real suggestions and for nothing else to have rows, which is the quiet week
// findings 1 and 2 are about.
const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u10", handle: "gil", display_name: "גיל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: "u11", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: daysAgo(400) },
    { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: daysAgo(200) },
    { user_id: "u10", invite_id: "inv-1", role: "member", redeemed_at: daysAgo(200) },
    { user_id: "u11", invite_id: "inv-1", role: "member", redeemed_at: daysAgo(200) },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  announcements: [], challenges: [], events: [], monthly_club_recaps: [],
  coach_engagement_flags: [], coach_tasks: [],
  workout_posts: [], post_comments: [], analytics_events: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);
console.log(`Viewport: ${PHONE.width}x${PHONE.height}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: PHONE });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

// The quiet week. Every coach-board read answers "nothing", which is the state
// all six cards used to render in.
await page.evaluate(() => {
  window.__mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_new_members", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_inactive_members", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_tasks_refresh", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_activity_signal_status", () => ({ data: [{ members_with_app_activity: 3, total_members: 4 }], error: null }));
  window.__mock.onRpc("member_of_week_candidates", () => ({
    data: [{ week_start: "2026-09-14", category: "most_prs", category_label: "הכי הרבה שיאים", rotation_index: 1, free_selection: false, published: null, previous_week_user_id: "u11", candidates: [] }],
    error: null,
  }));
});

await dismissWelcomeModal(page);
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 8000 });

// A measurement shared by several checks below: is this element's box inside
// its ancestor's content box, on both inline edges? In RTL "overflows the
// card's left edge" is an overflow past the inline END, so this is written
// against both physical edges rather than guessing which one RTL puts where.
async function boundedBy(sel, ancestorSel) {
  return page.evaluate(([s, a]) => {
    const el = document.querySelector(s);
    const anc = el && el.closest(a);
    if (!el || !anc) return null;
    const cs = getComputedStyle(anc);
    const ar = anc.getBoundingClientRect();
    const inner = {
      left: ar.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
      right: ar.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
    };
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, innerLeft: inner.left, innerRight: inner.right };
  }, [sel, ancestorSel]);
}

// ===========================================================================
// 1. The coach board: one line per empty section, one summary at the top
// ===========================================================================
await page.click('[data-community-action="set-tab"][data-tab="coach"]');
await page.waitForFunction(() => document.body.textContent.includes("חבר/ת השבוע"), { timeout: 8000 });
await page.waitForSelector('[data-empty-state="coach-celebrate"]', { timeout: 8000 });

const emptyBoxes = await page.evaluate(() => [...document.querySelectorAll("[data-empty-state]")].map((el) => ({
  key: el.getAttribute("data-empty-state"),
  variant: el.getAttribute("data-empty-variant"),
  height: Math.round(el.getBoundingClientRect().height),
  icons: el.querySelectorAll("svg").length,
  buttons: el.querySelectorAll("button").length,
  text: el.textContent.replace(/\s+/g, " ").trim(),
})));
check("the coach board still renders several empty sections at once on a quiet week", emptyBoxes.length >= 5, `${emptyBoxes.length} sections`);
check("every one of them is the one-line variant", emptyBoxes.every((b) => b.variant === "line"), emptyBoxes.map((b) => `${b.key}:${b.variant}`).join(" "));
check("none of them draws an icon or invents a button", emptyBoxes.every((b) => b.icons === 0 && b.buttons === 0));
// THE MEASUREMENT THAT IS THE FINDING. The four-slot card is 32px of padding
// plus a 28px icon plus a headline plus two paragraphs; at 390px each one
// measured ~170-210px tall, and six of them is most of two phone screens. A
// line wraps to at most two at this width.
const tallest = Math.max(...emptyBoxes.map((b) => b.height));
check("each empty section is at most two lines tall at 390px", tallest <= 70, `tallest ${tallest}px (${emptyBoxes.map((b) => `${b.key} ${b.height}px`).join(", ")})`);
const totalEmptyHeight = emptyBoxes.reduce((n, b) => n + b.height, 0);
check("all of them together fit inside one phone screen", totalEmptyHeight < PHONE.height, `${totalEmptyHeight}px of ${PHONE.height}px`);

const summary = await page.evaluate(() => {
  const els = [...document.querySelectorAll("[data-coach-board-summary]")];
  if (els.length !== 1) return { count: els.length };
  const first = document.querySelector("#content [data-empty-state], #content [data-coach-tasks-section]");
  return {
    count: 1,
    text: els[0].textContent.replace(/\s+/g, " ").trim(),
    top: Math.round(els[0].getBoundingClientRect().top),
    firstSectionTop: first ? Math.round(first.getBoundingClientRect().top) : null,
  };
});
check("ONE summary, not one per quiet section", summary.count === 1, `found ${summary.count}`);
check("it says the one thing the coach opened the tab for", !!summary.text && /אין מה לטפל בו|אין משימות פתוחות/.test(summary.text), summary.text);
check("and it is above the sections it summarises", summary.firstSectionTop === null || summary.top < summary.firstSectionTop, `summary ${summary.top}px, first section ${summary.firstSectionTop}px`);

// ===========================================================================
// 2. Member of the week: a member search, not a typed handle
// ===========================================================================
check("the typed-@handle field is gone", (await page.$("[data-mow-pick-handle]")) === null);
await page.waitForSelector("[data-mow-pick-search]", { timeout: 8000 });
await page.waitForSelector('[data-community-action="coach-mow-pick-select"]', { timeout: 8000 });
const suggestions = await page.evaluate(() => [...document.querySelectorAll('[data-community-action="coach-mow-pick-select"]')].map((el) => ({
  id: el.dataset.id,
  disabled: el.disabled,
  text: el.textContent.replace(/\s+/g, " ").trim(),
  height: Math.round(el.getBoundingClientRect().height),
})));
check("the roster is offered as suggestions before a single character is typed", suggestions.length >= 3, `${suggestions.length} suggestions`);
check("each suggestion names the member the club knows and the handle that disambiguates them", suggestions.some((s) => /נועה/.test(s.text) && /@noa/.test(s.text)));
check("last week's member is listed but not selectable", suggestions.some((s) => s.id === "u11" && s.disabled));
// Every suggestion is a tap target on a phone.
const shortest = Math.min(...suggestions.map((s) => s.height));
check("every suggestion clears the 44px touch floor", shortest >= 44, `shortest ${shortest}px`);

// Typing filters, client-side, off the roster already in memory.
await page.fill("[data-mow-pick-search]", "גיל");
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[data-community-action="coach-mow-pick-select"]')];
  return rows.length > 0 && rows.every((r) => /גיל/.test(r.textContent));
}, { timeout: 8000 });
check("typing a Hebrew first name narrows the list to that member", true);

await page.click('[data-community-action="coach-mow-pick-select"][data-id="u10"]');
await page.waitForSelector('[data-mow-pick-chosen="u10"]', { timeout: 8000 });
const chosen = await page.evaluate(() => ({
  text: document.querySelector('[data-mow-pick-chosen="u10"]').textContent.replace(/\s+/g, " ").trim(),
  boxGone: document.querySelector("[data-mow-pick-search]") === null,
  withinCard: (() => {
    const el = document.querySelector('[data-mow-pick-chosen="u10"]');
    const card = el.closest(".chart-card");
    const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
    return r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
  })(),
}));
check("choosing a member replaces the box with the choice, named", /גיל/.test(chosen.text) && chosen.boxGone, chosen.text);
check("the chosen row stays inside its card at 390px", chosen.withinCard);

// ===========================================================================
// 3. One orange per screen
// ===========================================================================
// On the coach board's member-of-the-week section the pick form is the only
// publish control (no computed candidates this week), so IT is the main
// action and keeps the fill.
const pickBtnHere = await page.evaluate(() => {
  const b = document.querySelector('[data-community-action="coach-mow-publish-pick"]');
  return { cls: b.className, bg: getComputedStyle(b).backgroundColor };
});
check("with no computed candidates the pick form IS the main action, and is orange", /\bprimary\b/.test(pickBtnHere.cls), pickBtnHere.cls);

// Now the other branch: a week WITH candidates, where each candidate row
// carries the one-tap orange publish and the manual form is the second door.
// A second page rather than re-answering the RPC on this one: the envelope is
// loaded once per session (`loaded` gates the lazy load) and the only control
// that re-fetches it is the error branch's retry button, which a successful
// load does not render. Booting the branch is honest; reaching into the
// module's own state to force a reload would be testing the harness.
const candidatePage = await browser.newPage({ viewport: PHONE });
const candidateErrors = await consoleErrorCollector(candidatePage);
await installMockCloud(candidatePage, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await candidatePage.goto(target.url, { waitUntil: "networkidle" });
await candidatePage.waitForSelector("#app", { state: "visible", timeout: 10000 });
await candidatePage.evaluate(() => {
  window.__mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_new_members", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_inactive_members", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_tasks_refresh", () => ({ data: [], error: null }));
  window.__mock.onRpc("coach_activity_signal_status", () => ({ data: [{ members_with_app_activity: 3, total_members: 4 }], error: null }));
  window.__mock.onRpc("member_of_week_candidates", () => ({
    data: [{ week_start: "2026-09-14", category: "most_prs", category_label: "הכי הרבה שיאים", rotation_index: 1, free_selection: false, published: null, previous_week_user_id: null, candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, detail: { pr_count: 3 } }] }],
    error: null,
  }));
});
await dismissWelcomeModal(candidatePage);
await switchTab(candidatePage, "tabCommunityBtn");
await candidatePage.waitForSelector(".subtabbar", { timeout: 8000 });
await candidatePage.click('[data-community-action="set-tab"][data-tab="coach"]');
await candidatePage.waitForSelector('[data-community-action="coach-mow-publish-candidate"]', { timeout: 8000 });
// The manual form sits behind its <details> summary; open it so its button is
// laid out and its computed style is real.
await candidatePage.evaluate(() => { const d = document.querySelector("details"); if (d) d.open = true; });
const twoWays = await candidatePage.evaluate(() => {
  const cand = document.querySelector('[data-community-action="coach-mow-publish-candidate"]');
  const pick = document.querySelector('[data-community-action="coach-mow-publish-pick"]');
  const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
  return { candCls: cand.className, candBg: bg(cand), pickCls: pick ? pick.className : null, pickBg: bg(pick) };
});
check("the one-tap candidate publish keeps the orange fill", /\bprimary\b/.test(twoWays.candCls), twoWays.candCls);
check("and the manual form beside it is the secondary outline, not a second orange", /\bsecondary\b/.test(twoWays.pickCls || ""), String(twoWays.pickCls));
check("the two are visually different, not two fills of the same colour", twoWays.candBg !== twoWays.pickBg, `${twoWays.candBg} vs ${twoWays.pickBg}`);
check("no console errors on the candidates branch", candidateErrors.length === 0, candidateErrors.join(" | "));
await candidatePage.close();

// The Boards tab: two create buttons that used to be two more oranges stacked
// above the member's own join button. Its own page, with a real active
// challenge to join - the coach board above needs the challenge list EMPTY
// (that is the quiet week it is measuring), and a screenshot of one screen
// cannot also be a screenshot of the other.
const boardsPage = await browser.newPage({ viewport: PHONE });
const boardsErrors = await consoleErrorCollector(boardsPage);
await installMockCloud(boardsPage, Object.assign({}, seedTables, {
  challenges: [{ id: "c-1", challenge_type: "individual_target", title: "100 בורפיז", description: "", metric_type: "session_count", target_value: 5, start_at: daysAgo(5), end_at: new Date(Date.now() + 20 * 86400000).toISOString(), status: "active", join_mode: "open", visibility: "club", created_by: "u1", config: {} }],
  challenge_participants: [], challenge_teams: [], challenge_progress: [],
}), { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await boardsPage.goto(target.url, { waitUntil: "networkidle" });
await boardsPage.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(boardsPage);
await switchTab(boardsPage, "tabCommunityBtn");
await boardsPage.waitForSelector(".subtabbar", { timeout: 8000 });
await boardsPage.click('[data-community-action="set-tab"][data-tab="boards"]');
await boardsPage.waitForSelector('[data-community-action="open-challenge-form"]', { timeout: 8000 });
await boardsPage.waitForSelector('[data-community-action="open-event-form"]', { timeout: 8000 });
await boardsPage.waitForSelector('[data-community-action="join-challenge"]', { timeout: 8000 });
const boards = await boardsPage.evaluate(() => {
  const g = (sel) => { const el = document.querySelector(sel); return el ? { cls: el.className, bg: getComputedStyle(el).backgroundColor } : null; };
  // Every orange button on the screen, and whether it is a section-level
  // create control (the finding) or something else (a form's own submit, the
  // member's join).
  const oranges = [...document.querySelectorAll("#content .chip-btn.primary")].map((el) => ({
    label: el.textContent.replace(/\s+/g, " ").trim(),
    isCreateControl: /open-(challenge|event)-form/.test(el.dataset.communityAction || ""),
  }));
  return {
    challenge: g('[data-community-action="open-challenge-form"]'),
    event: g('[data-community-action="open-event-form"]'),
    join: g('[data-community-action="join-challenge"]'),
    oranges,
  };
});
check('"אתגר חדש" is a secondary outline, not a solid orange', /\bsecondary\b/.test(boards.challenge.cls) && !/\bprimary\b/.test(boards.challenge.cls), boards.challenge.cls);
check('"אירוע חדש" is too - its twin, changed with it', /\bsecondary\b/.test(boards.event.cls) && !/\bprimary\b/.test(boards.event.cls), boards.event.cls);
check("both are transparent-backed, so the screen no longer stacks fills", boards.challenge.bg === boards.event.bg && /rgba\(0, 0, 0, 0\)|transparent/.test(boards.challenge.bg), boards.challenge.bg);
check("the member's own join action is what keeps the orange", !!boards.join && /\bprimary\b/.test(boards.join.cls), boards.join ? boards.join.cls : "no join button");
// The honest form of "one main action per screen" here: no SECTION-LEVEL
// create control is orange any more. The oranges that remain are a form's own
// submit and the member's join - each the main action of the thing it sits
// in, which is what the rule is about.
check("no section-level create button is orange any more", boards.oranges.every((o) => !o.isCreateControl), boards.oranges.map((o) => o.label).join(" | "));
check("no console errors on the Boards screen", boardsErrors.length === 0, boardsErrors.join(" | "));
await boardsPage.close();

// ===========================================================================
// 4. The announcement expiry field stays inside its card
// ===========================================================================
await page.click('[data-community-action="set-tab"][data-tab="feed"]').catch(() => {});
await page.waitForSelector("#communityAnnouncement", { timeout: 10000 });
// Filled, and in the widest rendering a browser gives this control: an en-US
// profile paints `12/31/2026, 11:59 PM`, a 12-hour clock with an AM/PM
// segment, which is the longest thing that can be in this box.
await page.evaluate(() => {
  const i = document.querySelector('#communityAnnouncement input[name="expiresAt"]');
  i.value = "2026-12-31T23:59";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
const expiry = await boundedBy('#communityAnnouncement input[name="expiresAt"]', "#communityAnnouncement");
check("the expiry field's box is inside the card's content box on the inline-end (left, in RTL) edge", expiry.left >= expiry.innerLeft - 0.5, `field left ${expiry.left.toFixed(1)}px, card inner left ${expiry.innerLeft.toFixed(1)}px`);
check("and on the inline-start edge", expiry.right <= expiry.innerRight + 0.5, `field right ${expiry.right.toFixed(1)}px, card inner right ${expiry.innerRight.toFixed(1)}px`);
const fieldWidths = await page.evaluate(() => {
  const f = document.querySelector("#communityAnnouncement");
  const w = (n) => { const el = f.querySelector(`[name="${n}"]`); return el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null; };
  return { title: w("title"), body: w("body"), priority: w("priority"), expiresAt: w("expiresAt") };
});
check("it is exactly as wide as every other field on the card", fieldWidths.expiresAt === fieldWidths.title && fieldWidths.expiresAt === fieldWidths.body && fieldWidths.expiresAt === fieldWidths.priority, JSON.stringify(fieldWidths));
const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("and the page has no horizontal overflow at 390px", pageOverflow <= 0, `${pageOverflow}px`);

// ===========================================================================
// 5 + 6. The Account tab: one labelled staff area, pointing somewhere real
// ===========================================================================
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForSelector("[data-account-staff-area]", { timeout: 10000 });
const account = await page.evaluate(() => {
  const area = document.querySelector("[data-account-staff-area]");
  const heads = [...area.querySelectorAll(".ach-section-title")].map((h) => h.textContent.trim());
  const areaRect = area.getBoundingClientRect();
  // Every OTHER section on the tab: none of them may sit after the staff
  // area, which is the whole of finding 6 - the staff blocks used to be
  // sandwiched between the member's own settings.
  const after = [...document.querySelectorAll("#content > .ach-section")]
    .filter((el) => el !== area && !area.contains(el))
    .filter((el) => el.getBoundingClientRect().top > areaRect.top)
    .map((el) => (el.querySelector(".ach-section-title") || {}).textContent);
  const bottomBar = [...document.querySelectorAll("#bottomTabBar .tabbtn")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  return {
    label: heads[0] || "",
    inner: heads.slice(1),
    text: area.textContent.replace(/\s+/g, " ").trim(),
    sectionsAfter: after,
    bottomBar,
    withinViewportWidth: areaRect.left >= 0 && areaRect.right <= window.innerWidth,
  };
});
check("the staff-only blocks are inside ONE section that says it is for staff", /צוות/.test(account.label), account.label);
check("and both of them are in it", account.inner.some((h) => /חברים חדשים/.test(h)) && account.inner.some((h) => /לא נכנסו לאפליקציה/.test(h)), account.inner.join(" | "));
check("it says out loud that a member does not see it", /מוצג לצוות המועדון בלבד/.test(account.text));
check("no member setting is left stranded below it", account.sectionsAfter.length === 0, account.sectionsAfter.join(" | "));
check("the staff area fits the 390px viewport", account.withinViewportWidth);

// Finding 5, both halves: the old sentence is gone, and the new one names
// destinations that are really there.
check('the pointer no longer sends a coach to a "ניהול" item in the bottom bar', !/בתפריט התחתון/.test(account.text), account.text.slice(-160));
check("it names both management destinations", /ניהול המועדון/.test(account.text) && /ניהול מערכת/.test(account.text));
check("it names where they actually are - the ☰ menu", /תפריט/.test(account.text) && /☰/.test(account.text));
// The measurement that makes the correction true rather than merely different.
check("and the bottom bar really has no ניהול item to send anyone to", !account.bottomBar.some((l) => /^ניהול/.test(l)), account.bottomBar.join(" | "));
const menuHasBoth = await page.evaluate(async () => {
  document.getElementById("navMenuBtn").click();
  await new Promise((r) => setTimeout(r, 300));
  const rows = [...document.querySelectorAll("#navMenuList [data-action='switch-tab']")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  return rows;
});
check("...and the ☰ menu does", menuHasBoth.some((l) => /ניהול המועדון/.test(l)) && menuHasBoth.some((l) => /ניהול מערכת/.test(l)), menuHasBoth.join(" | "));

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nstaff-surface-polish-390: FAILED" : "\nstaff-surface-polish-390: all checks passed");
process.exit(failed ? 1 : 0);
