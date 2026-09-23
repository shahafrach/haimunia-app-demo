-- Launch-readiness S6: a scheduled job that did nothing stops reporting green
-- (202609230008).
--
-- The defect was not that the checker was wrong about what it measured. It
-- was that two ways of failing produced no evidence for it to read:
--
--   * An Edge Function returning 500 forever. cron.job_run_details records
--     `succeeded`, because the SQL that queued the request succeeded.
--   * Placeholder Vault secrets. cron_invoke_edge_function() returns null
--     without sending anything, and the job succeeds having done nothing.
--
-- Both are the shape of launch-readiness B2 moved into the monitoring layer:
-- a surface reporting health it never measured, which is worse than no
-- surface because it turns "we do not know" into "we are fine".
--
-- Each assertion below is paired with its opposite, because a checker that
-- flags everything is as useless as one that flags nothing.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- ---------------------------------------------------------------------------
-- The ledger is operator-only, like job_health_state itself.
-- ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.edge_function_invocations'::regclass),
  'edge_function_invocations has RLS enabled');
select is_empty(
  $$ select 1 from pg_policies
      where schemaname = 'public' and tablename = 'edge_function_invocations' $$,
  'and no policy at all - only SECURITY DEFINER functions reach it');
select ok(not has_table_privilege('anon', 'public.edge_function_invocations', 'select'),
  'anon has no direct select on the ledger');
select ok(not has_table_privilege('authenticated', 'public.edge_function_invocations', 'select'),
  'and neither does a signed-in member');

select ok(not has_function_privilege('anon', 'public.edge_functions_ready()', 'execute'),
  'anon cannot ask whether the deployment is configured');
select ok(not has_function_privilege('authenticated', 'public.edge_functions_ready()', 'execute'),
  'nor can a member - it is not their business, and job_health_check() is the only caller');

-- ---------------------------------------------------------------------------
-- The secrets check itself.
-- ---------------------------------------------------------------------------
-- On a fresh local stack the secrets are placeholders, which is exactly the
-- state this half of the feature exists to notice.
select ok(not public.edge_functions_ready(),
  'a stack whose Vault secrets are still placeholders is NOT ready');

-- ---------------------------------------------------------------------------
-- The whole point: placeholders make the board red, not green.
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.job_health_check() $$, 'the checker runs');

select isnt_empty(
  $$ select 1 from public.job_health_state
      where 'edge functions: Vault secrets unset or still placeholders' = any(failing_jobs) $$,
  'THE SILENT FAILURE IS NAMED: scheduled jobs exist to invoke Edge Functions and the
   secrets are placeholders, so every one of them is a no-op that reports success');

select ok(
  (select not ok from public.job_health_state),
  'and the board is not ok - which before 202609230008 it was, with nothing running at all');

-- ---------------------------------------------------------------------------
-- A bad HTTP answer is attributed to the slug that caused it.
-- ---------------------------------------------------------------------------
-- pg_net records a response under a request id and nothing else remembers
-- what that id was for; the ledger is what makes this attributable rather
-- than "something returned 500".
insert into public.edge_function_invocations (request_id, slug, invoked_at)
values (913001, 'recap_weekly', now() - interval '1 hour'),
       (913002, 'notif_push_send', now() - interval '1 hour');

insert into net._http_response (id, status_code, timed_out, error_msg, created)
values (913001, 500, false, null, now() - interval '1 hour'),
       (913002, 200, false, null, now() - interval '1 hour');

select public.job_health_check();

select isnt_empty(
  $$ select 1 from public.job_health_state where 'edge: recap_weekly' = any(failing_jobs) $$,
  'a 500 is flagged, named by the slug rather than as an anonymous failure');
select is_empty(
  $$ select 1 from public.job_health_state where 'edge: notif_push_send' = any(failing_jobs) $$,
  'and a 200 is NOT flagged - the check discriminates, it does not simply alarm');

-- A timeout and a transport error count too, and are the cases a status code
-- alone would miss entirely.
insert into public.edge_function_invocations (request_id, slug, invoked_at)
values (913003, 'purge_abandoned_profiles', now() - interval '30 minutes');
insert into net._http_response (id, status_code, timed_out, error_msg, created)
values (913003, null, true, 'timed out', now() - interval '30 minutes');
select public.job_health_check();
select isnt_empty(
  $$ select 1 from public.job_health_state
      where 'edge: purge_abandoned_profiles' = any(failing_jobs) $$,
  'a timeout with no status code is flagged too');

-- ---------------------------------------------------------------------------
-- Recovery, and the 24-hour window.
-- ---------------------------------------------------------------------------
-- Only the LATEST invocation of a slug counts. A 500 at 03:00 that has since
-- recovered must stop being reported, or the board becomes a history of every
-- bad minute the project ever had and nobody reads it.
insert into public.edge_function_invocations (request_id, slug, invoked_at)
values (913004, 'recap_weekly', now() - interval '5 minutes');
insert into net._http_response (id, status_code, timed_out, error_msg, created)
values (913004, 200, false, null, now() - interval '5 minutes');
select public.job_health_check();
select is_empty(
  $$ select 1 from public.job_health_state where 'edge: recap_weekly' = any(failing_jobs) $$,
  'a slug that has since answered 200 stops being flagged - latest wins, not worst-ever');

-- Older than 24 hours is out of scope entirely.
update public.edge_function_invocations
   set invoked_at = now() - interval '3 days' where slug = 'purge_abandoned_profiles';
select public.job_health_check();
select is_empty(
  $$ select 1 from public.job_health_state
      where 'edge: purge_abandoned_profiles' = any(failing_jobs) $$,
  'and a failure older than 24 hours is not carried forever');

-- ---------------------------------------------------------------------------
-- The ledger is pruned, so it cannot grow without bound.
-- ---------------------------------------------------------------------------
insert into public.edge_function_invocations (request_id, slug, invoked_at)
values (913005, 'recap_weekly', now() - interval '30 days');
select public.job_health_check();
select is_empty(
  $$ select 1 from public.edge_function_invocations where request_id = 913005 $$,
  'an invocation older than 7 days is deleted by the check that reads it');

-- ---------------------------------------------------------------------------
-- None of this reaches the member-facing status function.
-- ---------------------------------------------------------------------------
-- job_health_status() is the one thing anon may call in this project. It must
-- keep returning only ok / failing_count / last_checked_at: WHICH job is
-- failing, and that a deployment is misconfigured, are operator detail.
-- Asserted against the function's SIGNATURE rather than a row, because the
-- guarantee is about what the shape can ever carry, not about today's values.
select is(
  pg_get_function_result('public.job_health_status()'::regprocedure),
  'TABLE(ok boolean, failing_count integer, last_checked_at timestamp with time zone)',
  'job_health_status() still returns exactly three columns - no slug, no secret state,
   nothing 202609230008 added; the new detail lives in failing_jobs, which is operator-only');

select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select * from public.job_health_status() $$,
  'and a member can still read it, unchanged');
select tests.clear_auth();

select * from finish();
rollback;
