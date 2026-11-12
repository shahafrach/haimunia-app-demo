// The club's operating workflows (docs/club/research.md: C, K, "Migration path"):
// club-admin.yml, migration-status.yml, auth-launch-limit.yml, and the anon_limit
// input of set-auth-config.yml. The logic lives in scripts/*.mjs and is driven here;
// the workflow files are read for the properties that keep a public log safe.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { actionSql, whoRef, isSuccess, ACTIONS } from "../scripts/club-admin.mjs";
import { repoVersions, compare, verdict } from "../scripts/migration-status.mjs";
import { lastRaise, decide, NORMAL_LIMIT } from "../scripts/auth-launch-limit.mjs";

const wf = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
  .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

// ---------------------------------------------------------------- club-admin
test("club-admin: a username reaches SQL only as sha256 of its lower-cased form", () => {
  const sql = actionSql("set_coach", " Coach_Dana ");
  assert.equal(sql, `select public.owner_set_coach('sha256:${createHash("sha256").update("coach_dana").digest("hex")}') as status`);
  assert.doesNotMatch(sql, /dana/i);
  for (const a of ["create_club", "set_owner"]) assert.doesNotMatch(actionSql(a, "someone"), /someone/);
});
test("club-admin: nothing but a valid username is accepted, so nothing else can reach SQL", () => {
  for (const bad of ["", "ab", "x'; drop table clubs; --", "שם", "a".repeat(25)]) assert.throws(() => whoRef(bad));
  assert.throws(() => actionSql("drop_everything", "dana"));
  assert.equal(actionSql("usage_report"), "select public.training_log_usage_report(12) as status");
});
test("club-admin: success is the function's own word", () => {
  assert.ok(isSuccess("create_club", "created") && isSuccess("create_club", "exists"));
  assert.ok(!isSuccess("create_club", "no_such_user") && !isSuccess("create_club", "too_many_circles"));
  assert.ok(isSuccess("set_coach", "set") && isSuccess("set_owner", "already"));
  assert.ok(!isSuccess("set_coach", "not_member") && !isSuccess("set_owner", "no_club"));
  assert.ok(isSuccess("usage_report", { devices_seen: 3 }) && !isSuccess("usage_report", null));
});
test("club-admin.yml: manual, masked before checkout, the actions the script knows", () => {
  const y = wf("club-admin.yml");
  assert.match(y, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(y, /^\s+(schedule|push|pull_request):/m);
  assert.doesNotMatch(y, /\$\{\{\s*inputs\.who/, "the username never goes through an expression, so never into an env: block GitHub prints");
  assert.match(y, /GITHUB_EVENT_PATH/, "it is read from the event payload file");
  const run = y.slice(y.indexOf("- name: run the action"));
  assert.ok(run.indexOf('::add-mask::$who') < run.indexOf("node scripts/club-admin.mjs"), "masked before the script runs");
  assert.match(y, /options: \[create_club, set_coach, set_owner, usage_report\]/);
  assert.deepEqual(ACTIONS, ["create_club", "set_coach", "set_owner", "usage_report"]);
  assert.doesNotMatch(y, /echo[^\n]*\$who(?!")/i, "the username is never echoed except into add-mask");
});

// ---------------------------------------------------------- migration-status
test("migration-status: versions come from the file names", () => {
  assert.deepEqual(repoVersions(["202611120001_haimunia_club.sql", "README.md", "202611100002_x.sql"]), ["202611100002", "202611120001"]);
});
test("migration-status: pending and unknown are both a failure", () => {
  assert.deepEqual(verdict(compare(["1", "2"], ["1", "2"])).ok, true);
  const p = verdict(compare(["1", "2", "3"], ["1", "2"]));
  assert.equal(p.ok, false); assert.match(p.text, /PENDING[^\n]*3/);
  const u = verdict(compare(["1"], ["1", "9"]));
  assert.equal(u.ok, false); assert.match(u.text, /UNKNOWN[^\n]*9/);
});
test("migration-status.yml: read-only, after a migration lands on main, waits for the integration", () => {
  const y = wf("migration-status.yml");
  assert.match(y, /push:\s*\n\s+branches: \[main\]\s*\n\s+paths:\s*\n\s+- "supabase\/migrations\/\*\*"/);
  assert.match(y, /github\.event_name == 'push' && '10'/);
  assert.match(y, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(y, /db push|migration up|apply/i);
  const s = readFileSync(new URL("../scripts/migration-status.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(s, /\b(insert|update|delete|alter|drop|create)\b\s/i, "the script only selects");
});

// --------------------------------------------------------- auth-launch-limit
const DAY = 86400e3;
const now = Date.UTC(2026, 11, 1);
const run = (name, daysAgo, conclusion = "success") => ({ name, conclusion, updated_at: new Date(now - daysAgo * DAY).toISOString() });
test("auth-launch-limit: lowers to 60 only after seven days at the launch limit", () => {
  const raised = lastRaise([run("set-auth-config anon_limit=", 1), run("set-auth-config anon_limit=300", 8)]);
  assert.deepEqual(raised.limit, 300);
  assert.equal(decide(300, raised, now), "lower");
  assert.equal(decide(300, lastRaise([run("set-auth-config anon_limit=300", 3)]), now), "wait");
  assert.equal(decide(NORMAL_LIMIT, raised, now), "nothing");
  assert.equal(decide(30, null, now), "nothing", "the Supabase default (30) is left alone");
});
test("auth-launch-limit: a failed raise or a later normal setting is not a launch", () => {
  assert.equal(lastRaise([run("set-auth-config anon_limit=300", 9, "failure")]), null);
  assert.equal(lastRaise([run("set-auth-config anon_limit=60", 1), run("set-auth-config anon_limit=300", 9)]), null);
  assert.equal(decide(300, null, now), "lower", "above 60 with no recorded raise goes back to 60");
});
test("set-auth-config.yml: anon_limit is optional, checked, read back, and named in the run", () => {
  const y = wf("set-auth-config.yml");
  assert.match(y, /^run-name: set-auth-config anon_limit=\$\{\{ inputs\.anon_limit \}\}/m);
  assert.match(y, /if: \$\{\{ inputs\.anon_limit != '' \}\}/);
  assert.match(y, /\*\[!0-9\]\*\) echo "anon_limit must be a whole number\."; exit 1/);
  assert.match(y, /rate_limit_anonymous_users\\":\$ANON_LIMIT/);
  assert.match(y, /\[ "\$now" = "\$ANON_LIMIT" \]/);
  const a = wf("auth-launch-limit.yml");
  assert.match(a, /schedule:\s*\n\s+- cron: "\d+ \d+ \* \* \*"/);
  assert.match(a, /group: set-auth-config/, "never races a manual set-auth-config run");
});
