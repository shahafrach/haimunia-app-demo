begin;

-- 202608270002 LOCKED THE DEFAULTS FOR TABLES AND SEQUENCES, AND NOT FOR
-- FUNCTIONS. This finishes it.
--
-- Supabase's bootstrap grants EXECUTE on functions in `public` to anon,
-- authenticated and service_role, and a newly created function additionally
-- carries the SQL default of EXECUTE to PUBLIC. Every migration in this repo
-- knows that and ends with the same two lines:
--
--     revoke all on function public.X(...) from public, anon;
--     grant execute on function public.X(...) to authenticated;
--
-- Nineteen functions never got the first line. Found by Supabase's own
-- security advisor, which flagged four of them - it only looks at SECURITY
-- DEFINER functions - and the other fifteen turned up on inspection.
--
-- NONE OF THE NINETEEN IS EXPLOITABLE TODAY, and that is worth stating
-- precisely rather than waving at:
--
--   * Sixteen are TRIGGER functions. Postgres refuses to call one directly -
--     verified: `select public.unpin_target()` raises "trigger functions can
--     only be called as triggers". The grant is real and the call is not
--     possible. It becomes possible the day one of them stops being a
--     trigger function, which is exactly the kind of change nobody thinks to
--     re-check grants for.
--   * admin_actions_page and notif_list are SECURITY INVOKER, so RLS applies
--     to the caller. An anon session reads nothing through them, and
--     admin_actions_page raises 'not authorized' on its own is_admin() check
--     (202609160007) before that matters.
--   * pr_payload_mod_ms(jsonb) is a pure function over a value the caller
--     already has. It reads nothing.
--
-- admin_actions_page is the instructive one. It IS revoked - twice - but for
-- the THREE-argument signature. 202609150015 added a four-argument overload
-- for the tie-breaking cursor and did not carry the revoke, and 202609160007
-- re-declared that overload to fix the audit-log gate and did not either. A
-- revoke names a signature, so an overload is a new function with default
-- privileges, and the protection silently did not extend to it.
--
-- Three parts, and the third is the one that actually holds the line:
--   1. Revoke on what exists.
--   2. Narrow the default for what comes next. This helps and does NOT
--      close it - see that section's own note, which is measured rather
--      than hoped.
--   3. A pgTAP assertion, which runs on every CI replay and fails the build
--      the day a new function arrives ungranted. That is the durable guard.

-- ---------------------------------------------------------------------------
-- 1. Everything that exists now.
-- ---------------------------------------------------------------------------
do $do$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    n := n + 1;
  end loop;
  raise notice 'revoked EXECUTE from public/anon on % function(s)', n;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. Narrow the default for what comes next - PARTIALLY, and here is exactly
--    how far it gets.
--
-- MEASURED, because the first version of this comment claimed it closed the
-- gap and a probe function proved otherwise. After this ALTER, a function
-- created by postgres in this schema comes out as:
--
--     =X/postgres | postgres=X | authenticated=X | service_role=X
--
-- The explicit `anon=X` is gone, which is what this line removes. The leading
-- `=X` is PUBLIC, which Postgres grants on every new function by its own SQL
-- default, and anon inherits EXECUTE through it. So a brand-new function is
-- still anon-callable, and section 3 is what catches that.
--
-- It cannot be fixed further from here. A second default-ACL entry, owned by
-- supabase_admin, also grants anon on this schema, and `alter default
-- privileges for role supabase_admin` raises "permission denied to change
-- default privileges" when run as postgres - the same wall
-- 202609120008 documented for tables and could not get past either. Closing
-- it properly needs somebody with dashboard/superuser access to run that
-- ALTER as supabase_admin, once, by hand.
--
-- Deliberately only PUBLIC and anon, never authenticated: every RPC here is
-- meant to be callable by a signed-in member and grants itself explicitly, so
-- revoking the authenticated default would turn one forgotten line into a
-- broken feature instead of a closed door.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------------
-- 3. Fail the migration if section 1 missed anything. The standing guard is
--    supabase/tests/0113, which asserts the same thing on every CI replay.
-- ---------------------------------------------------------------------------
do $do$
declare
  leftover text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
    into leftover
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'execute');
  if leftover is not null then
    raise exception 'anon can still execute: %', leftover;
  end if;
end
$do$;

commit;
