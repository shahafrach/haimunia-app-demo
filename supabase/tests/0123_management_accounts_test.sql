-- 202609220006 — a management account is not a clubmate, enforced in Postgres.
--
-- Boundaries this file pins:
--   * is_management_account(): true at rank staff (40) and above, true for
--     the legacy profiles.is_admin flag, and FALSE for coach and head coach,
--     which is the one line of this rule most likely to be "tidied" later
--     into is_staff() and would then empty the directory's staff group.
--   * hide_management_from_member(): is_management_account() AND the caller
--     is not staff. The staff exemption lives here and only here, so the
--     client cannot disagree with the server about it.
--   * management_user_ids(): the ids THIS caller must not be shown. The
--     office for a member, EMPTY for a coach, EMPTY for a caller with no
--     completed recovery method.
--   * community_search() and people_suggestions() both drop management rows
--     for a member and both keep them for staff — the halves that stop a
--     management row reaching a member's browser at all.
--   * Neither new entry point is executable by anon.
--
-- FIXTURES, from rls_helpers.sql: 'admin' is management by profiles.is_admin
-- (its redeemed role is plain 'member', which is exactly the case a rank-only
-- predicate would miss), 'owner' is management by rank 60, 'coach' is rank 20
-- and is deliberately NOT management, and m1/m2/m3 are plain members.
--
-- CI is the first real run of this file: `supabase test db` needs Docker and
-- the branch that added it had none.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- =====================================================================
-- is_management_account(): who, with no reference to who is asking
-- =====================================================================
select tests.set_auth(tests.uid('m1'));

select ok(public.is_management_account(tests.uid('admin')),
  'the legacy profiles.is_admin flag is management, even with a redeemed role of plain member');
select ok(public.is_management_account(tests.uid('owner')),
  'owner (rank 60) is management');
select ok(not public.is_management_account(tests.uid('coach')),
  'COACH IS NOT MANAGEMENT - a coach is somebody a member trains with, and the directory groups them first on purpose');
select ok(not public.is_management_account(tests.uid('m2')),
  'and a plain member certainly is not');
select ok(not public.is_management_account(null::uuid),
  'a null id is not management, rather than an error');
select ok(not public.is_management_account('00000000-0000-4000-8000-0000000000ff'::uuid),
  'an id with no profile row is not management');

-- The answer does not change with who is asking. That is the whole reason
-- this predicate and the rule below it are two functions.
select tests.set_auth(tests.uid('coach'));
select ok(public.is_management_account(tests.uid('admin')),
  'the predicate answers the same for a staff caller - the exemption is not in here');

-- =====================================================================
-- hide_management_from_member(): the rule
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select ok(public.hide_management_from_member(tests.uid('admin')),
  'a member must not be shown the admin account');
select ok(public.hide_management_from_member(tests.uid('owner')),
  'nor the owner account');
select ok(not public.hide_management_from_member(tests.uid('coach')),
  'the coach is shown, because the coach is not management');
select ok(not public.hide_management_from_member(tests.uid('m2')),
  'and so is every other member');

select tests.set_auth(tests.uid('coach'));
select ok(not public.hide_management_from_member(tests.uid('admin')),
  'a coach looking for a colleague finds them - is_staff() is the exemption');
select tests.set_auth(tests.uid('admin'));
select ok(not public.hide_management_from_member(tests.uid('owner')),
  'and so does an admin');

-- =====================================================================
-- management_user_ids(): the set, already correct for the caller
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select set_eq(
  $$ select public.management_user_ids() $$,
  $$ select unnest(array[tests.uid('admin'), tests.uid('owner')]) $$,
  'a member is handed exactly the two management accounts and nothing else - not the coach, not another member');

select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select public.management_user_ids() $$,
  'EMPTY for a staff caller, by construction - the client never re-derives "am I staff"');

-- norec has no recovery method, so is_community_member() is false for them:
-- the same refusal every other definer read in 202609060009 gives.
select tests.set_auth(tests.uid('norec'));
select is_empty(
  $$ select public.management_user_ids() $$,
  'and empty for a caller who has not completed recovery setup');

-- =====================================================================
-- community_search(): the members group drops management for a member
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select jsonb_array_elements(public.community_search('Admin X', 50) -> 'members') $$,
  'searching a management account by display name returns nothing to a member');
select is_empty(
  $$ select jsonb_array_elements(public.community_search('owner_x', 50) -> 'members') $$,
  'nor by handle');
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Coach X', 50) -> 'members') $$,
  'the coach is still findable - the cut is at staff, not at member');
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Member B', 50) -> 'members') $$,
  'and so is an ordinary clubmate, which is what says the WHERE clause is narrow');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select jsonb_array_elements(public.community_search('Admin X', 50) -> 'members') $$,
  'a coach searching for the admin account finds it');

-- =====================================================================
-- people_suggestions(): the same exclusion, on the same rule
-- =====================================================================
-- One live challenge that m1, the admin and m2 are all in. A shared live
-- challenge is the strongest signal this function has, so an admin that
-- still does not appear is the exclusion doing the work rather than an
-- absent signal - and m2 appearing beside it is what proves the function
-- still works at all.
-- Back to the bootstrap superuser to build these rows: the assertions above
-- left request.jwt.claims pointing at a member, and a fixture insert is not
-- what this file is testing.
select tests.clear_auth();
insert into public.challenges (id, title, challenge_type, metric_type, status, start_at, end_at, created_by)
values ('7a230000-0000-4000-8000-000000000001', 'Open', 'individual_target', 'reps', 'active',
        now() - interval '1 day', now() + interval '7 days', tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id, status) values
  ('7a230000-0000-4000-8000-000000000001', tests.uid('m1'),    'active'),
  ('7a230000-0000-4000-8000-000000000001', tests.uid('m2'),    'active'),
  ('7a230000-0000-4000-8000-000000000001', tests.uid('admin'), 'active'),
  ('7a230000-0000-4000-8000-000000000001', tests.uid('owner'), 'active');

select tests.set_auth(tests.uid('m1'));
-- `as t(item)` is 0034's own shape for this setof-jsonb function, kept so
-- the two files read the same.
select is_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid in (tests.uid('admin'), tests.uid('owner')) $$,
  'no management account is suggested to a member, however strong the signal');
select isnt_empty(
  $$ select 1 from public.people_suggestions(20) as t(item)
     where (item ->> 'user_id')::uuid = tests.uid('m2') $$,
  'the ordinary clubmate on the same challenge still is - the function was not simply emptied');

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
