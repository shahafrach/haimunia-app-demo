-- COMM-020 run C: real enforcement for the notification trigger set, trimmed
-- to what survived the strip-gym migration (202610250001).
-- Boundaries: the trigger functions that remain are unreachable by a direct
-- client RPC. A reaction is never immediate, always notif_queue_batched on
-- the post author's community batch, never on your own post, and an off
-- reactions preference drops the enqueue entirely (the key is simply absent
-- from pending, not present at zero). A block edge suppresses the enqueue.
-- The comment, mention, announcement and friend-achievement paths went with
-- their features and their tests with them.
--
-- Every state check below runs as tests.clear_auth() (the bootstrap
-- superuser, which bypasses notifications' and notification_batches' own
-- select-your-own-row RLS) rather than as the acting member.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_on_reaction() $$, '42501', null,
  'notif_on_reaction cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_achievement() $$, '42501', null,
  'notif_on_achievement cannot be called directly by a member');

select tests.clear_auth();

insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'P1 - off preference'),
  ('c0270000-0000-4000-8000-000000000003', tests.uid('owner'), 'club', 'P5 - reaction'),
  ('c0270000-0000-4000-8000-000000000005', tests.uid('m2'), 'club', 'P4b - reaction block edge'),
  ('c0270000-0000-4000-8000-000000000007', tests.uid('norec'), 'club', 'P8 - self reaction');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m3'));

-- =====================================================================
-- notif_on_reaction: never immediate, always the post author's community
-- batch, never on your own post
-- =====================================================================
-- P8/norec is used nowhere else in this file, so its community batch row
-- staying entirely absent is a clean signal -.
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000007', tests.uid('norec')) $$,
  'the post author reacts to their own post');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('norec') and category = 'community' $$,
  'reacting to your own post enqueues nothing at all');

select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000003', tests.uid('m1')) $$,
  'm1 reacts to owner''s post');
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('owner') and type = 'reaction' $$,
  'a reaction never writes an immediate notification row');
select results_eq(
  $$ select (pending #>> array['reaction', 'count'])::int from public.notification_batches
     where user_id = tests.uid('owner') and category = 'community' $$,
  $$ values (1) $$,
  'instead the reaction is queued into the post author''s community batch');

-- --- block edge suppresses the reaction enqueue too (m2 blocked m3) ----
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000005', tests.uid('m3')) $$,
  'm3 reacts to m2''s post despite the block edge - the reaction row itself still lands');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m2') and category = 'community' $$,
  'the block edge suppressed the reaction enqueue - m2 has no community batch row at all');

-- --- an off reactions preference drops the enqueue: the key is simply
-- absent, not present at zero ---------------------------------------
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m1'), 'reactions', 'off');
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000001', tests.uid('m3')) $$,
  'm3 reacts to m1''s post after m1 switched reactions off');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m1') and category = 'community' $$,
  'no batch row exists for m1 at all - the off preference dropped the enqueue');

select * from finish();
rollback;
