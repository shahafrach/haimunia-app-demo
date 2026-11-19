// Q-50: the daily free-tier check (scripts/check-free-tier.mjs, .github/workflows/free-tier-health.yml).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluate, MB, DB_LIMIT_BYTES } from "../scripts/check-free-tier.mjs";

const wf = fs.readFileSync(new URL("../.github/workflows/free-tier-health.yml", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../scripts/check-free-tier.mjs", import.meta.url), "utf8");
const healthy = { status: "ACTIVE_HEALTHY", dbBytes: 50 * MB, invocations24h: 1000 };

test("healthy numbers pass, and egress is named as not checked", () => {
  const out = evaluate(healthy);
  assert.equal(out.ok, true);
  assert.ok(out.lines.some((l) => /^egress: not available/.test(l)));
});

test("each line fails on its own", () => {
  for (const status of ["INACTIVE", "PAUSING", "ACTIVE_UNHEALTHY", "RESTORING"]) {
    assert.equal(evaluate({ ...healthy, status }).ok, false, status);
  }
  assert.equal(evaluate({ ...healthy, dbBytes: DB_LIMIT_BYTES }).ok, true, "400 MB exactly is still fine");
  assert.equal(evaluate({ ...healthy, dbBytes: DB_LIMIT_BYTES + 1 }).ok, false, "above 400 MB fails");
  assert.equal(evaluate({ ...healthy, invocations24h: 13333 }).ok, true, "about 400k a month is the line");
  assert.equal(evaluate({ ...healthy, invocations24h: 13334 }).ok, false, "over 80% of 500k a month fails");
});

test("three exit codes: healthy, over a line, could not check", () => {
  assert.match(script, /process\.exit\(0\)/);
  assert.match(script, /process\.exit\(1\)/);
  assert.match(script, /process\.exit\(2\)/);
  assert.match(script, /supabase\/PROJECT_REF/);
  assert.doesNotMatch(script, /hvwakffluwvegedefoth/);
});

test("the workflow runs daily, needs only the Management token and the optional webhook, and cannot be silenced", () => {
  assert.match(wf, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\d+ \d+ \* \* \*"$/m);
  assert.match(wf, /^ {2}workflow_dispatch: \{\}$/m);
  const used = [...new Set([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ["ALERT_WEBHOOK_URL", "SUPABASE_ACCESS_TOKEN"]);
  assert.doesNotMatch(wf, /continue-on-error/);
  assert.match(wf, /node scripts\/check-free-tier\.mjs/);
});
