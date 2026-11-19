-- Q-50 (Grok backend PRR, 2026-11-19): no RLS policy calls auth.uid() bare.
--
-- F-005 (202611150004) wrapped every bare auth.uid() in a policy as (select auth.uid()), so Postgres
-- runs it once per statement as an InitPlan instead of once per row (splinter 0003_auth_rls_initplan).
-- That migration fixed the policies of its day; nothing stopped the next one from adding a bare call.
-- This reads the live catalog, so a policy added or altered by any later migration fails here.
--
-- In pg_policies the wrapped form reads `( SELECT auth.uid() AS uid)`. Strip exactly that; any
-- auth.uid() left is a bare call. Every schema, every command, both USING and WITH CHECK.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions;
select * from no_plan();

select ok((select count(*) from pg_policies
            where coalesce(qual, '') || coalesce(with_check, '') like '%( SELECT auth.uid() AS uid)%') > 0,
  'the guard sees wrapped auth.uid() calls (the stripped form matches this Postgres)');

select is_empty(
  $$ select schemaname || '.' || tablename || ' / ' || policyname
       from pg_policies
      where replace(coalesce(qual, ''), '( SELECT auth.uid() AS uid)', '') ~ 'auth\.uid\(\)'
         or replace(coalesce(with_check, ''), '( SELECT auth.uid() AS uid)', '') ~ 'auth\.uid\(\)' $$,
  'no policy calls auth.uid() outside a (select ...) subquery');

select * from finish();
rollback;
