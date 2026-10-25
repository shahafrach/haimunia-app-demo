#!/usr/bin/env node
// COMM-234 browser scenario: open the notification center and see a batched
// reaction group and an immediate achievement notification, real Chromium
// against the in-page mock backend (lib/mockCloud.mjs).
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
const BASE = Date.now();
function notif(i, extra) {
  return Object.assign({
    id: `n${i}`, user_id: "u1", type: "comment_reply", category: "community",
    title: `התראה ${i}`, body: `גוף ${i}`, source_type: null, source_id: null,
    deep_link: null, read_at: null, created_at: new Date(BASE - i * 60000).toISOString(),
  }, extra || {});
}

const seedTables = {
  profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  notifications: [
    notif(1, { type: "reaction", category: "community", title: "עידודים חדשים", body: "התקדמות חדשה נרשמה", source_type: "post", source_id: "p1", deep_link: "/community/feed?post=p1" }),
    notif(2, { type: "achievement_unlocked", category: "training", title: "פתחת הישג חדש", body: "100 אימונים", deep_link: "/community/achievements" }),
  ],
  notification_preferences: [],
  feed_page_rows: [], follows: [], hidden_posts: [], saved_posts: [],
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
await page.waitForSelector("#communityHead", { timeout: 5000 });
await page.click('[data-community-action="feed-notifications"]');
await page.waitForSelector("[data-notif-center]", { timeout: 5000 });
await page.waitForFunction(() => {
  const c = document.querySelector("[data-notif-center]");
  return c && !/aria-busy="true"/.test(c.innerHTML);
}, { timeout: 5000 });

const text = await page.textContent("[data-notif-center]");
// reaction is a batched type (COMM-142) — it collapses into one group using
// the type's own generic heading, not the seeded row's title, until expanded.
check("the notification center shows a reactions group", text.includes("עידודים חדשים על הפוסט שלך"));
check("the notification center shows the achievement notification", text.includes("פתחת הישג חדש"));

await page.click('[data-community-action="notif-toggle-group"][data-key^="reaction"]');
await page.waitForFunction(() => document.querySelector("[data-notif-center]").textContent.includes("התקדמות חדשה נרשמה"), { timeout: 5000 });
check("expanding the reactions group reveals the individual notification's own body", true);

const dialogAttrs = await page.evaluate(() => {
  const dlg = document.querySelector("[data-notif-center]");
  return { role: dlg.getAttribute("role"), modal: dlg.getAttribute("aria-modal") };
});
check("the center is a real dialog (role=dialog, aria-modal=true)", dialogAttrs.role === "dialog" && dialogAttrs.modal === "true");

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-notification-center: FAILED" : "\ncommunity-notification-center: all checks passed");
process.exit(failed ? 1 : 0);
