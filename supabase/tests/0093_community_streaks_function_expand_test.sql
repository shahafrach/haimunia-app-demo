-- Supabase Security Advisor, security_definer_view finding on
-- public.community_streaks (202609080005). Mirrors 0068's fixtures and
-- boundary assertions against the new FUNCTION rather than the view, plus
-- two assertions specific to the expand/contract sequencing: the function is
-- genuinely security definer (so it can still aggregate past activity_pings'
-- owner-only RLS), and - since 202609150001 landed the contract phase on
-- 2026-09-15 - that the old view is now gone rather than untouched. Section 2
-- below records why that assertion was inverted instead of removed.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0093-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost93@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.activity_pings (user_id, activity_date) values
  (tests.uid('m2'), current_date),
  (tests.uid('m2'), current_date - 1),
  (tests.uid('m2'), current_date - 2),
  (tests.uid('m1'), current_date);

-- =====================================================================
-- 1. The function is genuinely security definer
-- =====================================================================
-- If this is ever flipped to security invoker (or rewritten as a plain SQL
-- function without the property) it loses the ability to aggregate
-- activity_pings at all and every number below silently becomes the
-- caller's own - the exact regression a naive "just set security_invoker"
-- fix on the old view would have caused.
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'community_streaks'),
  true,
  'community_streaks(int) is SECURITY DEFINER - it aggregates past activity_pings'' owner-only RLS, which is why it re-applies every access rule itself');

-- =====================================================================
-- 2. CONTRACT phase: the old view is gone (this section was inverted)
-- =====================================================================
-- Until 2026-09-15 this section asserted the opposite - "the view still
-- exists - do not drop it in the same migration that adds the function" -
-- which was correct for the expand phase and is the reason the two phases
-- were separated at all: an installed client behind a service-worker cache
-- had to keep resolving its already-shipped .from("community_streaks") call
-- while the new .rpc() call rolled out. 202609150001 completed the contract
-- once cloud.js had no .from() call left and a week of releases had shipped,
-- so the assertion is inverted rather than deleted - a re-created view is a
-- reopened Security Advisor finding, and this is what would catch it.
select is(
  (select count(*)::int from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'community_streaks' and c.relkind = 'v'),
  0,
  'the view public.community_streaks is dropped (202609150001, contract phase) - the function below is now the only way to read a streak');

-- =====================================================================
-- 3. The default club: visible, with the raw date withheld
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select current_streak from public.community_streaks() where user_id = tests.uid('m2')), 3,
  'with the shipped defaults a member still reads another member''s streak length through the function, same as the view');
select is(
  (select last_activity_on from public.community_streaks() where user_id = tests.uid('m2')), null,
  'but NOT the raw last_activity_on date: show_attendance defaults to false');
select is(
  (select last_activity_on from public.community_streaks() where user_id = tests.uid('m1')), current_date,
  'while the caller reads their OWN date unconditionally');

-- =====================================================================
-- 4. show_attendance, opted in
-- =====================================================================
select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is(
  (select last_activity_on from public.community_streaks() where user_id = tests.uid('m2')), current_date,
  'a member who opts into show_attendance publishes the date through the function too');
select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('m2');

-- =====================================================================
-- 5. THE boundary, exactly as 0068 established it for the view: all three off
-- =====================================================================
select tests.clear_auth();
update public.profiles
set visible_to_club = false, in_leaderboards = false, show_attendance = false
where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id, handle, display_name, current_streak, last_activity_on
     from public.community_streaks() where user_id = tests.uid('m2') $$,
  'a member who opted out of all three is unreadable through the function, same boundary the view enforces');
select tests.set_auth(tests.uid('m2'));
select is(
  (select last_activity_on from public.community_streaks() where user_id = tests.uid('m2')), current_date,
  'and even then they still read their own row and their own date');

select tests.set_auth(tests.uid('admin'));
select is_empty(
  $$ select user_id from public.community_streaks() where user_id = tests.uid('m2') $$,
  'not even an admin reads an opted-out member here - the raw columns are checked alongside can_view_profile_field precisely so the admin short-circuit cannot decide this');
select tests.clear_auth();
update public.profiles
set visible_to_club = true, in_leaderboards = true, show_attendance = false
where id = tests.uid('m2');

-- =====================================================================
-- 6. The anonymous read gate reaches this function too
-- =====================================================================
select tests.set_auth('aaaaaaaa-0093-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from public.community_streaks()), 0,
  'a ghost session reads nothing here either, same as the view');

-- =====================================================================
-- 7. Blocks, soft-delete, and the raw rows underneath - unchanged
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks() where user_id = tests.uid('m2') $$,
  'the block check still cuts in both directions through the function');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m2');

update public.profiles set deleted_at = now() where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select user_id from public.community_streaks() where user_id = tests.uid('m3') $$,
  'and so is the soft-delete check');
select tests.clear_auth();
update public.profiles set deleted_at = null where id = tests.uid('m3');

select tests.set_auth(tests.uid('m1'));
select is(
  (select current_streak from public.community_streaks() where user_id = tests.uid('m3')), 0,
  'a member with no pings is still 0 rather than absent, matching the view');

-- =====================================================================
-- 8. p_limit is clamped server-side, matching feed_leaderboard's own ceiling
-- =====================================================================
select is(
  (select count(*)::int from public.community_streaks(1000)) <= 100, true,
  'p_limit cannot be raised past 100 no matter what the caller passes');
select tests.clear_auth();

select * from finish();
rollback;
