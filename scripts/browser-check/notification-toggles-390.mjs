#!/usr/bin/env node
// The four notification switches in Me, in RTL at phone width (390x844), real
// Chromium against the in-page mock backend (lib/mockCloud.mjs).
//
// Measured, not asserted from source: all four are present and OFF, the label
// is on the right and the switch on the left (RTL), nothing scrolls sideways,
// each row is a comfortable touch target, the text is legible in both themes,
// and turning one on writes the preference row. cloud-config.js still carries
// the VAPID placeholder, so the screen must also say push is not set up.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const seedTables = {
  profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  circle_members: [{ club_id: "club-1", user_id: "u1", role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: { id: "club-1", name: "מעגל הדגמה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null } }],
  notifications: [],
  notification_preferences: [],
  push_subscriptions: [],
  feed_page_rows: [], follows: [], hidden_posts: [], saved_posts: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = await consoleErrorCollector(page);
await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);
await page.evaluate(() => window.switchAppTab("me"));
await page.waitForSelector('[data-notif-pref-toggle][data-type="reaction"]', { timeout: 8000 });

const measure = () => page.evaluate(() => {
  const rootRect = document.documentElement.getBoundingClientRect();
  const rows = [...document.querySelectorAll("[data-notif-pref-toggle]")].map((box) => {
    const row = box.closest(".log-row");
    const label = row.querySelector("span");
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect(), l = label.getBoundingClientRect();
    return {
      type: box.dataset.type, checked: box.checked, role: box.getAttribute("role"), name: box.getAttribute("aria-label"),
      rowH: Math.round(r.height), rowL: Math.round(r.left), rowR: Math.round(r.right),
      boxCenter: b.left + b.width / 2, labelCenter: l.left + l.width / 2, boxW: Math.round(b.width), boxH: Math.round(b.height),
    };
  });
  return {
    dir: getComputedStyle(document.documentElement).direction,
    rows,
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    reason: (document.querySelector("[data-notif-push-reason]") || {}).textContent || "",
    panelText: document.getElementById("notifPrefs").textContent,
    rootW: rootRect.width,
  };
});

let m = await measure();
check("the page is right-to-left", m.dir === "rtl");
check("exactly four switches, in order", m.rows.map((r) => r.type).join(",") === "reaction,trained_together,circle_joined,week_card", m.rows.map((r) => r.type).join(","));
check("ALL FOUR START OFF", m.rows.every((r) => !r.checked));
check("each is a switch with its own accessible name", m.rows.every((r) => r.role === "switch" && r.name && r.name.length > 3));
check("RTL: the label is on the right and the switch on the left", m.rows.every((r) => r.boxCenter < r.labelCenter), m.rows.map((r) => `${Math.round(r.boxCenter)}<${Math.round(r.labelCenter)}`).join(" "));
check("each row is a touch target (height >= 44px)", m.rows.every((r) => r.rowH >= 44), m.rows.map((r) => r.rowH).join(","));
check("each row stays inside the 390px viewport", m.rows.every((r) => r.rowL >= 0 && r.rowR <= 391), m.rows.map((r) => `${r.rowL}..${r.rowR}`).join(" "));
check("no horizontal overflow", m.scrollWidth <= m.clientWidth + 1, `${m.scrollWidth} vs ${m.clientWidth}`);
check("while the VAPID key is the placeholder the screen says push is not set up", /עדיין לא הוגדרו/.test(m.reason), m.reason);
check("the intro says everything is off until turned on", /כבויות עד שתדליקו/.test(m.panelText));

// Legible in both themes: label colour against the row's resolved background.
for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  const ratio = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const label = document.querySelector("[data-notif-pref-toggle]").closest(".log-row").querySelector("span");
    let bgEl = label, bg = "rgba(0, 0, 0, 0)";
    while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
    const a = lum(getComputedStyle(label).color), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  check(`label text is legible in the ${theme} theme (contrast >= 4.5)`, ratio >= 4.5, ratio.toFixed(2));
}
await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

// Turning one on writes the row and the switch reads on after the re-render.
await page.click('[data-notif-pref-toggle][data-type="week_card"]');
await page.waitForFunction(() => window.__mock.db.notification_preferences.some((r) => r.type === "week_card" && r.channel !== "off"), { timeout: 5000 });
await page.waitForFunction(() => document.querySelector('[data-notif-pref-toggle][data-type="week_card"]').checked, { timeout: 5000 });
m = await measure();
check("turning week_card on writes its row and it stays on", m.rows.find((r) => r.type === "week_card").checked);
check("and the other three did not move", m.rows.filter((r) => r.type !== "week_card").every((r) => !r.checked));
check("nothing was subscribed: no push_subscriptions row", (await page.evaluate(() => window.__mock.db.push_subscriptions.length)) === 0);
check("no horizontal overflow after the change", m.scrollWidth <= m.clientWidth + 1);
check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nnotification-toggles-390: FAILED" : "\nnotification-toggles-390: all checks passed");
process.exit(failed ? 1 : 0);
