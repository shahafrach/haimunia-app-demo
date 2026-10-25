-- COMM-020: real two-user RLS enforcement for 202608280003 (profile privacy
-- and recovery).
-- Boundaries: a self write cannot move recovery_verified_at, and cannot stamp
-- it on insert. Profiles are visible only to people who share a circle
-- (202610250003); can_view_profile_field is "same circle, no block".
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- a redeemed account that has not created its profile yet, and whose auth
-- row has no password and no confirmed email.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000',
        'aaaaaaaa-0000-4000-8000-0000000000f0',
        'authenticated', 'authenticated', 'fresh@members.haimuniya.invalid', now(), now());
insert into public.invite_redemptions (user_id, invite_id, role)
values ('aaaaaaaa-0000-4000-8000-0000000000f0', '11111111-2222-4333-8444-555555555555', 'member');

-- --- the protected columns cannot move on a self update -------------
select tests.set_auth(tests.uid('norec'));
select lives_ok(
  $$ update public.profiles set recovery_verified_at = now() where id = tests.uid('norec') $$,
  'a self update naming recovery_verified_at is accepted');
select is(
  (select recovery_verified_at from public.profiles where id = tests.uid('norec')),
  null,
  'the protect trigger kept recovery_verified_at null on a self update');

-- --- a first profile insert cannot arrive already stamped ----------
select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000f0');
select throws_ok(
  $$ insert into public.profiles (id, handle, display_name, recovery_verified_at)
     values ('aaaaaaaa-0000-4000-8000-0000000000f0', 'freshie', 'Fresh', now()) $$,
  '42501',
  null,
  'the insert policy rejects a profile row that carries recovery_verified_at');
select lives_ok(
  $$ insert into public.profiles (id, handle, display_name)
     values ('aaaaaaaa-0000-4000-8000-0000000000f0', 'freshie', 'Fresh') $$,
  'the same insert with a null recovery_verified_at is allowed');

-- --- mark_recovery_verified cannot be self-certified --------------
select throws_ok(
  $$ select public.mark_recovery_verified() $$,
  'P0001',
  'recovery method not verified',
  'mark_recovery_verified refuses an account with no password or confirmed email');

select tests.set_auth(tests.uid('norec'));
select lives_ok(
  $$ select public.mark_recovery_verified() $$,
  'mark_recovery_verified succeeds once auth.users shows a real method');
select isnt(
  (select recovery_verified_at from public.profiles where id = tests.uid('norec')),
  null,
  'mark_recovery_verified stamped the column past the protect trigger');

-- --- profiles are scoped by circle (202610250003) -----------------
-- The fixture circle holds m1, m2, m3. A stranger shares no circle with them.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000f1',
        'authenticated', 'authenticated', 'stranger@members.haimuniya.invalid', now(), now());
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('aaaaaaaa-0000-4000-8000-0000000000f1', 'stranger', 'Stranger', now());

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select count(*)::int from public.profiles where id = tests.uid('m2') $$,
  $$ values (1) $$,
  'a member sees the profile of someone in their circle');
select is_empty(
  $$ select 1 from public.profiles where id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'a member does not see the profile of someone who shares no circle');

select tests.set_auth('aaaaaaaa-0000-4000-8000-0000000000f1');
select is_empty(
  $$ select 1 from public.profiles where id <> 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'a person in no circle sees only their own profile');
select results_eq(
  $$ select count(*)::int from public.profiles where id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  $$ values (1) $$,
  'and does see their own');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.profiles set emoji = E'\U0001F4AA' where id = tests.uid('m1') $$,
  'a member sets their emoji');

-- --- can_view_profile_field is "same circle, no block" ----------------
select is( public.can_view_profile_field(tests.uid('m2'), 'anything'), true,
  'true for someone in my circle' );
select is( public.can_view_profile_field(tests.uid('m1'), 'anything'), true,
  'true for myself' );
select is( public.can_view_profile_field('aaaaaaaa-0000-4000-8000-0000000000f1', 'anything'), false,
  'false for someone who shares no circle' );

select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m2'));
select is( public.can_view_profile_field(tests.uid('m1'), 'anything'), false,
  'a block edge returns false even inside a shared circle' );
select is_empty(
  $$ select 1 from public.profiles where id = tests.uid('m1') $$,
  'and hides the blocker''s profile row');

-- --- the profile is display name and emoji only -----------------------
select is_empty(
  $$ select column_name::text from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name in ('bio', 'is_admin', 'visible_to_club', 'show_prs', 'show_achievements',
                            'in_leaderboards', 'allow_follows', 'allow_mentions', 'allow_messages',
                            'show_in_attendee_lists', 'show_workout_results', 'show_attendance',
                            'show_upcoming_booking', 'assigned_coach_id', 'club_id') $$,
  'the privacy toggles and staff columns are gone from profiles');

select * from finish();
rollback;
