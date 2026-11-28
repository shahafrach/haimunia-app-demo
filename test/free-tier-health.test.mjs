// Q-50: the daily free-tier check (scripts/check-free-tier.mjs, .github/workflows/free-tier-health.yml).
// Q-66: logs.all answered HTTP 410 every day from 2026-11-22, and the check reported it as "could not check",
// the same red as a timeout. The invocation count is dropped, and an API 404/410 now reads "check broken"
// (exit 3), apart from "could not check" (exit 2) and "over a line" (exit 1). Fixtures below stand in for the API.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluate, measure, classifyFailure, ApiError, MB, DB_LIMIT_BYTES } from "../scripts/check-free-tier.mjs";

const wf = fs.readFileSync(new URL("../.github/workflows/free-tier-health.yml", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../scripts/check-free-tier.mjs", import.meta.url), "utf8");
const healthy = { status: "ACTIVE_HEALTHY", dbBytes: 50 * MB };
const REF = "testref";

// A fake Management API: `routes` maps "METHOD /path" to [status, body].
function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const key = `${init.method || "GET"} ${path}`;
    calls.push(key);
    const [status, body] = routes[key] || [404, { message: "not found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}
const OK_ROUTES = {
  [`GET /v1/projects/${REF}`]: [200, { status: "ACTIVE_HEALTHY" }],
  [`POST /v1/projects/${REF}/database/query`]: [200, [{ bytes: 50 * MB }]],
};

test("healthy numbers pass; invocations and egress are named as not checked", () => {
  const out = evaluate(healthy);
  assert.equal(out.ok, true);
  assert.ok(out.lines.some((l) => /^egress: not available/.test(l)));
  assert.ok(out.lines.some((l) => /^edge function invocations: not checked here/.test(l)));
});

test("each line fails on its own", () => {
  for (const status of ["INACTIVE", "PAUSING", "ACTIVE_UNHEALTHY", "RESTORING"]) {
    assert.equal(evaluate({ ...healthy, status }).ok, false, status);
  }
  assert.equal(evaluate({ ...healthy, dbBytes: DB_LIMIT_BYTES }).ok, true, "400 MB exactly is still fine");
  assert.equal(evaluate({ ...healthy, dbBytes: DB_LIMIT_BYTES + 1 }).ok, false, "above 400 MB fails");
});

test("fixture: a healthy project is measured from status + database size only (no logs endpoint)", async () => {
  const api = fakeApi(OK_ROUTES);
  const m = await measure(REF, "token", { fetchImpl: api.fetchImpl });
  assert.deepEqual(m, { status: "ACTIVE_HEALTHY", dbBytes: 50 * MB });
  assert.ok(!api.calls.some((c) => /logs\.all|analytics/.test(c)), "the gone endpoint is not called");
  assert.equal(evaluate(m).ok, true);
});

test("fixture: quota near the limit is exit 1's case, not a failure to check", async () => {
  const api = fakeApi({ ...OK_ROUTES, [`POST /v1/projects/${REF}/database/query`]: [200, [{ bytes: DB_LIMIT_BYTES + MB }]] });
  const out = evaluate(await measure(REF, "token", { fetchImpl: api.fetchImpl }));
  assert.equal(out.ok, false);
  assert.match(out.problems.join(" "), /above 400 MB/);
});

test("fixture: an API 410 or 404 is 'check broken' (exit 3), said apart from quota", async () => {
  for (const status of [410, 404]) {
    const api = fakeApi({ ...OK_ROUTES, [`POST /v1/projects/${REF}/database/query`]: [status, { message: "Gone" }] });
    const err = await measure(REF, "token", { fetchImpl: api.fetchImpl }).then(() => null, (e) => e);
    assert.ok(err instanceof ApiError && err.status === status);
    const f = classifyFailure(err, REF);
    assert.equal(f.exitCode, 3, String(status));
    assert.match(f.message, /BROKEN/);
    assert.match(f.message, /not a quota problem/);
  }
});

test("fixture: a 5xx, a 429 or a timeout is 'could not check' (exit 2)", async () => {
  for (const status of [500, 503, 429, 401]) {
    const api = fakeApi({ ...OK_ROUTES, [`GET /v1/projects/${REF}`]: [status, {}] });
    const err = await measure(REF, "token", { fetchImpl: api.fetchImpl }).then(() => null, (e) => e);
    const f = classifyFailure(err, REF);
    assert.equal(f.exitCode, 2, String(status));
    assert.doesNotMatch(f.message, /BROKEN/);
  }
  assert.equal(classifyFailure(new Error("The operation was aborted due to timeout"), REF).exitCode, 2);
});

test("four exit codes: healthy, over a line, could not check, check broken", () => {
  assert.match(script, /process\.exit\(0\)/);
  assert.match(script, /process\.exit\(1\)/);
  assert.match(script, /process\.exit\(2\)/);
  assert.match(script, /exitCode: 3/);
  assert.match(script, /supabase\/PROJECT_REF/);
  assert.doesNotMatch(script, /hvwakffluwvegedefoth/);
  assert.doesNotMatch(script, /logs\.all\?/, "the gone endpoint is not called any more");
});

test("the workflow runs daily, needs only the Management token and the optional webhook, and cannot be silenced", () => {
  assert.match(wf, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\d+ \d+ \* \* \*"$/m);
  assert.match(wf, /^ {2}workflow_dispatch: \{\}$/m);
  const used = [...new Set([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ["ALERT_WEBHOOK_URL", "SUPABASE_ACCESS_TOKEN"]);
  assert.doesNotMatch(wf, /continue-on-error/);
  assert.match(wf, /node scripts\/check-free-tier\.mjs/);
});
