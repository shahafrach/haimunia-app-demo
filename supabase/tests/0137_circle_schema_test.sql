-- Circles schema (202610250003): the model, the limits, the helpers, and a
-- removed member losing access. The cross-circle leak tests are in 0138.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- This file looks at the real columns, so drop the fixture's in-transaction defaults.
alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

-- ---------------------------------------------------------------------
-- Fixtures: 25 extra people, no circle membership yet.
-- ---------------------------------------------------------------------
-- pu('p7'): the extra people of this file (rls_helpers' uid() knows only its own).
create function tests.pu(p_nick text) returns uuid
language sql immutable as $fn$
  select ('bbbbbbbb-0000-4000-8000-' || lpad(substr(p_nick, 2), 12, '0'))::uuid
$fn$;
grant execute on function tests.pu(text) to anon, authenticated, service_role;

select tests.clear_auth();
delete from public.circle_members;   -- the shared fixture circle is not under test here
delete from public.clubs;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', tests.pu('p' || i), 'authenticated', 'authenticated',
       'p' || i || '@members.haimuniya.invalid', now(), now()
  from generate_series(1, 25) i;
insert into public.profiles (id, handle, display_name, recovery_verified_at)
select tests.pu('p' || i), 'person_' || i, 'Person ' || i, now() from generate_series(1, 25) i;
insert into public.invite_redemptions (user_id, invite_id, role)
select tests.pu('p' || i), '11111111-2222-4333-8444-555555555555', 'member' from generate_series(1, 25) i;

-- ---------------------------------------------------------------------
-- 1. Shape
-- ---------------------------------------------------------------------
select is_empty($$ select 1 from public.clubs $$, 'no seeded default club remains');
select hasnt_function('public', 'default_club_id', 'default_club_id() is gone');
select hasnt_function('public', 'clubs_guard_single_row', 'clubs_guard_single_row() is gone');
select is_empty(
  $$ select table_name::text from information_schema.columns
      where table_schema = 'public' and column_name = 'club_id'
        and (is_nullable = 'YES' or column_default is not null) $$,
  'every club_id column is NOT NULL with no default');
select set_eq(
  $$ select table_name::text from information_schema.columns
      where table_schema = 'public' and column_name = 'club_id' and table_name not in ('circle_members', 'circle_invites') $$,
  $$ values ('invites'), ('post_training_partners'), ('workout_posts') $$,
  'club_id remains only on rows that belong to one circle (plus the new circle tables)');
select is_empty(
  $$ select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename in ('notifications', 'reactions') $$,
  'notifications and reactions are out of the realtime publication')
where exists (select 1 from pg_publication where pubname = 'supabase_realtime');

-- ---------------------------------------------------------------------
-- 2. Limits
-- ---------------------------------------------------------------------
insert into public.clubs (id, name, type, created_by) values
  ('c0000000-0000-4000-8000-000000000001', 'The couple',  'couple',  tests.pu('p1')),
  ('c0000000-0000-4000-8000-000000000002', 'The friends', 'friends', tests.pu('p1'));

select throws_ok(
  $$ insert into public.clubs (name, type) values ('Bad', 'family') $$,
  '23514', null, 'a circle type is couple or friends');

-- couple: 2, both owners
insert into public.circle_members (club_id, user_id, role) values
  ('c0000000-0000-4000-8000-000000000001', tests.pu('p1'), 'owner'),
  ('c0000000-0000-4000-8000-000000000001', tests.pu('p2'), 'member');
select results_eq(
  $$ select role from public.circle_members where club_id = 'c0000000-0000-4000-8000-000000000001' order by user_id::text $$,
  $$ values ('owner'::text), ('owner'::text) $$,
  'both members of a couple are owners, even when the second is inserted as a member');
select throws_ok(
  $$ insert into public.circle_members (club_id, user_id) values ('c0000000-0000-4000-8000-000000000001', tests.pu('p3')) $$,
  'P0001', 'circle_full', 'a third member joining a couple fails');
select throws_ok(
  $$ update public.circle_members set role = 'member' where club_id = 'c0000000-0000-4000-8000-000000000001' and user_id = tests.pu('p2') $$,
  'P0001', 'both members of a couple are owners', 'a couple member cannot be demoted');

-- friends: 20
insert into public.circle_members (club_id, user_id, role)
select 'c0000000-0000-4000-8000-000000000002', tests.pu('p' || i), case when i = 1 then 'owner' else 'member' end
  from generate_series(1, 20) i;
select results_eq(
  $$ select count(*)::int from public.circle_members where club_id = 'c0000000-0000-4000-8000-000000000002' $$,
  $$ values (20) $$, 'a friends circle holds 20');
select throws_ok(
  $$ insert into public.circle_members (club_id, user_id) values ('c0000000-0000-4000-8000-000000000002', tests.pu('p21')) $$,
  'P0001', 'circle_full', 'the 21st friend fails');
select lives_ok(
  $$ delete from public.circle_members where club_id = 'c0000000-0000-4000-8000-000000000002' and user_id = tests.pu('p20') $$,
  'a member leaves');
select lives_ok(
  $$ insert into public.circle_members (club_id, user_id) values ('c0000000-0000-4000-8000-000000000002', tests.pu('p21')) $$,
  'and the freed place can be taken');

-- 10 circles per person
insert into public.clubs (id, name, type, created_by)
select ('c1000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'Circle ' || i, 'friends', tests.pu('p25')
  from generate_series(1, 11) i;
insert into public.circle_members (club_id, user_id)
select ('c1000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, tests.pu('p25')
  from generate_series(1, 10) i;
select throws_ok(
  $$ insert into public.circle_members (club_id, user_id) values ('c1000000-0000-4000-8000-000000000011', tests.pu('p25')) $$,
  'P0001', 'too_many_circles', 'the 11th circle for one person fails');

-- ---------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------
select tests.set_auth(tests.pu('p3'));
select is(public.is_circle_member('c0000000-0000-4000-8000-000000000002'), true, 'p3 is a member of the friends circle');
select is(public.is_circle_owner('c0000000-0000-4000-8000-000000000002'), false, 'but not an owner');
select is(public.is_circle_member('c0000000-0000-4000-8000-000000000001'), false, 'and not a member of the couple');
select results_eq($$ select * from public.my_circles() $$, $$ values ('c0000000-0000-4000-8000-000000000002'::uuid) $$,
  'my_circles() lists exactly my circles');
select tests.set_auth(tests.pu('p1'));
select is(public.is_circle_owner('c0000000-0000-4000-8000-000000000002'), true, 'p1 owns the friends circle');
select tests.clear_auth();
select is(public.is_circle_member('c0000000-0000-4000-8000-000000000002'), false, 'with no session nobody is a member');
select ok(
  not has_function_privilege('anon', 'public.is_circle_member(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.is_circle_owner(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.my_circles()', 'execute'),
  'anon cannot execute the circle helpers');

-- ---------------------------------------------------------------------
-- 4. Circle settings: owner only; type and creator fixed; no client create
-- ---------------------------------------------------------------------
select tests.set_auth(tests.pu('p1'));
select lives_ok(
  $$ update public.clubs set name = 'Renamed', mode = 'weekly_competition', welcome_line = 'hi' where id = 'c0000000-0000-4000-8000-000000000002' $$,
  'an owner edits the settings');
select results_eq($$ select name from public.clubs where id = 'c0000000-0000-4000-8000-000000000002' $$,
  $$ values ('Renamed'::text) $$, 'and it took');
select throws_ok(
  $$ update public.clubs set type = 'couple' where id = 'c0000000-0000-4000-8000-000000000002' $$,
  'P0001', null, 'the type cannot change after creation');
select throws_ok(
  $$ insert into public.clubs (name, type) values ('Mine', 'friends') $$,
  '42501', null, 'a client cannot create a circle directly (create_circle is an RPC)');
select tests.set_auth(tests.pu('p3'));
select results_eq(
  $$ with u as (update public.clubs set name = 'Hijack' where id = 'c0000000-0000-4000-8000-000000000002' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'a plain member''s settings update changes nothing');

-- ---------------------------------------------------------------------
-- 5. Invites hold a hash and no client can touch the table
-- ---------------------------------------------------------------------
select tests.clear_auth();
select throws_ok(
  $$ insert into public.circle_invites (club_id, token_hash, expires_at)
     values ('c0000000-0000-4000-8000-000000000002', 'not-a-hash', now() + interval '7 days') $$,
  '23514', null, 'only a sha-256 hex digest can be stored');
select lives_ok(
  $$ insert into public.circle_invites (club_id, token_hash, created_by, expires_at, max_uses)
     values ('c0000000-0000-4000-8000-000000000002', repeat('ab', 32), tests.pu('p1'), now() + interval '7 days', 5) $$,
  'a hashed invite is stored');
select tests.set_auth(tests.pu('p1'));
select throws_ok($$ select * from public.circle_invites $$, '42501', null, 'even the circle''s owner cannot select circle_invites');
select throws_ok($$ insert into public.circle_invites (club_id, token_hash, expires_at)
  values ('c0000000-0000-4000-8000-000000000002', repeat('cd', 32), now() + interval '1 day') $$,
  '42501', null, 'or insert into it');

-- ---------------------------------------------------------------------
-- 6. member_targets are private to their owner
-- ---------------------------------------------------------------------
select lives_ok($$ insert into public.member_targets (user_id, weekly_target) values (tests.pu('p1'), 3) $$, 'I set my target');
select throws_ok($$ insert into public.member_targets (user_id, weekly_target) values (tests.pu('p2'), 3) $$,
  '42501', null, 'but not someone else''s');
select throws_ok($$ update public.member_targets set weekly_target = 0 where user_id = tests.pu('p1') $$,
  '23514', null, 'a target is between 1 and 21');
select tests.set_auth(tests.pu('p2'));
select is_empty($$ select 1 from public.member_targets $$, 'a circle-mate does not read my target');

-- ---------------------------------------------------------------------
-- 7. A removed member loses access immediately
-- ---------------------------------------------------------------------
select tests.clear_auth();
insert into public.clubs (id, name, type, created_by) values ('c2000000-0000-4000-8000-000000000001', 'Pair+', 'friends', tests.pu('p22'));
insert into public.circle_members (club_id, user_id, role) values
  ('c2000000-0000-4000-8000-000000000001', tests.pu('p22'), 'owner'),
  ('c2000000-0000-4000-8000-000000000001', tests.pu('p23'), 'member');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at)
values ('d0000000-0000-4000-8000-000000000001', tests.pu('p22'), 'c2000000-0000-4000-8000-000000000001', 'POST_TEXT', 't', 'active', now());

select tests.set_auth(tests.pu('p23'));
select results_eq($$ select count(*)::int from public.workout_posts where id = 'd0000000-0000-4000-8000-000000000001' $$, $$ values (1) $$, 'before removal: p2 reads the circle''s post');
select results_eq($$ select count(*)::int from public.profiles where id = tests.pu('p22') $$, $$ values (1) $$, 'and the owner''s profile');
select lives_ok($$ select public.toggle_reaction('d0000000-0000-4000-8000-000000000001', null) $$, 'and reacts');
select lives_ok($$ select public.toggle_reaction('d0000000-0000-4000-8000-000000000001', null) $$, 'and takes it back, so the check after removal meets a fresh reaction');

select tests.clear_auth();
delete from public.circle_members where club_id = 'c2000000-0000-4000-8000-000000000001' and user_id = tests.pu('p23');

select tests.set_auth(tests.pu('p23'));
select is_empty($$ select 1 from public.workout_posts where id = 'd0000000-0000-4000-8000-000000000001' $$, 'after removal: the post is gone from view in the same session');
select is_empty($$ select 1 from public.clubs where id = 'c2000000-0000-4000-8000-000000000001' $$, 'the circle row is gone from view');
select is_empty($$ select 1 from public.circle_members where club_id = 'c2000000-0000-4000-8000-000000000001' $$, 'the roster is gone from view');
select is_empty($$ select 1 from public.profiles where id = tests.pu('p22') $$, 'the former circle-mate''s profile is gone from view');
select is_empty($$ select 1 from public.reactions where post_id = 'd0000000-0000-4000-8000-000000000001' $$, 'reactions on the post are gone from view');
select throws_ok(
  $$ insert into public.workout_posts (author_id, club_id, post_type, title, status, published_at)
     values (tests.pu('p23'), 'c2000000-0000-4000-8000-000000000001', 'POST_TEXT', 'x', 'active', now()) $$,
  '42501', null, 'and a post cannot be written into the circle any more');
select throws_ok(
  $$ select public.toggle_reaction('d0000000-0000-4000-8000-000000000001', null) $$,
  'P0001', null, 'nor a reaction (toggle_reaction refuses a post the caller cannot see)');

-- ---------------------------------------------------------------------
-- 8. A tag takes its circle from its post
-- ---------------------------------------------------------------------
select tests.clear_auth();
insert into public.circle_members (club_id, user_id) values ('c2000000-0000-4000-8000-000000000001', tests.pu('p24'));
select lives_ok(
  $$ insert into public.post_training_partners (post_id, tagged_user_id, tagged_by, club_id)
     values ('d0000000-0000-4000-8000-000000000001', tests.pu('p24'), tests.pu('p22'), 'c0000000-0000-4000-8000-000000000001') $$,
  'a tag is accepted');
select results_eq(
  $$ select club_id from public.post_training_partners where post_id = 'd0000000-0000-4000-8000-000000000001' $$,
  $$ values ('c2000000-0000-4000-8000-000000000001'::uuid) $$,
  'and its circle is its post''s, whatever the writer asked for');
select throws_ok(
  $$ insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
     values ('d0000000-0000-4000-8000-000000000001', tests.pu('p9'), tests.pu('p22')) $$,
  'P0001', 'the tagged member is not in this circle', 'a person outside the circle cannot be tagged');
select throws_ok(
  $$ update public.workout_posts set club_id = 'c0000000-0000-4000-8000-000000000001' where id = 'd0000000-0000-4000-8000-000000000001' $$,
  'P0001', 'a row cannot move to another circle', 'a post cannot move to another circle');

select * from finish();
rollback;
