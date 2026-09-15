// The test fixture's permission table must match the real one.
//
// Live bug hunt, fresh round 1 (2026-09-15). An agent hunting the dual-subject
// permission model reported what looked like a live bug - a head coach seeing
// "אין לך הרשאה לצפות באנליטיקס" on the club panel - and then did the right
// thing: checked whether the app was wrong or the FIXTURE was. It was the
// fixture. MOCK_ROLE_PERMS.head_coach was two permissions short of what the
// migrations actually grant.
//
// WHY THAT IS WORTH A TEST OF ITS OWN. A stale mock does not fail. It passes,
// quietly, against a narrower world than production - so every scenario
// exercising a head coach (invite codes, analytics, club modules) was proving
// something about an account that does not exist. The failure mode is a green
// suite and a broken panel, which is the worst one available. The same drift
// had already been sitting there through two full ten-round hunts without
// anything noticing.
//
// The source of truth is the migrations folder, parsed the way the database
// itself would apply it: inserts accumulate, deletes take back. That matters -
// 202609150011 revokes community.club.manage_modules from head_coach, and a
// parser that only read inserts would demand the mock keep a grant the
// database no longer has.
//
// Verified against production when written: this parser produced head_coach=12
// and admin=13, which is exactly what my_permissions() returned live for those
// two accounts.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "supabase", "migrations");

function grantsFromMigrations() {
  const grants = new Map();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    // Line comments stripped first: these migrations explain themselves at
    // length and quote example grants in prose. Counting a comment as a grant
    // is the same mistake that has already bitten a coach-gate test in this
    // repo once.
    const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

    for (const block of sql.matchAll(/insert into public\.role_permissions[^;]*?values(.*?);/gis)) {
      for (const [, role, perm] of block[1].matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z0-9_.]+)'\s*\)/g)) {
        if (!grants.has(role)) grants.set(role, new Set());
        grants.get(role).add(perm);
      }
    }
    for (const [, role, perm] of sql.matchAll(
      /delete from public\.role_permissions\s+where role_code\s*=\s*'([a-z_]+)'\s+and permission_code\s*=\s*'([a-z0-9_.]+)'/gis)) {
      if (grants.has(role)) grants.get(role).delete(perm);
    }
  }
  return grants;
}

async function mockRolePerms() {
  const src = fs.readFileSync(path.join(here, "helpers", "mockSupabase.mjs"), "utf8");
  const start = src.indexOf("const MOCK_ROLE_PERMS = {");
  assert.ok(start > -1, "MOCK_ROLE_PERMS must still exist");
  const body = src.slice(start, src.indexOf("\n  };", start));
  const out = new Map();
  for (const [, role, list] of body.matchAll(/^\s*([a-z_]+):\s*\[([^\]]*)\]/gm)) {
    out.set(role, new Set([...list.matchAll(/"([a-z0-9_.]+)"/g)].map((m) => m[1])));
  }
  // owner is built by copying admin at module load, not written out literally.
  if (out.has("admin")) out.set("owner", new Set(out.get("admin")));
  return out;
}

test("every role the mock models holds exactly what the migrations grant it", async () => {
  const real = grantsFromMigrations();
  const mock = await mockRolePerms();
  assert.ok(real.size >= 5, `the parser found only ${real.size} roles - it has stopped working`);

  const problems = [];
  for (const [role, perms] of mock) {
    const truth = real.get(role);
    if (!truth) { problems.push(`mock models role "${role}" which no migration grants anything`); continue; }
    for (const p of perms) if (!truth.has(p)) problems.push(`${role}: mock grants "${p}", the schema does not`);
    for (const p of truth) if (!perms.has(p)) problems.push(`${role}: schema grants "${p}", the mock does not`);
  }
  assert.deepEqual(problems, [],
    `the test fixture's permissions have drifted from the migrations.\n` +
    `A stale fixture does not fail - it passes against a narrower world than production,\n` +
    `so scenarios prove things about accounts that do not exist. Update MOCK_ROLE_PERMS\n` +
    `in test/helpers/mockSupabase.mjs:\n  - ${problems.join("\n  - ")}`);
});

test("the parser honours revocations, not just grants", () => {
  // 202609150011 takes community.club.manage_modules back off head_coach.
  // A parser that read only inserts would insist the mock keep it, and the
  // fixture would drift back to wrong in the other direction.
  const real = grantsFromMigrations();
  assert.ok(real.get("admin").has("community.club.manage_modules"),
    "an admin manages club modules");
  assert.ok(!real.get("head_coach").has("community.club.manage_modules"),
    "a head coach does not - the panel split moved module toggles to admin (202609150011)");
  assert.ok(real.get("head_coach").has("community.analytics.view"),
    "but the club's own numbers are still theirs");
});
