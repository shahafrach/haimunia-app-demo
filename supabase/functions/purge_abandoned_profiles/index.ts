// COMM-314. The versioned abandoned-profile purge Edge Function.
//
// Second Edge Function in this repo, after `recap_weekly` (COMM-220). Local
// test/invoke path is identical: `supabase functions serve
// purge_abandoned_profiles` (or `supabase start`, which boots the same
// runtime), then
// `curl -X POST http://127.0.0.1:54321/functions/v1/purge_abandoned_profiles
// -H "Authorization: Bearer <service_role key>"`.
// See docs/community/abandoned-profile-purge-runbook.md for the full manual-run,
// retention-window-change and post-run-verification runbook.
//
// Scope, per the ticket:
// - Runs as service_role only (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
//   injected by the Edge Runtime automatically; nothing is hardcoded).
// - "Abandoned" is real `auth.users.is_anonymous = true`, no
//   `invite_redemptions` row, no `profiles.recovery_verified_at`, NO
//   TRAINING DATA AT ALL (no private_records row, soft-deleted included,
//   and no attendance_log row - added by 202609070001, see PURGE_VERSION
//   below), and no activity for longer than RETENTION_DAYS below. An
//   account holding a training log is never deleted by this job under any
//   window. Not the same category `purge_due_accounts()`
//   (202608260001) already purges: that one is a member's own explicit
//   deletion request. See this repo's supabase/migrations/
//   202609010004_purge_abandoned_profiles.sql for the exact predicate.
// - Real deletion (auth.users, cascading through profiles and everything
//   foreign-keyed to it), never a soft-delete.
// - Never wires a scheduler (pg_cron or otherwise) - explicitly out of this
//   ticket's scope, the same "storage/logic exists, scheduler does not"
//   shape recap_weekly, chal_notify_ending_soon(),
//   coach_detect_engagement_decline() and recap_monthly_generate() all
//   already carry in this repo. Invoking this function on a schedule is a
//   separate, later decision - see the runbook for the manual path until
//   one exists.
//
// WHY THIS FILE DOES NOT QUERY auth.users, invite_redemptions OR profiles
// DIRECTLY, even though the ticket's own migration outline described it
// that way: supabase/config.toml's `[api] schemas = ["public",
// "graphql_public"]` is what PostgREST exposes to any caller, service-role
// key included. The service-role key bypasses RLS on exposed tables; it
// does not add `auth.users` to that exposed list, and there is no
// `supabase.from("auth.users")` that will ever resolve from this client.
// So the real identification-and-deletion work happens inside
// `public.purge_abandoned_profiles(p_retention_days)`
// (202609010004), a SECURITY DEFINER Postgres function granted to
// service_role only, and this file's whole job is: verify the caller,
// call that function with today's retention window, and log/return the
// counts it reports. Same shape `recap_weekly` already uses for
// `recap_weekly_classmates()`.
//
// STORAGE ERASURE (202609230001). This function also drains
// public.storage_erasure_queue: the photos of every account deleted since the
// last run, queued by a BEFORE DELETE trigger on auth.users. It lives here
// rather than in a function of its own because this is the account-purge job
// that already runs nightly with the service-role key, and the drain is the
// second half of the same deletion. The SQL purge (purge-due-accounts) runs
// at 03:29, two minutes before this, so a member purged tonight loses their
// photos tonight. A row is cleared only after storage.remove() returns no
// error for its batch; anything the API refused is retried the next night.
// See drainStorageErasure() below.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

// "Versioned": a change to the abandonment predicate in
// public.purge_abandoned_profiles()'s WHERE clause (202609010004) must
// bump this, the same spirit SCHEMA_VERSION carries in src/analytics.js -
// one more place a definition can change without silently reinterpreting
// an old run. This number is written into every log line and into the
// function's own response, so a later reader of run history can tell a
// run under the old rule apart from one under the new rule even though
// both wrote the same-shaped {checked, success, failure} record.
//
// v2 (202609070001) - THE PREDICATE CHANGED, so this is exactly the bump
// 202609010004 asked for. Two narrowings:
//   * An account that HOLDS TRAINING DATA is never purged. private_records
//     cascades from auth.users, and cloud backup opens an anonymous account
//     on the member's first saved set - so under v1 every backup-only
//     member's whole training history was deleted on day 31. v1's counts
//     must therefore be read as "accounts deleted, some of which held real
//     logs"; v2's cannot contain such an account at all.
//   * The window is measured from LAST ACTIVITY (greatest of created_at and
//     last_sign_in_at) rather than created_at alone, so an account still in
//     daily use is not eligible merely for being old.
// v2 also adds a fourth count, retained_with_data - accounts that met all
// four of v1's conditions and were spared only by the new guard. On the
// first v2 runs that number IS the set of members v1 would have wiped.
const PURGE_VERSION = 2;

// The retention window, read from one named constant so changing it is a
// one-line edit here, not a migration and not a redeploy of the
// abandonment predicate itself. Confirmed 2026-08-31: 30 days, matching
// the existing purge_due_accounts() window (COMM-314's own resolved open
// question). See docs/community/abandoned-profile-purge-runbook.md for how to
// change this safely.
const RETENTION_DAYS = 30;

// Launch-readiness audit, SEC-017. Same fix as recap_weekly's own copy of
// this helper - plain `!==` short-circuits at the first differing byte,
// a genuine (if low-practicality-over-a-real-network) timing side channel
// on the service-role key. Not shared via an import: these two files are
// deployed as independent Edge Functions.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

// Storage's remove() takes a list of paths per bucket. 100 per call keeps
// each request small; STORAGE_BATCH_LIMIT caps one night's work so a very
// large backlog is drained over several runs rather than timing out in one.
const STORAGE_REMOVE_CHUNK = 100;
const STORAGE_BATCH_LIMIT = 2000;

async function drainStorageErasure(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("storage_erasure_pending", { p_limit: STORAGE_BATCH_LIMIT });
  if (error) throw error;
  const byBucket = new Map<string, string[]>();
  for (const row of (data ?? []) as { bucket_id: string; object_name: string }[]) {
    if (!byBucket.has(row.bucket_id)) byBucket.set(row.bucket_id, []);
    byBucket.get(row.bucket_id)!.push(row.object_name);
  }
  let removed = 0;
  let failed = 0;
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += STORAGE_REMOVE_CHUNK) {
      const chunk = names.slice(i, i + STORAGE_REMOVE_CHUNK);
      // A path that is already gone is not an error to Storage, so a rerun
      // after a partial failure clears it rather than retrying forever.
      const { error: removeErr } = await supabase.storage.from(bucket).remove(chunk);
      if (removeErr) { failed += chunk.length; continue; }
      const { error: doneErr } = await supabase.rpc("storage_erasure_done", { p_bucket: bucket, p_names: chunk });
      if (doneErr) { failed += chunk.length; continue; }
      removed += chunk.length;
    }
  }
  return { queued: (data ?? []).length, removed, failed };
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(`purge_abandoned_profiles v${PURGE_VERSION}: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY`);
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The platform's own verify_jwt only proves the caller presented SOME
  // valid JWT - the anon key already shipped client-side in cloud-config.js
  // satisfies it just as well as the service role key does. That is not
  // this function's intent (see the file header: "Runs as service_role
  // only"), and it matters concretely here: an unauthenticated caller
  // could otherwise force a real deletion run against the real database on
  // demand, repeatedly. Same exact check recap_weekly established
  // (COMM-220): only a caller presenting the actual service role key (a
  // scheduler invoking this with it, or a manual ops run per the runbook)
  // gets past this line.
  if (!timingSafeEqualStrings(req.headers.get("Authorization") || "", `Bearer ${serviceRoleKey}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const { data, error } = await supabase.rpc("purge_abandoned_profiles", {
      p_retention_days: RETENTION_DAYS,
    });
    if (error) throw error;

    // The RPC's own return shape is {checked, success, failure,
    // retained_with_data} - no personal content, matching recap_weekly and
    // purge_due_accounts' existing discipline. version/retention_days/ran_at
    // are added here so the log record and the response are self-describing
    // without a second lookup.
    //
    // retained_with_data is surfaced and logged rather than dropped: it is
    // the only signal that the v2 training-data guard is actually holding,
    // and a run that reports a nonzero value is a run that would have
    // destroyed that many members' logs under v1.
    const result = {
      version: PURGE_VERSION,
      retention_days: RETENTION_DAYS,
      ran_at: new Date().toISOString(),
      checked: data?.checked ?? 0,
      success: data?.success ?? 0,
      failure: data?.failure ?? 0,
      retained_with_data: data?.retained_with_data ?? 0,
      storage: { queued: 0, removed: 0, failed: 0, error: false },
    };

    // After the purge, so objects queued by THIS run's deletions go tonight
    // too. Its own try: a Storage outage must not turn a completed account
    // purge into a reported failure, and must not hide one either.
    try {
      result.storage = { ...(await drainStorageErasure(supabase)), error: false };
    } catch (_err) {
      result.storage.error = true;
      console.error(`purge_abandoned_profiles v${PURGE_VERSION}: storage erasure drain failed`);
    }
    console.log(`purge_abandoned_profiles v${PURGE_VERSION}: run done`, {
      retention_days: result.retention_days,
      checked: result.checked,
      success: result.success,
      failure: result.failure,
      retained_with_data: result.retained_with_data,
      storage: result.storage,
    });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (_err) {
    console.error(`purge_abandoned_profiles v${PURGE_VERSION}: run failed`);
    return new Response(JSON.stringify({ error: "purge_abandoned_profiles run failed", version: PURGE_VERSION }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
