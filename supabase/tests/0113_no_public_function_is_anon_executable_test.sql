-- No function in `public` may be executable by `anon`.
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

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'execute')),
  0,
  'no function in public is executable by anon - if this fails, the listing below names the ones missing `revoke all on function ... from public, anon`');

-- Names them, because a bare count tells whoever broke it nothing. is_empty
-- prints the offending rows on failure.
select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'execute') $$,
  'and here is which ones, if any');

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
