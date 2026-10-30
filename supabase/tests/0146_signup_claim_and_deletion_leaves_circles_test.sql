-- 202610290003, two repairs from the first end-to-end user tests.
--
-- 1. A member who has just signed up carries a JWT issued while the session was
--    still anonymous: its `is_anonymous` claim stays true until the token is
--    refreshed. create_founder_invite and bug_report_submit used to read the
--    claim and refused that member. They now read auth.users.is_anonymous.
--
-- 2. request_account_deletion() takes the member out of every circle with
--    leave_circle's cleanup, so a Couple's seat and a circle's count free up at
--    once instead of at the purge.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

-- ---------------------------------------------------------------------
-- 1. The claim goes stale; the row does not
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', null, true, now(), now());
insert into public.profiles (id, handle, display_name) values ('a1a1a1a1-0000-4000-8000-0000000000a1', 'anon_a1', 'Anon');

-- m1 has signed up: auth.users says so. Its token still says anonymous.
select set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated","is_anonymous":true}', tests.uid('m1')), true);
select set_config('role', 'authenticated', true);
select lives_ok($$ select public.create_founder_invite() $$, 'a member just signed up (stale anonymous claim) can mint a founder link');
select lives_ok($$ select public.bug_report_submit('אחרי ההרשמה', '{}'::jsonb) $$, 'and can file a פנייה');
select tests.clear_auth();

-- the other way round: the row says anonymous, the claim says otherwise
select set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":false}', true);
select set_config('role', 'authenticated', true);
select throws_ok($$ select public.create_founder_invite() $$, 'P0001', 'not authorized', 'an account that is still anonymous in auth.users cannot mint one, whatever the token says');
select throws_ok($$ select public.bug_report_submit('hi', '{}'::jsonb) $$, 'P0001', 'not authorized', 'and cannot file a פנייה');
select tests.clear_auth();

-- ---------------------------------------------------------------------
-- 2. Deleting the account leaves every circle
-- ---------------------------------------------------------------------
-- X = admin. L: X owns it; owner and coach joined after. K: a couple, X and
-- coach both owners. S: X alone.
insert into public.clubs (id, name, type, created_by) values
  ('d1000000-0000-4000-8000-0000000000d1', 'L', 'friends', tests.uid('admin')),
  ('d2000000-0000-4000-8000-0000000000d2', 'K', 'couple',  tests.uid('admin')),
  ('d3000000-0000-4000-8000-0000000000d3', 'S', 'friends', tests.uid('admin'));
insert into public.circle_members (club_id, user_id, role, joined_at) values
  ('d1000000-0000-4000-8000-0000000000d1', tests.uid('admin'), 'owner',  now() - interval '30 days'),
  ('d1000000-0000-4000-8000-0000000000d1', tests.uid('owner'), 'member', now() - interval '20 days'),
  ('d1000000-0000-4000-8000-0000000000d1', tests.uid('coach'), 'member', now() - interval '10 days'),
  ('d2000000-0000-4000-8000-0000000000d2', tests.uid('admin'), 'owner',  now() - interval '30 days'),
  ('d2000000-0000-4000-8000-0000000000d2', tests.uid('coach'), 'owner',  now() - interval '20 days'),
  ('d3000000-0000-4000-8000-0000000000d3', tests.uid('admin'), 'owner',  now() - interval '30 days');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('d1100000-0000-4000-8000-000000000001', tests.uid('admin'), 'd1000000-0000-4000-8000-0000000000d1', 'POST_WORKOUT', 'X in L', 'active', now()),
  ('d1100000-0000-4000-8000-000000000002', tests.uid('admin'), 'd2000000-0000-4000-8000-0000000000d2', 'POST_WORKOUT', 'X in K', 'active', now()),
  ('d1100000-0000-4000-8000-000000000003', tests.uid('owner'), 'd1000000-0000-4000-8000-0000000000d1', 'POST_WORKOUT', 'owner in L', 'active', now()),
  ('d1100000-0000-4000-8000-000000000004', tests.uid('coach'), 'd2000000-0000-4000-8000-0000000000d2', 'POST_WORKOUT', 'coach in K', 'active', now());
insert into public.reactions (post_id, user_id) values
  ('d1100000-0000-4000-8000-000000000004', tests.uid('admin')),
  ('d1100000-0000-4000-8000-000000000001', tests.uid('owner'));
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by, club_id) values
  ('d1100000-0000-4000-8000-000000000003', tests.uid('admin'), tests.uid('owner'), 'd1000000-0000-4000-8000-0000000000d1');
insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
select 'd1000000-0000-4000-8000-0000000000d1', tests.uid('admin'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '5:00', 'rx';

select tests.set_auth(tests.uid('coach'));
select throws_ok($$ select public.create_circle_invite('d2000000-0000-4000-8000-0000000000d2') $$, 'P0001', 'circle_full',
  'before: the couple is full, so the remaining partner cannot invite');
select tests.clear_auth();

select tests.set_auth(tests.uid('admin'));
select lives_ok($$ select public.request_account_deletion() $$, 'the member asks for their account to be deleted');
select tests.clear_auth();

select is((select count(*)::int from public.circle_members where user_id = tests.uid('admin')), 0, 'they are in no circle');
select is((select count(*)::int from public.workout_posts where author_id = tests.uid('admin') and deleted_at is null), 0, 'their posts are gone');
select is((select count(*)::int from public.reactions where user_id = tests.uid('admin')), 0, 'their reactions are gone');
select is((select count(*)::int from public.reactions where post_id = 'd1100000-0000-4000-8000-000000000001'), 0, 'and the reactions others left on their posts');
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('admin')), 0, 'the tags naming them are gone');
select is((select count(*)::int from public.benchmark_results where user_id = tests.uid('admin')), 0, 'and their benchmark results');
select is((select role from public.circle_members where club_id = 'd1000000-0000-4000-8000-0000000000d1' and user_id = tests.uid('owner')), 'owner',
  'ownership of L passed to the longest-standing member');
select is((select count(*)::int from public.circle_members where club_id = 'd1000000-0000-4000-8000-0000000000d1'), 2, 'L has two members left');
select is((select count(*)::int from public.circle_members where club_id = 'd2000000-0000-4000-8000-0000000000d2'), 1, 'the couple has one member left');
select is((select count(*)::int from public.clubs where id = 'd3000000-0000-4000-8000-0000000000d3'), 0, 'the circle they were alone in is deleted');
select is((select count(*)::int from public.workout_posts where id = 'd1100000-0000-4000-8000-000000000004' and deleted_at is null), 1, 'other members'' posts stay');
select is((select count(*)::int from public.account_deletion_requests where user_id = tests.uid('admin')), 1, 'the deletion request is recorded');
select is((select deleted_at is not null from public.profiles where id = tests.uid('admin')), true, 'and the profile is marked deleted');

select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.create_circle_invite('d2000000-0000-4000-8000-0000000000d2') $$, 'after: the couple''s seat is free, so the remaining partner can invite again');
select tests.clear_auth();

select * from finish();
rollback;
