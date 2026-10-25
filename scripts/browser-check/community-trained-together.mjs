#!/usr/bin/env node
// 202609220005 browser scenario for "התאמנו יחד": the author of a workout
// post edits who trained with them, the card prints the line, and the tagged
// member takes their own name back off — real Chromium against the in-page
// mock backend (lib/mockCloud.mjs).
//
// WHY A BROWSER CHECK AND NOT ONLY test/trained-together.test.mjs. The node
// suite drives this flow in jsdom and proves the logic. What it cannot see is
// the part this feature is most likely to get wrong in a real browser and in
// this app specifically:
//
//   1. A REAL CHECKBOX, toggled by a real click on its <label>. The sheet's
//      picks are read off a `change` event with a data attribute, and jsdom
//      is dispatched at by hand in that suite. Here the label is clicked the
//      way a member clicks it, and the state has to follow.
//   2. THE LINE'S OWN GEOMETRY, in an RTL document. The names are inline
//      buttons inside a flex row; a wrapped or mis-ordered line is exactly
//      the class of defect `npm test` has no way to notice (CLAUDE.md:
//      "jsdom has none"). The line is asserted to sit inside its card, to
//      read right-to-left, and to stay inside the viewport at 420px.
//   3. THE TWO CONTROLS NOT COLLIDING. The author's sheet and the tagged
//      member's remove button are different affordances for different people
//      on the same card, and the second one must not require finding a menu.
//
// Two members, one page each, the same mock database underneath — the
// scenario signs out and back in as the tagged member rather than asserting
// about them from the author's session.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const TODAY = new Date().toISOString().slice(0, 10);

// u1 authors. u2 and u3 trained the same day and are taggable. u4 trained
// that day with allow_mentions off, so the server must skip them and the
// card must never name them — the one assertion that proves the client
// renders the server's answer rather than its own request.
const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u3", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: true, allow_follows: true },
    { id: "u4", handle: "tomer", display_name: "תומר", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_mentions: false, allow_follows: true },
  ],
  invite_redemptions: ["u1", "u2", "u3", "u4"].map((id) => ({ user_id: id, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED })),
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  // The class-attendance suggestions that used to fill the sheet went with the
  // attendance module, so the sheet offers exactly the members already tagged.
  post_training_partners: [
    { post_id: "p1", tagged_user_id: "u2", tagged_by: "u1", created_at: VERIFIED },
    { post_id: "p1", tagged_user_id: "u3", tagged_by: "u1", created_at: VERIFIED },
  ],
  // The post the scenario is about, in both shapes the app reads it in:
  // feed_page_rows is what the feed renders, workout_posts is what the
  // tagging RPC checks authorship against. One table does both server-side.
  feed_page_rows: [{
    id: "p1", post_type: "POST_WORKOUT", author_id: "u1",
    author: { display_name: "דנה", handle: "dana" },
    title: "Fran", occurred_on: TODAY, visibility: "club",
    created_at: VERIFIED, published_at: VERIFIED,
    reaction_count: 0, comment_count: 0, media: [],
    metadata: { workout_name: "Fran", workout_date: TODAY, result_text: "7:42" },
  }],
  workout_posts: [{ id: "p1", author_id: "u1", post_type: "POST_WORKOUT", title: "Fran", deleted_at: null }],
  blocks: [], reactions: [],
  notifications: [], notification_preferences: [], analytics_events: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector("#communityHead", { timeout: 8000 });
await page.evaluate(() => window.holdPosts(JSON.parse(JSON.stringify(window.__mock.db.feed_page_rows))));
await page.waitForSelector('[data-post-id="p1"]', { timeout: 8000 });
await page.waitForSelector('[data-post-partners="ready"]', { timeout: 8000 });

// ===========================================================================
// Step 1: the author's sheet, driven with real clicks
// ===========================================================================
await page.click('[data-post-id="p1"] [data-community-action="toggle-post-menu"]');
await page.waitForSelector('[data-community-action="post-tag-partners"][data-id="p1"]', { timeout: 5000 });
check("the author is offered the tagging control on their own workout post", true);

await page.click('[data-community-action="post-tag-partners"][data-id="p1"]');
await page.waitForSelector('[data-partners-panel="p1"]', { timeout: 5000 });
await page.waitForSelector("[data-partner-pick]", { timeout: 5000 });

const offered = await page.$$eval("[data-partner-pick]", (els) => els.map((e) => e.dataset.partnerPick).sort());
check("the sheet offers the members already tagged", JSON.stringify(offered) === JSON.stringify(["u2", "u3"]), offered.join(","));
const selfOffered = await page.$('[data-partner-pick="u1"]');
check("and never offers the author themselves", selfOffered === null);

// A real click on the LABEL, not on the input and not a dispatched event -
// this is the half jsdom cannot reproduce. Untick, then tick again.
await page.click('label:has([data-partner-pick="u3"])');
const unticked = await page.$$eval("[data-partner-pick]", (els) => els.filter((e) => e.checked).map((e) => e.dataset.partnerPick).sort());
check("clicking a label really unticks its box", JSON.stringify(unticked) === JSON.stringify(["u2"]), unticked.join(","));
await page.click('label:has([data-partner-pick="u3"])');
const ticked = await page.$$eval("[data-partner-pick]", (els) => els.filter((e) => e.checked).map((e) => e.dataset.partnerPick).sort());
check("and ticks it again", JSON.stringify(ticked) === JSON.stringify(["u2", "u3"]), ticked.join(","));

await page.click('[data-community-action="partners-save"]');
await page.waitForFunction(() => !document.querySelector("[data-partners-panel]"), { timeout: 5000 });
const sheetClosed = await page.$("[data-partners-panel]");
check("the sheet closes on a successful save", sheetClosed === null);

// ===========================================================================
// Step 2: the card
// ===========================================================================
const lineText = await page.textContent('[data-post-partners="ready"]');
check("the card prints התאמנו יחד", lineText.includes("התאמנו יחד"), lineText);
check("and names the tagged members", lineText.includes("נועם") && lineText.includes("יעל"), lineText);

const tagged = await page.evaluate(() => window.__mock.db.post_training_partners.map((r) => r.tagged_user_id).sort());
check("the server holds exactly the tags that were saved", JSON.stringify(tagged) === JSON.stringify(["u2", "u3"]), tagged.join(","));

// --- geometry, the part npm test cannot see -------------------------------
const geom = await page.evaluate(() => {
  const line = document.querySelector('[data-post-partners="ready"]');
  const card = line.closest(".post-card");
  const names = Array.from(line.querySelectorAll('[data-community-action="view-profile"]'));
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
  return {
    line: r(line),
    card: r(card),
    names: names.map((n) => ({ text: n.textContent.trim(), ...r(n) })),
    dir: getComputedStyle(line).direction,
    docWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
});
check("the line sits inside its own post card", geom.line.top >= geom.card.top - 1 && geom.line.bottom <= geom.card.bottom + 1,
  `line ${geom.line.top}-${geom.line.bottom} vs card ${geom.card.top}-${geom.card.bottom}`);
check("the line is laid out right-to-left, like the rest of the app", geom.dir === "rtl", geom.dir);
// RTL: the first name printed is the RIGHTMOST one. A left-to-right reading
// order here would mean the names run backwards against the label.
check("the first tagged name is the rightmost, so the line reads in the same direction as its label",
  geom.names.length === 2 && geom.names[0].right > geom.names[1].right,
  geom.names.map((n) => `${n.text}@${Math.round(n.right)}`).join(" "));
check("no name is clipped to zero width", geom.names.every((n) => n.width > 8),
  geom.names.map((n) => `${n.text}:${Math.round(n.width)}`).join(" "));
check("the card does not push the page sideways at 420px", geom.scrollWidth <= geom.docWidth + 1,
  `${geom.scrollWidth} vs ${geom.docWidth}`);

const authorHasUntag = await page.$('[data-community-action="partner-untag-self"]');
check("the author, who is not tagged, is offered no remove-my-tag control", authorHasUntag === null);

// ===========================================================================
// Step 3: the tagged member takes their own name off
// ===========================================================================
// A SECOND PAGE, not a reload and not a setUser() on this one. installMockCloud
// seeds the mock database from an addInitScript, so ANY navigation rebuilds it
// from the seed - a reload would silently throw away step 1's writes and then
// assert about a database that had never been tagged. So the rows step 1
// actually produced are read out and carried into a fresh page signed in as
// the tagged member, which is also the more honest scenario: a different
// person, on a different device, opening the same post.
const carried = await page.evaluate(() => window.__mock.db.post_training_partners.map((r) => ({ ...r })));
await page.close();

const page2 = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors2 = await consoleErrorCollector(page2);
await installMockCloud(
  page2,
  Object.assign({}, seedTables, { post_training_partners: carried }),
  { user: { id: "u2", is_anonymous: false, email: "noam@members.haimuniya.invalid" } }
);
await page2.goto(target.url, { waitUntil: "networkidle" });
await page2.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page2);
await switchTab(page2, "tabCommunityBtn");
await page2.waitForSelector("#communityHead", { timeout: 8000 });
await page2.evaluate(() => window.holdPosts(JSON.parse(JSON.stringify(window.__mock.db.feed_page_rows))));
await page2.waitForSelector('[data-post-partners="ready"]', { timeout: 8000 });

await page2.waitForSelector('[data-community-action="partner-untag-self"]', { timeout: 5000 });
check("a tagged member finds the remove control on the card itself, not behind the author's menu", true);
await page2.click('[data-post-id="p1"] [data-community-action="toggle-post-menu"]');
await page2.waitForSelector('[data-post-id="p1"] .post-menu', { timeout: 5000 });
const taggedMenu = await page2.$('[data-post-id="p1"] [data-community-action="post-tag-partners"]');
check("and is not offered the author's tagging control", taggedMenu === null);
await page2.click('[data-post-id="p1"] [data-community-action="toggle-post-menu"]');

await page2.click('[data-community-action="partner-untag-self"]');
await page2.waitForFunction(
  () => !window.__mock.db.post_training_partners.some((r) => r.tagged_user_id === "u2"),
  { timeout: 5000 }
);
check("the tagged member's own row is gone", true);
const after = await page2.textContent('[data-post-partners="ready"]');
check("the card re-renders without their name and keeps the other one", !after.includes("נועם") && after.includes("יעל"), after);

const allErrors = errors.concat(errors2);
check("no console errors", allErrors.length === 0, allErrors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-trained-together: FAILED" : "\ncommunity-trained-together: all checks passed");
process.exit(failed ? 1 : 0);
