// The keep-alive heartbeat must stay public-only and must keep pinging the
// one thing anon is allowed to call.
//
// Two ways this could rot without anyone noticing, and a test for each:
// somebody "fixes" a failing heartbeat by reaching for a service-role key,
// and somebody changes the ping target to something anon cannot execute, so
// every run 401s at the gateway and the project pauses anyway while the logs
// look busy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const worker = readFileSync(new URL("workers/keepalive/src/index.js", root), "utf8");
const toml = readFileSync(new URL("workers/keepalive/wrangler.toml", root), "utf8");
const wf = readFileSync(new URL(".github/workflows/keepalive.yml", root), "utf8");
const config = readFileSync(new URL("cloud-config.js", root), "utf8");

test("neither heartbeat path can carry a privileged key", () => {
  for (const [name, src] of [["worker", worker], ["wrangler.toml", toml], ["workflow", wf]]) {
    assert.ok(!/sb_secret_[A-Za-z0-9_-]/.test(src), `${name} must not contain a secret key`);
    assert.ok(!/SERVICE_ROLE|service_role_key/i.test(src.replace(/service-role/gi, "")),
      `${name} must not reference a service-role key`);
  }
  // And the worker refuses at runtime rather than trusting the config.
  assert.match(worker, /looksLikeSecretKey/, "the worker checks the key it is handed");
  assert.match(worker, /sb_secret_/, "the check knows the current secret-key prefix");
});

test("the wrangler vars are the same public values the browser already gets", () => {
  const url = config.match(/supabaseUrl: *"([^"]+)"/)[1];
  const key = config.match(/supabasePublishableKey: *"([^"]+)"/)[1];
  assert.ok(toml.includes(url), "wrangler.toml points at the project cloud-config.js names");
  assert.ok(toml.includes(key), "wrangler.toml uses the publishable key from cloud-config.js");
  assert.match(key, /^sb_publishable_/, "and that key really is a publishable one");
});

test("both paths ping the one function anon may execute", () => {
  // 202609170001 revoked anon EXECUTE on everything else, and no table is
  // anon-selectable. If this target ever changes, the new one has to be
  // anon-callable or the heartbeat stops reaching Postgres.
  assert.match(worker, /rest\/v1\/rpc\/job_health_status/, "worker pings job_health_status");
  assert.match(wf, /rest\/v1\/rpc\/job_health_status/, "workflow pings job_health_status");
});

test("the heartbeat runs at least every three days, well inside the seven-day pause window", () => {
  const cron = toml.match(/crons\s*=\s*\[\s*"([^"]+)"/)[1];
  const dom = cron.split(/\s+/)[2];
  const everyN = dom.startsWith("*/") ? Number(dom.slice(2)) : null;
  assert.ok(everyN !== null && everyN <= 3,
    `the worker cron must fire at least every 3 days, got "${cron}"`);
});

test("the Actions heartbeat is scheduled at least every three days", () => {
  // Since 2026-10-25 the workflow is the primary heartbeat: the repository is
  // public (free minutes) and the Worker is not deployed.
  const m = wf.match(/^\s{2}schedule:\s*\n(?:\s*#.*\n)*\s*-\s*cron:\s*"([^"]+)"/m);
  assert.ok(m, "the schedule trigger is active");
  const dom = m[1].split(/\s+/)[2];
  const everyN = dom.startsWith("*/") ? Number(dom.slice(2)) : null;
  assert.ok(everyN !== null && everyN <= 3, `the workflow cron must fire at least every 3 days, got "${m[1]}"`);
  assert.match(wf, /^\s{2}workflow_dispatch:/m, "and it can still be run by hand");
});
