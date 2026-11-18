// F-028 (202611180001): every club staff or owner SECURITY DEFINER function a session can call refuses a
// password-only (aal1) session of a member with a verified MFA factor. RLS already requires aal_satisfied() on
// every table (202611070002), but a definer function runs past RLS, so the check has to be in its body.
//
// This guard reads the migrations, keeps the LAST definition of each public function, and fails when a definer
// function that checks staff or ownership (is_club_staff, is_circle_owner, or the caller's owner/coach role in
// circle_members) does not call aal_satisfied(). A future staff RPC written without the check fails here even
// before pgTAP (supabase/tests/0160_staff_rpcs_require_aal2_test.sql) runs it at aal1 and aal2.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const dir = new URL("../supabase/migrations/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

function latestDefinitions() {
  const defs = new Map();
  const head = /create (?:or replace )?function public\.([a-z_0-9]+)\s*\(/gi;
  for (const f of files) {
    const sql = fs.readFileSync(new URL(f, dir), "utf8");
    for (const drop of sql.matchAll(/drop function (?:if exists )?public\.([a-z_0-9]+)/gi)) defs.delete(drop[1]);
    let m;
    while ((m = head.exec(sql))) {
      const rest = sql.slice(m.index);
      const as = /\bas\s+(\$[a-z_]*\$)/i.exec(rest);
      if (!as) continue;
      const end = rest.indexOf(as[1], as.index + as[0].length);
      const header = rest.slice(0, as.index);
      defs.set(m[1], { file: f, definer: /security definer/i.test(header), body: rest.slice(as.index + as[0].length, end) });
    }
  }
  return defs;
}

// Not session-callable actions: helpers, triggers, operator-only and cron functions (named in the migration).
const NOT_ACTIONS = new Set([
  "is_club_staff", "is_circle_owner", "owner_set_coach", "owner_set_club_owner",
  "circle_members_guard", "circle_members_after_delete", "notif_on_circle_join", "workout_posts_guard_privileged_type",
  "club_staff_log", "club_staff_actions_purge",
]);
const STAFF_CHECK = /public\.is_club_staff\(|public\.is_circle_owner\(|v_my_role\s*(?:=|<>|in)\s*\(?\s*'(?:owner|coach)'/;

test("the eight staff and owner RPCs check aal_satisfied() first", () => {
  const defs = latestDefinitions();
  for (const n of ["rotate_club_link", "club_announcement_post", "club_announcement_set_pinned", "club_announcement_delete",
    "remove_member", "post_delete", "create_circle_invite", "update_circle"]) {
    const d = defs.get(n);
    assert.ok(d, `${n} exists`);
    assert.equal(d.file, "202611180001_staff_rpcs_require_aal2.sql", `${n} is last defined by 202611180001`);
    assert.match(d.body, /\nbegin\n\s*-- F-028[^\n]*\n\s*if not public\.aal_satisfied\(\) then raise exception 'not authorized' using errcode = 'P0001'; end if;/,
      `${n}: the aal check is its first statement`);
  }
});

test("no current definer function that checks staff or ownership is missing the aal check", () => {
  const defs = latestDefinitions();
  const missing = [];
  for (const [name, d] of defs) {
    if (!d.definer || NOT_ACTIONS.has(name) || !STAFF_CHECK.test(d.body)) continue;
    if (!/public\.aal_satisfied\(\)/.test(d.body)) missing.push(`${name} (${d.file})`);
  }
  assert.deepEqual(missing, [], "a staff or owner definer RPC without aal_satisfied() lets an aal1 session past MFA");
});

test("the migration changes nothing but the check: no new grant, no comment rewrite", () => {
  const sql = fs.readFileSync(new URL("202611180001_staff_rpcs_require_aal2.sql", dir), "utf8");
  assert.doesNotMatch(sql, /^\s*(grant|revoke|comment on)\b/im, "create or replace keeps grants and comments");
  assert.equal((sql.match(/security definer set search_path = ''/g) || []).length, 8);
});
