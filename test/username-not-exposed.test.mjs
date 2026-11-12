// F20 (fix plan, 2026-11-10). After the lost-code reset (F19) a username alone
// starts a password reset, so a username another member can see is half a
// takeover. Checked 2026-11-10: the gym-era functions that returned one
// (admin_member_roster, admin_incomplete_signups, admin_invite_list,
// admin_search_members, the admin_user_directory view) were dropped by
// 202610250001_strip_gym, and profiles.handle is derived from the display
// name, not from the login. These guards keep it that way.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const STRIP = "202610250001_strip_gym.sql";

// The only definitions after the strip allowed to read the auth email, and why.
const ALLOWED = new Map([
  ["recovery_lookup_user", "service_role only: the recover-password Edge Function's username lookup"],
  ["owner_issue_reset_code", "granted to no role: run by the owner in the SQL editor"],
  ["reset_lookup_user", "service_role only: the request-reset Edge Function's username lookup"],
  ["owner_user_by_name", "granted to no role: the club owner functions' username lookup (SQL editor or club-admin.yml), 202611120001"],
]);

function functionsReadingEmail(sql) {
  const out = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  for (const m of sql.matchAll(re)) {
    const body = m[3];
    if (/auth\.users/i.test(body) && /\.email\b|email\s*=|email\s+like/i.test(body)) out.push(m[1]);
  }
  return out;
}

test("since the strip, no function that reads the auth email (which carries the username) is new without a reason", () => {
  const after = files.filter((f) => f > STRIP);
  for (const f of after) {
    const sql = fs.readFileSync(new URL(f, dir), "utf8");
    for (const name of functionsReadingEmail(sql)) {
      assert.ok(ALLOWED.has(name), `${f}: public.${name} reads auth.users email. Members must never see a username; add it to ALLOWED with the reason only if no member can call it.`);
      assert.ok(!new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\b[^;]*\\b(authenticated|anon|public)\\b`, "i").test(sql),
        `${f}: public.${name} reads the auth email and must not be granted to authenticated, anon or public`);
    }
  }
});

test("the gym-era functions that returned a username are dropped by the strip", () => {
  const strip = fs.readFileSync(new URL(STRIP, dir), "utf8");
  for (const name of ["admin_member_roster", "admin_incomplete_signups", "admin_invite_list", "admin_search_members"]) {
    assert.match(strip, new RegExp(`drop function if exists public\\.${name}\\(`), name);
  }
  assert.match(strip, /drop view if exists public\.admin_user_directory;/);
});

test("the client never renders another member's email or username", () => {
  const sources = ["cloud.js", ...fs.readdirSync(new URL("../src/community/", import.meta.url)).map((f) => "src/community/" + f)]
    .filter((f) => f.endsWith(".js"));
  for (const f of sources) {
    const src = fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
    const emailReads = [...src.matchAll(/\b(\w+)\.email\b/g)].map((m) => m[1]).filter((o) => o !== "user" && o !== "auth");
    assert.deepEqual(emailReads, [], `${f}: reads .email on something other than the member's own session user`);
    // Allowed: form fields, field errors, and recovery.js's own-device reset record (stored, v).
    assert.ok(!/\.username\b/.test(src.replace(/\b(form\.elements|errors|stored|v)\.username/g, "")), `${f}: reads a .username field; members see display names only`);
  }
});
