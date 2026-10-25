-- Definer guard: re-assert the pin and the grants on every SECURITY DEFINER
-- function in public.
--
-- supabase/tests/0135_definer_guard_test.sql now fails the build for any
-- definer function without search_path = '', with EXECUTE held by PUBLIC, or
-- with EXECUTE held by anon without a reviewed reason. All 52 functions alive
-- after strip gym already satisfied this when their bodies were read (every
-- reference in each is schema-qualified), so this migration changes no body,
-- no return type and no one's access. It makes the state independent of how
-- each function was created: a function whose pin or revoke was lost, in any
-- environment, is brought back here.
--
-- Not touched: grants to authenticated and service_role, which each function
-- needs as it is. job_health_status() keeps its anon grant (0113, 0116).
--
-- FORWARD ONLY. Applied migrations are not edited.
begin;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = %L', f.sig, '');
    execute format('revoke all on function %s from public', f.sig);
    if f.proname <> 'job_health_status' then
      execute format('revoke all on function %s from anon', f.sig);
    end if;
  end loop;
end $$;

commit;
