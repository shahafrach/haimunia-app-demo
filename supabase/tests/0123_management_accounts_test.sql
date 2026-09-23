-- 202609220006, as narrowed by 202609220007 — a management account is not a
-- clubmate, but a clubmate with authority still is.
--
-- THE LINE THIS FILE DEFENDS. Only the TECHNICAL management login is hidden
-- from members: the account with a real email address that never redeemed an
-- invite and holds no place in the club. Coaches, head coaches and owners
-- train here; they stay in member search and in people-you-may-know.
--
-- 202609220006 drew the line at role rank >= staff (40) and hid the owner,
-- whom public.roles ranks at 60. Two older files caught it — 0036 renames the
-- 'owner' fixture to a searchable handle and asserts a member finds it, 0039
-- expects that account to carry a classmate signal — and both were left
-- untouched, because they were right. 202609220007 moved the predicate to
-- membership instead of rank, and the assertions below are that rule.
--
-- Boundaries pinned here:
--   * is_management_account(): true for an account with NO invite_redemptions
--     row, true for profiles.is_admin with no club role behind it, and FALSE
--     for owner, head coach, coach and plain member — including for an
--     is_admin account that DID redeem a club role, which is the case a
--     flag-only predicate gets wrong.
--   * hide_management_from_member(): is_management_account() AND the caller
--     is not staff. The staff exemption lives here and only here.
--   * management_user_ids(): contains the technical account for a member,
--     never the owner or a coach, and is EMPTY for staff and for a caller
--     with no completed recovery method.
--   * community_search() and people_suggestions() both drop the technical
--     account for a member and both keep the owner, head coach and coach.
--   * Neither new entry point is executable by anon.
--
-- FIXTURES. rls_helpers gives m1/m2/m3 (member), coach (coach), owner
-- (owner) and admin — and note that admin redeemed a role of plain 'member',
-- so under the narrowed rule admin is a CLUBMATE, not management. The two
-- accounts this file needs and the shared fixture has no reason to carry are
-- created locally, inside this file's transaction: the technical office
-- login, and a head coach.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- ---------------------------------------------------------------------------
-- Local fixtures.
--
-- office: the technical management login. A REAL email address rather than
--   the synthetic members.haimuniya.invalid one, is_admin, and deliberately
--   NO invite_redemptions row — it never joined the club. This is the only
--   account this whole feature exists to hide.
-- hc: a head coach, rank 30, with a redeemed club role. Absent from the
--   shared fixture, and the role 202609220006 was most likely to hide by
--   accident once anyone ranked it above staff.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'eeeeeeee-0000-4000-8000-000000000001'::uuid,
   'authenticated', 'authenticated', 'office@haimuniya.example',
   '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
   'authenticated', 'authenticated', 'hc@members.haimuniya.invalid',
   '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, handle, display_name, recovery_verified_at, is_admin)
values
  ('eeeeeeee-0000-4000-8000-000000000001'::uuid, 'office_x',      'Office X',      now(), true),
  ('bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'headcoach_x',   'Head Coach X',  now(), false)
on conflict (id) do nothing;

-- hc redeems a club role. office deliberately redeems nothing.
insert into public.invite_redemptions (user_id, invite_id, role)
values ('bbbbbbbb-0000-4000-8000-000000000001'::uuid,
        '11111111-2222-4333-8444-555555555555', 'head_coach')
on conflict (user_id) do nothing;

-- =====================================================================
-- is_management_account(): who, with no reference to who is asking
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select ok(public.is_management_account('eeeeeeee-0000-4000-8000-000000000001'::uuid),
  'THE TECHNICAL ACCOUNT IS MANAGEMENT - a real email, is_admin, and no invite_redemptions row at all');

select ok(not public.is_management_account(tests.uid('owner')),
  'THE OWNER IS A CLUBMATE - rank 60 sits above staff, and 202609220006 hid them for exactly that reason');
select ok(not public.is_management_account('bbbbbbbb-0000-4000-8000-000000000001'::uuid),
  'a head coach is a clubmate - they redeemed head_coach and they train here');
select ok(not public.is_management_account(tests.uid('coach')),
  'a coach is a clubmate - the directory groups them first on purpose');
select ok(not public.is_management_account(tests.uid('admin')),
  'an is_admin account that redeemed a club role is a clubmate - the flag alone does not decide');
select ok(not public.is_management_account(tests.uid('m2')),
  'and a plain member certainly is not management');

select ok(not public.is_management_account(null::uuid),
  'a null id is not management, rather than an error');
select ok(not public.is_management_account('00000000-0000-4000-8000-0000000000ff'::uuid),
  'an id with no profile row is not management');

-- The answer does not change with who is asking. That is the whole reason
-- this predicate and the rule below it are two functions.
select tests.set_auth(tests.uid('coach'));
select ok(public.is_management_account('eeeeeeee-0000-4000-8000-000000000001'::uuid),
  'the predicate answers the same for a staff caller - the exemption is not in here');

-- =====================================================================
-- hide_management_from_member(): the rule
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select ok(public.hide_management_from_member('eeeeeeee-0000-4000-8000-000000000001'::uuid),
  'a member must not be shown the technical account');
select ok(not public.hide_management_from_member(tests.uid('owner')),
  'the owner IS shown to a member');
select ok(not public.hide_management_from_member('bbbbbbbb-0000-4000-8000-000000000001'::uuid),
  'so is the head coach');
select ok(not public.hide_management_from_member(tests.uid('coach')),
  'so is the coach');
select ok(not public.hide_management_from_member(tests.uid('m2')),
  'and so is every other member');

select tests.set_auth(tests.uid('coach'));
select ok(not public.hide_management_from_member('eeeeeeee-0000-4000-8000-000000000001'::uuid),
  'a staff caller reaches the technical account - is_staff() is the exemption');

-- =====================================================================
-- management_user_ids(): the set, already correct for the caller
-- =====================================================================
-- Membership assertions rather than set_eq on the whole set: what matters is
-- that the technical account is in it and no clubmate ever is, and that does
-- not depend on how many seeded accounts a future migration leaves behind.
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.management_user_ids() m
     where m = 'eeeeeeee-0000-4000-8000-000000000001'::uuid $$,
  'the technical account is in the set a member must not be shown');
select is_empty(
  $$ select 1 from public.management_user_ids() m
     where m in (tests.uid('owner'), tests.uid('coach'), tests.uid('admin'),
                 tests.uid('m2'), 'bbbbbbbb-0000-4000-8000-000000000001'::uuid) $$,
  'and no clubmate is - not the owner, the head coach, the coach, the is_admin member or a plain member');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select public.management_user_ids() $$,
  'EMPTY for a staff caller, by construction - the client never re-derives "am I staff"');

-- norec has no recovery method, so is_community_member() is false for them.
select tests.set_auth(tests.uid('norec'));
select is_empty(
  $$ select public.management_user_ids() $$,
  'and empty for a caller who has not completed recovery setup');

-- =====================================================================
-- community_search(): the members group drops the technical account only
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select jsonb_array_elements(public.community_search('Office X', 50) -> 'members') $$,
  'searching the technical account by display name returns nothing to a member');
select is_empty(
  $$ select jsonb_array_elements(public.community_search('office_x', 50) -> 'members') $$,
  'nor by handle');

select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Owner X', 50) -> 'members') $$,
  'THE OWNER IS FOUND by a member searching - this is what 202609220006 broke');
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Head Coach X', 50) -> 'members') $$,
  'the head coach is found');
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Coach X', 50) -> 'members') $$,
  'the coach is found');
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Member B', 50) -> 'members') $$,
  'and so is an ordinary clubmate, which is what says the WHERE clause is narrow');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Office X', 50) -> 'members') $$,
  'a coach searching for the technical account finds it');

-- =====================================================================
-- people_suggestions(): the same exclusion, on the same rule
-- =====================================================================
-- One live challenge that m1, the office account, the owner, the head coach
-- and m2 are all in. A shared live challenge is the strongest signal this
-- function has, so an account that still does not appear is the exclusion
-- doing the work rather than an absent signal.
select tests.clear_auth();
insert into public.challenges (id, title, challenge_type, metric_type, status, start_at, end_at, created_by)
values ('7a230000-0000-4000-8000-000000000001', 'Open', 'individual_target', 'reps', 'active',
        now() - interval '1 day', now() + interval '7 days', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status) values
  ('7a230000-0000-4000-8000-000000000001', tests.uid('m1'),    'active'),
  ('7a230000-0000-4000-8000-000000000001', tests.uid('m2'),    'active'),
  ('7a230000-0000-4000-8000-000000000001', tests.uid('owner'), 'active'),
  ('7a230000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'active'),
  ('7a230000-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001'::uuid, 'active');

select tests.set_auth(tests.uid('m1'));
-- `as t(item)` is 0034's own shape for this setof-jsonb function.
select is_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid = 'eeeeeeee-0000-4000-8000-000000000001'::uuid $$,
  'the technical account is never suggested to a member, however strong the signal');
select isnt_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid = tests.uid('owner') $$,
  'THE OWNER IS SUGGESTED - a clubmate on the same challenge, which 202609220006 dropped');
select isnt_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid = 'bbbbbbbb-0000-4000-8000-000000000001'::uuid $$,
  'and so is the head coach');
select isnt_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid = tests.uid('m2') $$,
  'and the ordinary clubmate on the same challenge - the function was not simply emptied');

-- =====================================================================
-- anon reaches neither
-- =====================================================================
select ok(
  not has_function_privilege('anon', 'public.is_management_account(uuid)', 'execute'),
  'anon cannot call is_management_account()');
select ok(
  not has_function_privilege('anon', 'public.hide_management_from_member(uuid)', 'execute'),
  'anon cannot call hide_management_from_member()');
select ok(
  not has_function_privilege('anon', 'public.management_user_ids()', 'execute'),
  'anon cannot call management_user_ids()');
select ok(
  has_function_privilege('authenticated', 'public.management_user_ids()', 'execute'),
  'a signed-in member can - the refusal for a non-community-member is the function body, not the grant');

select * from finish();
rollback;
