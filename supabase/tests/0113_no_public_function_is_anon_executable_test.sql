-- No function in `public` may be executable by `anon`, except one, by name.
--
-- THE ONE EXCEPTION, added 2026-09-19 (202609190001). `public.job_health_
-- status()` is deliberately granted to anon. It takes no arguments and
-- returns three fields - ok, failing_count, last_checked_at - and exists so
-- .github/workflows/scheduled-job-alert.yml can ask whether the scheduled
-- jobs are healthy using the publishable key from cloud-config.js instead of
-- SUPABASE_SERVICE_ROLE_KEY, a credential that bypasses every RLS policy on
-- real member data and had been sitting in GitHub Actions to answer a
-- yes/no question.
--
-- The exception is written as an EQUALITY, not as a hole. The assertion
-- below says the anon-executable set is exactly {job_health_status()}, so
-- this file still fails the build the day a second function arrives without
-- its `revoke all ... from public, anon` - which is the entire reason it
-- exists. Widening it is a deliberate edit here, with an argument, not an
-- accident somewhere else. supabase/tests/0116 asserts what that one
-- function may return.
--
-- WHAT THIS IS DEFENDING, and why it is a test rather than only a migration.
--
-- Every migration in this repo ends a function definition with the same pair:
--
--     revoke all on function public.X(...) from public, anon;
--     grant execute on function public.X(...) to authenticated;
--
-- Nineteen functions never got the first line. Supabase's security advisor
-- found four of them - it only inspects SECURITY DEFINER functions - and the
-- other fifteen turned up on inspection. 202609170001 revoked all nineteen and
-- narrowed the default privilege, and that is NOT enough on its own: Postgres
-- grants EXECUTE to PUBLIC on every new function by its own SQL default, anon
-- inherits through PUBLIC, and a second default-ACL entry owned by
-- supabase_admin cannot be altered by the role migrations run as. Measured,
-- not assumed - a probe function created after that migration still came out
-- anon-callable.
--
-- So the durable guard is here. This runs on every CI replay from empty, and
-- fails the build the day a function arrives without its revoke. That is the
-- whole point: the recurring defect in this codebase is a rule applied in one
-- place and not its twin, and the only thing that reliably catches it is an
-- assertion over ALL of them rather than a habit.
--
-- WHY ANON AND NOT AUTHENTICATED. anon is the role for a request with no JWT
-- at all. Nothing in this app needs it: zero RLS policies name it, and the
-- signup flow's signInAnonymously() produces an `authenticated` JWT with
-- is_anonymous = true, which is a different thing entirely. authenticated, by
-- contrast, is supposed to reach ~140 of these, so this test says nothing
-- about it.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- The set, stated exactly. set_eq prints both directions on failure: a
-- function that gained an anon grant it should not have, and equally a
-- job_health_status() that lost the one it needs (which would take the
-- monitoring workflow down silently, the failure mode that whole change
-- exists to close).
select set_eq(
  $$ select p.oid::regprocedure::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'execute') $$,
  $$ values ('job_health_status()') $$,
  'exactly one function in public is executable by anon, and it is job_health_status() - anything else here is a missing `revoke all on function ... from public, anon`');

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'execute')),
  1,
  'and there is exactly one of them - the count says so on its own, so an overload sneaking in under the same name is still a failure');

-- The named exception really is the one with no arguments. A `revoke` names a
-- signature, so an overload is a different function with default privileges -
-- the admin_actions_page lesson at the bottom of this file. If someone ever
-- adds job_health_status(text), it is NOT covered by the grant above and must
-- show up as a failure, which the count assertion above delivers.
select is(
  (select p.pronargs::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'job_health_status'
      and has_function_privilege('anon', p.oid, 'execute')),
  0,
  'the anon-callable job_health_status takes no arguments - there is nothing for a caller to pass, which is what makes the grant defensible');

-- THE OTHER DIRECTION, so this file cannot pass by locking everything down.
-- A revoke that also caught `authenticated` would close the hole and break
-- every screen in the app, and a test that only counts anon would call that a
-- success.
select ok(
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('authenticated', p.oid, 'execute')) > 100,
  'authenticated still reaches the RPCs the app is built on - over-revoking is the opposite failure and would otherwise look like a pass');

-- The specific four the advisor flagged, named so the finding stays legible
-- long after the CSV is gone. All four are trigger functions, so none was
-- callable even while granted - `select public.unpin_target()` raises
-- "trigger functions can only be called as triggers" - but the grant was real
-- and would have become live the day one stopped being a trigger.
select is_empty(
  format($$ select p.oid::regprocedure::text
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in (%L, %L, %L, %L)
               and has_function_privilege('anon', p.oid, 'execute') $$,
         'enforce_comment_depth', 'enforce_event_capacity',
         'enforce_pin_target', 'unpin_target'),
  'the four SECURITY DEFINER functions from the 2026-09-17 advisor report are closed');

-- admin_actions_page is the instructive one and gets its own assertion. It IS
-- revoked - twice - but for the THREE-argument signature. 202609150015 added a
-- four-argument overload and did not carry the revoke; 202609160007
-- re-declared that overload and did not either. A revoke names a signature, so
-- an overload is a new function with default privileges and the protection
-- silently does not extend to it.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_actions_page'
        and has_function_privilege('anon', p.oid, 'execute') $$,
  'every overload of admin_actions_page is closed to anon, not just the one a revoke happened to name');

select * from finish();
rollback;
