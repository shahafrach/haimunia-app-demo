// No GitHub workflow may hold a Supabase service-role key.
//
// WHAT THIS IS DEFENDING. `scheduled-job-alert.yml` existed to notice when a
// pg_cron job stops running, and the only function that could answer that -
// `public.scheduled_job_health()` - is service_role only by design, because it
// returns every job's name, schedule and last error. So the workflow carried
// `SUPABASE_SERVICE_ROLE_KEY`: a credential that bypasses every RLS policy on
// real members' posts, profiles and training logs, living in GitHub Actions,
// in order to answer a yes/no question. Migration 202609190001 moved the check
// INSIDE the database (the hourly `job-health-check` job) and exposed only its
// verdict through `public.job_health_status()` - three fields, no arguments,
// granted to anon - so the workflow now runs on the publishable key that is
// already committed in cloud-config.js and served to every browser.
//
// WHY A TEST AND NOT JUST A COMMENT. "Do not reintroduce the service-role key"
// is precisely the kind of rule that gets undone by somebody adding one more
// field to an alert and reaching for the key that used to be there - and the
// damage of that is invisible until it is enormous. The sweep below is over
// EVERY workflow rather than over this one, which is the same shape as
// supabase/tests/0113: this codebase's characteristic defect is a right rule
// applied in one place and missed in its twin, and the only thing that
// reliably catches it is an assertion over all of them.
//
// SUPABASE_DB_URL (backup-database.yml) and SUPABASE_ACCESS_TOKEN
// (deploy-edge-functions.yml) are deliberately NOT covered here. Taking a
// backup and deploying a function genuinely require those; answering "is the
// backend healthy" never did.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

const wfDir = new URL("../.github/workflows/", import.meta.url);
const workflows = fs.readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("no workflow reads secrets.SUPABASE_SERVICE_ROLE_KEY", () => {
  assert.ok(workflows.length > 0, "expected .github/workflows/*.yml to exist");
  const offenders = workflows.filter((f) =>
    /\$\{\{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY/.test(fs.readFileSync(new URL(f, wfDir), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "a service-role key bypasses every RLS policy on real member data; no CI job needs one",
  );
});

test("scheduled-job-alert asks job_health_status(), the anon-safe three-field summary", () => {
  const wf = fs.readFileSync(new URL("scheduled-job-alert.yml", wfDir), "utf8");
  assert.match(wf, /node scripts\/check-scheduled-job-health\.mjs/, "the workflow still runs the check script");
  // The only secret left, and it is optional: with it unset the workflow's own
  // red run is the alert. That is why the job must not opt out of failing.
  assert.doesNotMatch(wf, /continue-on-error/, "the alert must fail the run, or it is not an alert");

  const script = fs.readFileSync(new URL("../scripts/check-scheduled-job-health.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(
    script,
    /process\.env\.SUPABASE_SERVICE_ROLE_KEY/,
    "the check script must not read a service-role key either - the workflow is only half of the path",
  );
  assert.match(script, /rpc\/job_health_status/, "it calls the anon-safe RPC");
  assert.doesNotMatch(
    script,
    /rpc\/scheduled_job_health/,
    "and not the service_role operator view, which returns job names and error text",
  );
  assert.match(
    script,
    /supabasePublishableKey/,
    "it reads the publishable key from cloud-config.js, the same way check-edge-functions-deployed.mjs does",
  );
});

test("the check fails on a stale verdict, not only on ok:false", () => {
  // The half that is easy to drop and the half that matters most. `ok` is a
  // stored opinion: if the hourly in-database check has died, a frozen
  // `ok: true` reads exactly like a healthy backend - the same silent-failure
  // shape as purge_due_accounts(), which sat unscheduled for the life of the
  // project because a job that does not run emits nothing at all.
  const script = fs.readFileSync(new URL("../scripts/check-scheduled-job-health.mjs", import.meta.url), "utf8");
  assert.match(script, /MAX_AGE_MINUTES\s*=\s*120\b/, "two hours: one missed hourly run tolerated, two not");
  assert.match(script, /last_checked_at/, "the staleness field is actually read");
  assert.match(script, /ageMinutes > MAX_AGE_MINUTES/, "and compared, not merely logged");
});

