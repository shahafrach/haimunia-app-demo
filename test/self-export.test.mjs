// S16. A member downloads what the server holds about them, as JSON.
//
// Read with the member's own client, so RLS decides what is readable; the
// client's own job is to keep other members' rows and staff columns out of
// what RLS allows. These drive the real cloud.js against the mock client.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const ME = "member-1";
const OTHER = "member-2";

function seeded() {
  const mock = createMockSupabase({
    private_records: [
      { user_id: ME, record_type: "entry", record_id: "e1", payload: { reps: 5 }, deleted_at: null, created_at: "2026-09-01", updated_at: "2026-09-01" },
      { user_id: OTHER, record_type: "entry", record_id: "e2", payload: { reps: 9 }, deleted_at: null, created_at: "2026-09-01", updated_at: "2026-09-01" },
    ],
    workout_posts: [
      { id: "p1", author_id: ME, post_type: "POST_TEXT", body: "mine", status: "active", created_at: "2026-09-01" },
      { id: "p2", author_id: OTHER, post_type: "POST_TEXT", body: "theirs", status: "active", created_at: "2026-09-01" },
    ],
    post_comments: [{ id: "c1", post_id: "p2", author_id: ME, body: "hi", deleted_by: "coach-9", status: "active", created_at: "2026-09-02" }],
    blocks: [
      { blocker_id: ME, blocked_id: "member-3", created_at: "2026-09-03" },
      { blocker_id: "member-4", blocked_id: ME, created_at: "2026-09-03" },
    ],
    challenge_progress: [{ id: "cp1", challenge_id: "ch1", user_id: ME, delta: 1, entered_by: "coach-9", note: "staff note", created_at: "2026-09-04" }],
  });
  mock.setUser({ id: ME, is_anonymous: false, created_at: new Date().toISOString() });
  mock.onRpc("bug_report_list_mine", () => ({ data: [{ id: "b1", body: "broken", status: "open", created_at: "2026-09-05" }], error: null }));
  mock.onRpc("my_posting_restrictions", () => ({ data: [], error: null }));
  return mock;
}

async function boot(mock) {
  const window = await bootCommunity(mock, { syncEnabled: true });
  await waitFor(() => typeof window.communityBuildSelfExport === "function"
    && typeof window.renderBackupSettingsPanel === "function"
    && /self-export/.test(window.renderBackupSettingsPanel()), 3000);
  return window;
}

test("the export holds the member's own rows only, and no staff columns", async () => {
  const window = await boot(seeded());
  const out = JSON.parse(JSON.stringify(await window.communityBuildSelfExport()));
  assert.strictEqual(out.kind, "box-log-account-export");
  assert.strictEqual(out.user_id, ME);
  assert.deepStrictEqual(out.data.private_records.map((r) => r.record_id), ["e1"]);
  assert.deepStrictEqual(out.data.posts.map((r) => r.id), ["p1"]);
  assert.deepStrictEqual(out.data.blocked, [{ blocked_id: "member-3", created_at: "2026-09-03" }], "never who blocked the member");
  assert.deepStrictEqual(out.data.bug_reports.map((r) => r.id), ["b1"]);
  const text = JSON.stringify(out);
  for (const staff of ["deleted_by", "entered_by", "staff note", "coach-9", "member-4", "theirs", "is_admin", "assigned_coach_id"]) {
    assert.ok(!text.includes(staff), `${staff} must not reach the export`);
  }
});

test("a read the server refuses is listed as unavailable, and the rest is still delivered", async () => {
  const mock = seeded();
  mock.onRpc("bug_report_list_mine", () => ({ data: null, error: { message: "denied" } }));
  const window = await boot(mock);
  const out = await window.communityBuildSelfExport();
  assert.ok(out.unavailable.includes("bug_reports"));
  assert.strictEqual(out.data.private_records.length, 1);
});

test("every table select names its columns, filters to the member, and skips staff-only tables", () => {
  const start = cloudJs.indexOf("const SELF_EXPORT_TABLES");
  const block = cloudJs.slice(start, cloudJs.indexOf("]);", start));
  assert.ok(!/cols: "\*"/.test(block), "no select *");
  for (const col of ["is_admin", "assigned_coach_id", "deleted_by", "entered_by", "published_by", "classmates", "keys", "endpoint", "admin_note", "moderator_id"]) {
    assert.ok(!new RegExp(`[",]${col}[",]`).test(block), `${col} is a staff/other-member column`);
  }
  for (const table of ["reports", "analytics_events", "coach_congratulations", "coach_tasks", "member_contact_log", "coach_engagement_flags", "admin_actions"]) {
    assert.ok(!block.includes(`table: "${table}"`), `${table} is not member-exportable`);
  }
  const fn = cloudJs.slice(cloudJs.indexOf("async function buildSelfExport()"));
  assert.match(fn.slice(0, 800), /\.eq\(spec\.owner, uid\)/);
});

test("the button is on the backup card, and tapping it downloads a file", async () => {
  const window = await boot(seeded());
  let downloaded = null;
  window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  window.handleCommunityClick({ dataset: { communityAction: "self-export" } });
  await waitFor(() => downloaded !== null, 3000);
  assert.match(downloaded, /^box-log-my-data-\d{4}-\d{2}-\d{2}\.json$/);
});
