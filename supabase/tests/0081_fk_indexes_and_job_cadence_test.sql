-- Production-readiness audit, 2026-09-06 (202609060015).
-- DB-M3 (FK indexes) and scheduled_job_health()'s per-job staleness window.
-- The staff-impersonation and dormant-job sections went with their features
-- in 202610250001.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. DB-M3 - every non-club_id FK column now leads an index
-- =====================================================================
-- Asserted as a PROPERTY over the catalog rather than as 28 hand-written
-- index-name checks: a future migration adding a new foreign key without
-- an index fails this test automatically, which a name list would not.
select is(
  (select count(*)::int
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(con.conkey)
     join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f'
      and n.nspname = 'public'
      and a.attname <> 'club_id'
      and not exists (
        select 1 from pg_index i
         where i.indrelid = c.oid and a.attnum = i.indkey[0]
      )),
  0,
  'DB-M3: no public FK column outside club_id is left without a leading index - a cascade delete no longer sequentially scans the child table');

-- club_id is deliberately excluded and deliberately NOT indexed - see the
-- migration's own section 2. This assertion pins that it is a conscious
-- exclusion by proving the single-club invariant that justifies it is real.
select ok(
  (select count(*)::int from public.clubs) = 1,
  'and club_id stays unindexed on purpose because exactly one club row exists - the invariant clubs_guard_single_row() enforces');

-- =====================================================================
-- 4. scheduled_job_health()'s staleness window follows each job's cadence
-- =====================================================================
-- 202609060016 used a flat 8 days for every job. recap_monthly runs on the
-- 1st, so from ~the 9th onward it reported unhealthy every month while
-- being fine - a permanent false positive on the one surface whose value
-- is being trusted. Found by reading the real production output.
select is(
  (select case
     when split_part('41 4 1 * *',' ',3) <> '*' then 'monthly'
     when split_part('41 4 1 * *',' ',5) <> '*' then 'weekly'
     when split_part('41 4 1 * *',' ',2) <> '*' then 'daily'
     else 'hourly' end),
  'monthly',
  'a day-of-month cron expression is classified monthly, not daily - this is the classification the window derives from');
select is(
  (select case
     when split_part('11 5 * * 1',' ',3) <> '*' then 'monthly'
     when split_part('11 5 * * 1',' ',5) <> '*' then 'weekly'
     when split_part('11 5 * * 1',' ',2) <> '*' then 'daily'
     else 'hourly' end),
  'weekly',
  'and a day-of-week expression is weekly');
-- THE WINDOW MOVED. 202609190001 lifted the per-cadence `case` out of
-- scheduled_job_health()'s body into public.cron_cadence_window(), so that
-- job_health_check() could share it instead of carrying a second copy. The
-- two assertions here used to read the literal back out of prosrc, and that
-- refactor broke them in the two different ways a textual guard breaks:
-- the first went RED, and the second went VACUOUSLY GREEN - `not like
-- '%interval ''8 days''%'` is trivially true of a body that no longer
-- contains any window at all, so it would have gone on passing forever while
-- asserting nothing. Only the red one announced itself.
--
-- Both are restated against the helper, which is where the rule lives now,
-- and both are behavioural rather than textual: they CALL the function and
-- compare intervals instead of grepping its source. A future move cannot
-- make these pass by accident the way the second one just did.
select is(
  public.cron_cadence_window('41 4 1 * *'),
  interval '35 days',
  'the monthly cadence carries a 35-day window, so recap_monthly is not permanently flagged');
-- The rule being right is half of it; the operator view still having to go
-- through it is the other half. Without this, scheduled_job_health() could
-- quietly grow its own copy again and the assertion above would not notice.
select ok(
  (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%cron_cadence_window%',
  'and scheduled_job_health() derives that window from the one shared helper rather than a second copy of the case expression');
select ok(
  public.cron_cadence_window('41 4 1 * *') <> public.cron_cadence_window('11 5 * * 1')
  and public.cron_cadence_window('11 5 * * 1') <> public.cron_cadence_window('41 4 * * *')
  and public.cron_cadence_window('41 4 * * *') <> public.cron_cadence_window('*/15 * * * *'),
  'and the flat window that caused the false positive is gone - four cadences produce four different windows, which no single flat constant can do');
-- The behaviour that must NOT be relaxed by the above.
select ok(
  (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%coalesce(%false)%'
  or (select prosrc from pg_proc where proname = 'scheduled_job_health') like '%, false) as healthy%',
  'a never-run job is still coalesced to unhealthy - exactly the state purge_due_accounts sat in undetected');

select * from finish();
rollback;
