-- 202609180001. admin_member_roster returns the value it sorts on.
--
-- The function orders and pages on coalesce(invite_redemptions.redeemed_at,
-- profiles.created_at) and, until this migration, returned only
-- redeemed_at. A member with no invite_redemptions row therefore carried a
-- sort key no caller could see, and the page after such a row had no
-- constructible cursor: sending that row's redeemed_at means sending null,
-- which the function reads as "no lower bound" and answers with the top of
-- the list again.
--
-- So the two assertions that matter here are a pair, and both are made
-- against a real Postgres rather than argued:
--   1. the OLD cursor (redeemed_at) really does restart the list - the bug
--      is measured, not assumed, so this file still means something if
--      someone ever reverts the column;
--   2. the NEW cursor (sort_key) walks the whole roster, in order, with no
--      repeat and no early stop.
--
-- The walk is a real loop rather than three hand-written pages, because the
-- failure being guarded against is precisely a loop that never advances.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- Fixtures: two profiles with NO invite_redemptions row, placed in the
-- MIDDLE of the ordering rather than at either end
-- =====================================================================
-- At the end they would prove nothing: a list that stops at its last row
-- has stopped correctly. The whole defect is a stop in the middle, so one
-- of these is the last row of page 1 by construction.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000f1',
   'authenticated', 'authenticated', 'ghosta@members.haimuniya.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000f2',
   'authenticated', 'authenticated', 'ghostb@members.haimuniya.invalid', now(), now());

insert into public.profiles (id, handle, display_name, recovery_verified_at, created_at)
values
  ('00000000-0000-4000-8000-0000000000f1', 'no_redemption_a', 'No Redemption A', now(), now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000f2', 'no_redemption_b', 'No Redemption B', now(), now() - interval '6 days');

-- The seven fixture profiles were all created inside this transaction and
-- share a byte-identical created_at, so their join dates are spread first -
-- the same reason 0060 spreads them.
update public.invite_redemptions set redeemed_at = case user_id
  when tests.uid('coach') then now() - interval '1 day'
  when tests.uid('admin') then now() - interval '2 days'
  when tests.uid('owner') then now() - interval '4 days'
  when tests.uid('m1')    then now() - interval '5 days'
  when tests.uid('m2')    then now() - interval '7 days'
  when tests.uid('m3')    then now() - interval '8 days'
  else now() - interval '9 days' end;

-- The intended total order, newest first:
--   coach_x, admin_x, no_redemption_a, owner_x, member_a,
--   no_redemption_b, member_b, member_c, member_norec
-- Nine rows, and the two rows with no redemption sit at positions 3 and 6.

-- =====================================================================
-- sort_key exists, and it is the coalesced value, not a second redeemed_at
-- =====================================================================
select tests.set_auth(tests.uid('coach'));

select results_eq(
  $$ select bool_and(sort_key is not null) from public.admin_member_roster(null, 100) $$,
  $$ values (true) $$,
  'every roster row carries a non-null sort_key - that is the whole point: the sort key always existed, it was the RETURN that had a hole in it');

select results_eq(
  $$ select redeemed_at is null, sort_key is not null
     from public.admin_member_roster(null, 100) where handle = 'no_redemption_a' $$,
  $$ values (true, true) $$,
  'a member with no invite_redemptions row still reports redeemed_at null - the truth about them, and what the row renders as an em-dash - while sort_key carries the profiles.created_at the function actually ordered on');

select results_eq(
  $$ select sort_key = redeemed_at from public.admin_member_roster(null, 100) where handle = 'coach_x' $$,
  $$ values (true) $$,
  'and for a member who DID redeem an invite, sort_key is exactly their redeemed_at - one expression, not two');

select results_eq(
  $$ select count(*)::int from public.admin_member_roster(null, 100) r
     join public.profiles p on p.id = r.id
     where r.redeemed_at is null and r.sort_key <> p.created_at $$,
  $$ values (0) $$,
  'the fallback half is profiles.created_at itself, checked row by row rather than on the one fixture');

select results_eq(
  $$ select bool_and(a >= b) from (
       select sort_key as a, lead(sort_key) over () as b
       from public.admin_member_roster(null, 100)) w
     where b is not null $$,
  $$ values (true) $$,
  'and the rows really do come back in sort_key order, so sort_key is the ORDER BY key and not a decorative extra column');

-- =====================================================================
-- THE BUG, measured: the old cursor restarts the list
-- =====================================================================
-- Page 1 of 3 ends on no_redemption_a, whose redeemed_at is null. Passing
-- that as p_cursor hits the function's own `p_cursor is null` branch, which
-- means "no lower bound at all".
select results_eq(
  $$ select handle from public.admin_member_roster(null, 3) offset 2 limit 1 $$,
  $$ values ('no_redemption_a'::text) $$,
  'page 1 of 3 ends on the member with no redemption - the boundary this whole file is about');

select results_eq(
  $$ select handle from public.admin_member_roster(
       (select redeemed_at from public.admin_member_roster(null, 3) offset 2 limit 1),
       3,
       (select id from public.admin_member_roster(null, 3) offset 2 limit 1)) limit 1 $$,
  $$ values ('coach_x'::text) $$,
  'paging on that row''s REDEEMED_AT returns the top of the list again (coach_x, page 1 row 1) - a null cursor is "no bound", so the old cursor loops the same page forever rather than advancing. This is the defect, asserted rather than described');

-- =====================================================================
-- THE FIX: the new cursor advances
-- =====================================================================
select results_eq(
  $$ select handle from public.admin_member_roster(
       (select sort_key from public.admin_member_roster(null, 3) offset 2 limit 1),
       3,
       (select id from public.admin_member_roster(null, 3) offset 2 limit 1)) $$,
  $$ values ('owner_x'::text), ('member_a'::text), ('no_redemption_b'::text) $$,
  'paging on that same row''s SORT_KEY returns the next three members in order, the boundary row itself excluded - which is what the client could not do before this migration');

-- =====================================================================
-- The whole walk, page by page, as the client performs it
-- =====================================================================
create temporary table roster_walk(seq integer, handle text, sort_key timestamptz, row_id uuid);

do $$
declare
  v_cursor    timestamptz := null;
  v_cursor_id uuid := null;
  v_seq       integer := 0;
  v_rows      integer;
  r           record;
begin
  loop
    v_rows := 0;
    for r in select * from public.admin_member_roster(v_cursor, 3, v_cursor_id) loop
      v_seq  := v_seq + 1;
      v_rows := v_rows + 1;
      insert into roster_walk values (v_seq, r.handle, r.sort_key, r.id);
      v_cursor    := r.sort_key;
      v_cursor_id := r.id;
    end loop;
    -- A short page is the end of the list, the same rule loadRoster() uses.
    exit when v_rows < 3;
    -- The failure this file guards against is a walk that never advances,
    -- and a pgTAP run that hangs reports nothing at all. 60 is comfortably
    -- more than the nine rows that exist and comfortably less than forever.
    exit when v_seq > 60;
  end loop;
end $$;

select results_eq(
  $$ select count(*)::int, count(distinct handle)::int from roster_walk $$,
  $$ values (9, 9) $$,
  'walking the roster three at a time reaches all nine members exactly once - no repeat, no loop, and no stop at the no-redemption row in position 3');

select results_eq(
  $$ select handle from roster_walk order by seq $$,
  $$ values ('coach_x'::text), ('admin_x'::text), ('no_redemption_a'::text),
            ('owner_x'::text), ('member_a'::text), ('no_redemption_b'::text),
            ('member_b'::text), ('member_c'::text), ('member_norec'::text) $$,
  'and in the exact newest-joined-first order, across every page boundary - including the two that land on a member with no invite_redemptions row');

-- =====================================================================
-- Shape: still one function, still the same gate
-- =====================================================================
select tests.clear_auth();
select is(
  (select count(*)::int from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_member_roster'),
  1,
  'the drop-and-recreate left exactly ONE admin_member_roster - adding an OUT column needs a drop, and a drop is where an accidental second overload comes from');

select results_eq(
  $$ select prosecdef, provolatile = 's' from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_member_roster' $$,
  $$ values (true, true) $$,
  'still security definer and still stable');

select results_eq(
  $$ select has_function_privilege('authenticated', 'public.admin_member_roster(timestamptz, integer, uuid)', 'execute'),
            has_function_privilege('anon', 'public.admin_member_roster(timestamptz, integer, uuid)', 'execute') $$,
  $$ values (true, false) $$,
  'still granted to authenticated and still revoked from anon - a drop takes the grants with it, so the recreate has to put them back');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select * from public.admin_member_roster(null, 25) $$,
  'P0001', 'not authorized',
  'and a plain member is still refused - the new column changed the return, not the gate');

select * from finish();
rollback;
