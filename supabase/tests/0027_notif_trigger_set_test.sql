-- The notification triggers (rewritten for circles, 202610260001): a reaction on
-- my post, a tag waiting for my confirmation, someone joined my circle.
--
-- Scoping: no notification about a circle the recipient left, none between
-- blocked members, none unless the member turned the type on. Reactions are
-- batched: at most one notification per post per hour.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;
alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

-- Circle A = m1 (owner), m2, m3.   Circle B = owner (owner), m3.
insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('owner'));
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'member'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('owner'), 'owner'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('m3'), 'member');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'P1', 'active', now()),
  ('c0270000-0000-4000-8000-000000000002', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'P2', 'active', now()),
  ('c0270000-0000-4000-8000-000000000003', tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'P3 (m2 has not opted in)', 'active', now()),
  ('c0270000-0000-4000-8000-000000000004', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'P4 (reactor is blocked)', 'active', now()),
  ('c0270000-0000-4000-8000-000000000005', tests.uid('owner'), 'b0000000-0000-4000-8000-00000000000b', 'POST_WORKOUT', 'P5 (circle B)', 'active', now());

-- 1. Nobody can call a trigger function ---------------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.notif_on_reaction() $$, '42501', null, 'notif_on_reaction is not callable by a member');
select throws_ok($$ select public.notif_on_training_partner_tag() $$, '42501', null, 'neither is the tag trigger');
select throws_ok($$ select public.notif_on_circle_join() $$, '42501', null, 'neither is the join trigger');
select tests.clear_auth();

-- 2. Reactions --------------------------------------------------------------------------------------
-- Off by default: m1 has not opted in.
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m2'), 'fist_bump');
select is_empty($$ select 1 from public.notifications where type = 'reaction' $$,
  'a reaction on my post tells me nothing until I turn reactions on');
delete from public.reactions;

insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m1'), 'reaction', 'push');

insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m2'), 'fist_bump');
select results_eq(
  $$ select user_id, circle_id, actor_id, source_id, deep_link from public.notifications where type = 'reaction' $$,
  $$ values (tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a'::uuid, tests.uid('m2'),
             'c0270000-0000-4000-8000-000000000001'::uuid,
             '/circles?c=a0000000-0000-4000-8000-00000000000a&post=c0270000-0000-4000-8000-000000000001') $$,
  'turned on, a reaction notifies the author, scoped to the post''s circle, with a deep link to that circle and post');

-- BATCHING: at most one per post per hour, however many people or kinds.
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m2'), 'fire');
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m3'), 'clap');
select is((select count(*)::int from public.notifications where type = 'reaction' and source_id = 'c0270000-0000-4000-8000-000000000001'), 1,
  'two more reactions on the same post inside the hour (another kind, another person) add no notification');

insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000002', tests.uid('m2'), 'fist_bump');
select is((select count(*)::int from public.notifications where type = 'reaction'), 2,
  'a reaction on a DIFFERENT post is its own notification');

update public.notifications set created_at = now() - interval '61 minutes'
 where type = 'reaction' and source_id = 'c0270000-0000-4000-8000-000000000001';
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m3'), 'fist_bump');
select is((select count(*)::int from public.notifications where type = 'reaction' and source_id = 'c0270000-0000-4000-8000-000000000001'), 2,
  'an hour later the same post can notify again');

insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'fire');
select is((select count(*)::int from public.notifications where type = 'reaction'), 3,
  'reacting to my own post tells nobody (the count did not move)');

-- Off by default for everyone else.
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000003', tests.uid('m1'), 'fire');
select is_empty($$ select 1 from public.notifications where user_id = tests.uid('m2') $$,
  'm2 never opted in, so m1''s reaction on m2''s post tells m2 nothing');

-- Blocks, both directions.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000004', tests.uid('m3'), 'fire');
select is_empty($$ select 1 from public.notifications where source_id = 'c0270000-0000-4000-8000-000000000004' $$,
  'no notification between blocked members: m1 blocked m3, and m3 reacted to m1''s post');
delete from public.blocks;
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
insert into public.reactions (post_id, user_id, kind) values ('c0270000-0000-4000-8000-000000000004', tests.uid('m2'), 'fire');
select is((select count(*)::int from public.notifications where source_id = 'c0270000-0000-4000-8000-000000000004'), 1,
  'a block between two OTHER members changes nothing for m2''s reaction');
delete from public.blocks;

-- 3. Tags --------------------------------------------------------------------------------------------
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
values ('c0270000-0000-4000-8000-000000000001', tests.uid('m2'), tests.uid('m1'));
select is_empty($$ select 1 from public.notifications where type = 'trained_together' $$,
  'a tag tells the tagged member nothing until they turn it on');
delete from public.post_training_partners;

insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m2'), 'trained_together', 'push'),
  (tests.uid('m3'), 'trained_together', 'push');
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
values ('c0270000-0000-4000-8000-000000000001', tests.uid('m2'), tests.uid('m1'));
select results_eq(
  $$ select user_id, circle_id, actor_id, deep_link from public.notifications where type = 'trained_together' $$,
  $$ values (tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a'::uuid, tests.uid('m1'),
             '/circles?c=a0000000-0000-4000-8000-00000000000a&post=c0270000-0000-4000-8000-000000000001') $$,
  'a pending tag notifies the tagged member, scoped to the post''s circle');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
values ('c0270000-0000-4000-8000-000000000002', tests.uid('m3'), tests.uid('m1'));
select is((select count(*)::int from public.notifications where type = 'trained_together'), 1,
  'a tag from someone the tagged member blocked tells them nothing');
delete from public.blocks;

-- 4. Someone joined --------------------------------------------------------------------------------------
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m1'), 'circle_joined', 'push'),
  (tests.uid('m2'), 'circle_joined', 'push');
insert into public.circle_members (club_id, user_id, role)
values ('a0000000-0000-4000-8000-00000000000a', tests.uid('norec'), 'member');
select results_eq(
  $$ select user_id, circle_id, actor_id, deep_link from public.notifications where type = 'circle_joined' $$,
  $$ values (tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a'::uuid, tests.uid('norec'),
             '/circles?c=a0000000-0000-4000-8000-00000000000a') $$,
  'the owner is told that someone joined; a plain member who turned it on is not (it is not their circle to run)');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('coach'));
insert into public.circle_members (club_id, user_id, role)
values ('a0000000-0000-4000-8000-00000000000a', tests.uid('coach'), 'member');
select is((select count(*)::int from public.notifications where type = 'circle_joined'), 1,
  'the owner is not told about a joiner they blocked');
delete from public.blocks;

-- 5. Leaving a circle ----------------------------------------------------------------------------------------
select is((select count(*)::int from public.notifications where user_id = tests.uid('m2') and circle_id = 'a0000000-0000-4000-8000-00000000000a'), 1,
  'before leaving, m2 holds a notification about circle A');
delete from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m2');
select is((select count(*)::int from public.notifications where user_id = tests.uid('m2')), 0,
  'a member who leaves a circle keeps no notification about it');
select is((select count(*)::int from public.notifications where actor_id = tests.uid('m2')), 0,
  'and the others keep none that the leaver caused');

-- 6. Achievements no longer notify -----------------------------------------------------------------------------
select is_empty($$ select 1 from pg_trigger where tgname = 'member_achievements_notify' $$,
  'the achievement notification trigger is gone');
select hasnt_function('public', 'notif_on_achievement', 'and so is its function');

select * from finish();
rollback;
