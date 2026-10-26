#!/usr/bin/env node
// S16, end to end in a real browser: "הורדת הנתונים שלי מהשרת (JSON)".
//
// test/self-export.test.mjs proves the payload in jsdom by calling
// communityBuildSelfExport() directly and faking the anchor click. What only a
// real browser can show is the rest of the path a member actually takes: sign
// in through the login form, find the button on BOTH surfaces it is rendered
// on (the backup card in Settings, and Community's account tab), tap it, and
// get a real downloaded file - then open that file and check it holds the
// member's own rows and nothing staff-only.
//
// The seed is deliberately hostile: every table the export reads also carries
// a row belonging to somebody else, and every staff column the export must
// leave out is filled with a value that is easy to grep for.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal, submitForm, openSettings } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const ME = "member-1";
const OTHER = "member-2";
const EMAIL = "dana@members.haimuniya.invalid";
const PASSWORD = "e2e-member-password";
// Values that may appear in the seed but never in the file. Each is unique to
// a staff column or to another member's row, so a hit names the leak.
const STAFF_MARKERS = ["coach-9", "staff note", "push-endpoint-secret", "push-keys-secret"];
const STAFF_FIELDS = ["is_admin", "assigned_coach_id", "deleted_by", "entered_by", "endpoint", "keys", "admin_note", "moderator_id"];

const seedTables = {
  profiles: [
    { id: ME, handle: "dana", display_name: "דנה", is_admin: false, assigned_coach_id: "coach-9", recovery_verified_at: VERIFIED, visible_to_club: true },
    { id: OTHER, handle: "yossi", display_name: "יוסי", recovery_verified_at: VERIFIED, visible_to_club: true },
  ],
  invite_redemptions: [
    { user_id: ME, invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: OTHER, invite_id: "inv-2", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "מעגל הדגמה" }],
  circle_members: [{ club_id: "club-1", user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: { id: "club-1", name: "מעגל הדגמה", type: "friends", emoji: "🔥", mode: "together", benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null } }],
  private_records: [
    { user_id: ME, record_type: "entry", record_id: "e-mine", payload: { reps: 5 }, deleted_at: null, created_at: "2026-09-01", updated_at: "2026-09-01" },
    { user_id: OTHER, record_type: "entry", record_id: "e-theirs", payload: { reps: 9 }, deleted_at: null, created_at: "2026-09-01", updated_at: "2026-09-01" },
  ],
  workout_posts: [
    { id: "p-mine", author_id: ME, post_type: "POST_TEXT", body: "mine", visibility: "club", status: "active", created_at: "2026-09-01" },
    { id: "p-theirs", author_id: OTHER, post_type: "POST_TEXT", body: "theirs", visibility: "club", status: "active", created_at: "2026-09-01" },
  ],
  blocks: [
    { blocker_id: ME, blocked_id: "member-3", created_at: "2026-09-03" },
    // Who blocked the member is the one row a member must never learn.
    { blocker_id: "member-4", blocked_id: ME, created_at: "2026-09-03" },
  ],
  push_subscriptions: [
    { id: "ps-mine", user_id: ME, endpoint: "push-endpoint-secret", keys: { p256dh: "push-keys-secret" }, created_at: "2026-09-01" },
  ],
  feed_page_rows: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
// acceptDownloads so the blob the button hands the anchor becomes a real file
// Playwright can read back - the same bytes a member's Downloads folder gets.
const context = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
const page = await context.newPage();
const errors = await consoleErrorCollector(page);

// Signed OUT at boot: the scenario signs in through the form, as a member does.
// Cloud backup on, so the Settings backup card renders its signed-in state.
await context.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
await installMockCloud(page, seedTables);
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await page.evaluate((c) => {
  window.__mock.seedCredentials(c.id, c.email, c.password);
  window.__mock.onRpc("bug_report_list_mine", () => ({ data: [{ id: "b-mine", body: "broken", status: "open", created_at: "2026-09-05" }], error: null }));
  window.__mock.onRpc("my_posting_restrictions", () => ({ data: [], error: null }));
}, { id: ME, email: EMAIL, password: PASSWORD });
await dismissWelcomeModal(page);

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector('[data-community-action="show-login"]', { timeout: 5000 });
await page.click('[data-community-action="show-login"]');
await page.waitForSelector("#communityLogin", { timeout: 5000 });
await page.fill('#communityLogin input[name="username"]', "dana");
await page.fill('#communityLogin input[name="password"]', PASSWORD);
await submitForm(page, "#communityLogin");
await page.waitForSelector("#communityHead", { timeout: 8000 });
check("the member signs in with their username and password", true);

// Reads one download to JSON, and asserts everything the file promises.
async function verifyDownload(download, where) {
  check(`${where}: the file is named as the member's data export`,
    /^box-log-my-data-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), download.suggestedFilename());
  const text = readFileSync(await download.path(), "utf8");
  let out = null;
  try { out = JSON.parse(text); } catch (e) { /* reported below */ }
  check(`${where}: the download is valid JSON`, !!out);
  if (!out) return;
  const d = out.data || {};
  const ids = (rows, key) => (rows || []).map((r) => r[key]);
  check(`${where}: it is the account export, for this member`,
    out.kind === "box-log-account-export" && out.user_id === ME, `${out.kind} / ${out.user_id}`);
  check(`${where}: the profile is the member's own and only theirs`,
    JSON.stringify(ids(d.profile, "id")) === JSON.stringify([ME]), JSON.stringify(ids(d.profile, "id")));
  check(`${where}: training records are the member's own only`,
    JSON.stringify(ids(d.private_records, "record_id")) === JSON.stringify(["e-mine"]), JSON.stringify(ids(d.private_records, "record_id")));
  check(`${where}: posts are the member's own only`,
    JSON.stringify(ids(d.posts, "id")) === JSON.stringify(["p-mine"]), JSON.stringify(ids(d.posts, "id")));
  check(`${where}: blocks list who the member blocked, never who blocked them`,
    JSON.stringify(ids(d.blocked, "blocked_id")) === JSON.stringify(["member-3"]) && !text.includes("member-4"),
    JSON.stringify(d.blocked));
  // Row ids and bodies unique to the other member. Not a bare "theirs": the
  // member's own comment legitimately names the post it was left on.
  const foreign = [OTHER, "e-theirs", "\"theirs\"", "יוסי"].filter((m) => text.includes(m));
  check(`${where}: nothing of the other member's is anywhere in the file`, foreign.length === 0, foreign.join(", ") || "none");

  // No staff field, at any depth - checked on the parsed keys, not only the
  // text, so a key with a harmless value still fails.
  const keys = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  })(d);
  const leakedFields = STAFF_FIELDS.filter((f) => keys.has(f));
  check(`${where}: no staff field is in the file`, leakedFields.length === 0, leakedFields.join(", ") || "none");
  const leakedValues = STAFF_MARKERS.filter((m) => text.includes(m));
  check(`${where}: no staff-only value is in the file`, leakedValues.length === 0, leakedValues.join(", ") || "none");
  check(`${where}: the member's own rows survive the filtering`,
    (d.push_subscriptions || []).length === 1 && ids(d.bug_reports, "id").join() === "b-mine",
    `push=${(d.push_subscriptions || []).length} bug_reports=${ids(d.bug_reports, "id").join()}`);
}

async function clickAndDownload(selector) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click(selector),
  ]);
  return download;
}

// ---------------------------------------------------------------------------
// Surface 1: the backup card in Settings
// ---------------------------------------------------------------------------
await openSettings(page);
const settingsBtn = '#settingsOverlay [data-community-action="self-export"]';
await page.waitForSelector(settingsBtn, { state: "visible", timeout: 5000 });
check("Settings: the button is on the backup card",
  await page.evaluate((sel) => {
    const block = document.querySelector(sel)?.closest(".settings-block");
    return !!block && /הגנה על הנתונים שלי/.test(block.querySelector(".settings-block-title")?.textContent || "");
  }, settingsBtn));
await verifyDownload(await clickAndDownload(settingsBtn), "Settings");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.getElementById("settingsOverlay")?.classList.contains("open"), { timeout: 5000 });

// ---------------------------------------------------------------------------
// Surface 2: Community's account tab
// ---------------------------------------------------------------------------
await page.evaluate(() => window.switchAppTab("me"));
const accountBtn = '#content [data-community-action="self-export"]';
await page.waitForSelector(accountBtn, { state: "visible", timeout: 5000 });
await verifyDownload(await clickAndDownload(accountBtn), "Account tab");

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\nself-export-download: FAILED" : "\nself-export-download: all checks passed");
process.exit(failed ? 1 : 0);
