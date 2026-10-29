// The product repairs that came out of the first end-to-end user tests
// (docs/qa/user-tests-2026-10.md). The database halves are pgTAP
// (supabase/tests/0146); the screen halves are in
// scripts/browser-check/overlays-never-cover.mjs. This file pins what jsdom can see.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [], workout_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("pr_share", () => ({ data: "pr-post-1", error: null }));
  mock.onRpc("ach_share", () => ({ data: "ach-post-1", error: null }));
  return mock;
}
async function bootReady(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  await waitFor(() => window.communityCircleIds && window.communityCircleIds().length > 0, 3000);
  return window;
}

// ---- 1. "signed up" is read from the database, and the session is refreshed ----
test("no function reads is_anonymous from the JWT: the latest definitions use auth.users", () => {
  const dir = path.join(root, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const fn of ["create_founder_invite", "bug_report_submit"]) {
    const last = files.filter((f) => new RegExp(`create or replace function public\\.${fn}\\b`).test(fs.readFileSync(path.join(dir, f), "utf8"))).pop();
    const src = fs.readFileSync(path.join(dir, last), "utf8");
    const body = src.slice(src.lastIndexOf(`create or replace function public.${fn}`));
    const end = body.indexOf("end $$;");
    assert.ok(!/auth\.jwt\(\)\s*->>\s*'is_anonymous'/.test(body.slice(0, end)), `${fn} (${last}) still reads the claim`);
    assert.match(body.slice(0, end), /from auth\.users u where u\.id = auth\.uid\(\) and coalesce\(u\.is_anonymous, false\)/, `${fn} reads auth.users.is_anonymous`);
  }
});

test("sign-up refreshes the session right after the upgrade", () => {
  const src = read("src/community/auth.js");
  const at = src.indexOf("client.auth.updateUser(");
  assert.ok(at > 0, "updateUser is the upgrade step");
  assert.ok(src.indexOf("client.auth.refreshSession()", at) > at, "and refreshSession follows it, so the token's is_anonymous claim is current");
});

// ---- 2. the PR card shows the percent when weights are hidden ----
test("a PR post with weights hidden shows the percent improvement and no kilograms", async () => {
  const window = await bootReady(seeded());
  const html = window.renderPostCard({ id: "p1", post_type: "POST_PR", author_id: "u2", author: { display_name: "נועה", emoji: "🌟" },
    title: "Deadlift", result_text: "+6.2%", metadata: { movement: "Deadlift", movement_id: "deadlift", improvement_pct: 6.2 }, occurred_on: "2026-10-29", published_at: new Date().toISOString() });
  assert.match(html, /\+6\.2%/, "the percent is on the card");
  assert.match(html, /שיפור/, "labelled as the improvement");
  assert.ok(!/ק["״]ג/.test(html), "and no kilograms");
});

test("with weights shown the card still shows the kilograms, not a second percent", async () => {
  const window = await bootReady(seeded());
  const html = window.renderPostCard({ id: "p2", post_type: "POST_PR", author_id: "u2", author: { display_name: "נועה", emoji: "🌟" },
    result_text: '75 ק"ג × 5', metadata: { movement: "Deadlift", new_result: '75 ק"ג × 5', previous_result: '70 ק"ג × 5', improvement: '+5 ק"ג', improvement_pct: 7.1 }, occurred_on: "2026-10-29", published_at: new Date().toISOString() });
  assert.match(html, /\+5 ק(?:"|&quot;)ג/);
  assert.ok(!/\+7\.1%/.test(html), "the kilogram improvement wins");
});

// ---- 3. the medal prompt waits for the backup question; the PR prompt does not ----
test("a medal waits behind the backup question, then is offered once it is answered", async () => {
  const window = await bootReady(seeded());
  window.haimuniaBackupQuestionOwed = () => true;
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: "first_pr", member_achievement_id: "ma-1", visibility: "club" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(window.document.getElementById("achUnlock"), null, "nothing opens over the backup question");
  window.haimuniaBackupQuestionOwed = () => false;
  window.dispatchEvent(new window.Event("haimunia-backup-consent-answered"));
  await waitFor(() => !!window.document.getElementById("achUnlock"), 3000);
});

test("a PR prompt is not held back by the backup question", async () => {
  const window = await bootReady(seeded());
  window.haimuniaBackupQuestionOwed = () => true;
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-1", movement: "Squat", new_result: '100 ק"ג' } });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
});

test("app.js tells the circles layer when the backup question is answered", () => {
  const src = read("app.js");
  assert.match(src, /function setBackupConsent[\s\S]{0,400}haimunia-backup-consent-answered/, "setBackupConsent announces the answer");
  assert.match(src, /window\.haimuniaBackupQuestionOwed = function/, "and the question's state is exposed");
});

// ---- 4. the share confirmation shows on the Log tab too ----
test("sharing a PR is confirmed with a toast, which shows on every screen", async () => {
  const window = await bootReady(seeded());
  const toasts = [];
  window.showToast = (t) => toasts.push(t);
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: { record_id: "rec-2", movement: "Squat", new_result: '100 ק"ג' } });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="pr-share"]').click();
  await waitFor(() => toasts.length > 0, 3000);
  assert.match(toasts[0], /השיא שותף/);
});

// ---- 5. nothing floats over the save button ----
test("the share bar and the status toast dock above the bottom bars", () => {
  assert.match(read("src/community/circles-sheets.js"), /data-share-bar="1" data-dock="1"/);
  assert.match(read("src/community/circles-ui.js"), /role="status" aria-live="polite" data-dock="1"/);
  const html = read("index.html");
  assert.match(html, /\[data-dock\]\{\s*bottom:calc\(var\(--bottom-wrap-h, 92px\) \+ 8px\) !important;/);
  assert.match(html, /html\{\s*scroll-padding-bottom:var\(--bottom-nav-reserve\);/);
  assert.match(read("app.js"), /setProperty\("--bottom-wrap-h"/);
});
