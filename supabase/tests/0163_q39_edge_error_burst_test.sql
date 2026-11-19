-- Q-39 (202611180004): more than 3 bad answers from one Edge Function within the last hour is a failure, even
-- when its latest answer was good. job_health_status() still says only ok / failing_count / last_checked_at.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

delete from public.edge_function_invocations;

-- notif_push_send: four 401s in the last hour, then one 200 (the latest). recap_weekly: three 500s only.
insert into public.edge_function_invocations (request_id, slug, invoked_at) values
  (916301, 'notif_push_send', now() - interval '50 minutes'),
  (916302, 'notif_push_send', now() - interval '40 minutes'),
  (916303, 'notif_push_send', now() - interval '30 minutes'),
  (916304, 'notif_push_send', now() - interval '20 minutes'),
  (916305, 'notif_push_send', now() - interval '5 minutes'),
  (916311, 'recap_weekly', now() - interval '50 minutes'),
  (916312, 'recap_weekly', now() - interval '40 minutes'),
  (916313, 'recap_weekly', now() - interval '30 minutes'),
  (916321, 'purge_abandoned_profiles', now() - interval '3 hours'),
  (916322, 'purge_abandoned_profiles', now() - interval '3 hours'),
  (916323, 'purge_abandoned_profiles', now() - interval '3 hours'),
  (916324, 'purge_abandoned_profiles', now() - interval '3 hours'),
  (916325, 'purge_abandoned_profiles', now() - interval '2 hours');
insert into net._http_response (id, status_code, timed_out, error_msg, created) values
  (916301, 401, false, null, now() - interval '50 minutes'),
  (916302, 401, false, null, now() - interval '40 minutes'),
  (916303, 401, false, null, now() - interval '30 minutes'),
  (916304, 401, false, null, now() - interval '20 minutes'),
  (916305, 200, false, null, now() - interval '5 minutes'),
  (916311, 500, false, null, now() - interval '50 minutes'),
  (916312, 500, false, null, now() - interval '40 minutes'),
  (916313, 200, false, null, now() - interval '30 minutes'),
  (916321, 500, false, null, now() - interval '3 hours'),
  (916322, 500, false, null, now() - interval '3 hours'),
  (916323, 500, false, null, now() - interval '3 hours'),
  (916324, 500, false, null, now() - interval '3 hours'),
  (916325, 200, false, null, now() - interval '2 hours');

select public.job_health_check();

select isnt_empty($$ select 1 from public.job_health_state where 'edge burst: notif_push_send' = any(failing_jobs) $$,
  'four 401s in the hour are a failure even though the latest answer was 200');
select is_empty($$ select 1 from public.job_health_state where 'edge: notif_push_send' = any(failing_jobs) $$,
  'and the latest-answer rule alone would have missed it');
select is_empty($$ select 1 from public.job_health_state where 'edge burst: recap_weekly' = any(failing_jobs) $$,
  'two bad answers are not a burst');
select is_empty($$ select 1 from public.job_health_state where 'edge burst: purge_abandoned_profiles' = any(failing_jobs) $$,
  'a burst older than an hour is over');

-- A timeout and a transport error count as bad answers too.
insert into public.edge_function_invocations (request_id, slug, invoked_at) values
  (916331, 'recap_weekly', now() - interval '10 minutes'),
  (916332, 'recap_weekly', now() - interval '9 minutes');
insert into net._http_response (id, status_code, timed_out, error_msg, created) values
  (916331, null, true, 'timed out', now() - interval '10 minutes'),
  (916332, null, false, 'connection refused', now() - interval '9 minutes');
select public.job_health_check();
select isnt_empty($$ select 1 from public.job_health_state where 'edge burst: recap_weekly' = any(failing_jobs) $$,
  'two 500s, a timeout and a transport error: four, a burst');

-- What the public status shows: a count, no names.
select is((select failing_count > 0 from public.job_health_status()), true, 'the public status counts it');
select is_empty($$ select 1 from public.job_health_status() s where row_to_json(s)::text like '%notif_push_send%' $$,
  'and names nothing');

select * from finish();
rollback;
