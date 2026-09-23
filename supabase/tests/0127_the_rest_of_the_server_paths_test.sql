-- The rest of the server paths, gated (202609230003).
--
-- 0125 covers the seven paths 202609230001 gated. This file covers the ones
-- its description listed as still open, and which 202609230003 closed. Same
-- shape as 0125: module on, the call behaves; module off, it refuses with
-- '<module_key> disabled'. Modules are switched as the bootstrap superuser,
-- so the fixture leaves no admin_actions row.
--
-- The three notification paths are the exception and get their own section:
-- they must SKIP rather than raise, because a trigger that raises aborts the
-- write it hangs off. A switched-off achievements module must still let an
-- achievement be recorded; it just must not announce it.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, created_by, status)
  values ('c1270000-0000-4000-8000-000000000001', 'Challenge 0127', 'individual_target', 'reps',
          now(), now() + interval '7 days', tests.uid('coach'), 'active');
insert into public.challenge_participants (challenge_id, user_id, status)
  values ('c1270000-0000-4000-8000-000000000001', tests.uid('m1'), 'active');

-- One post of m1's own, for the edit/visibility/comment/reaction paths.
-- Inserted directly as the bootstrap superuser with a LITERAL id, the way
-- 0125 seeds its event and challenge. Two reasons it is not created through
-- post_create() and looked up afterwards: with the feed module OFF a member
-- cannot SELECT workout_posts at all, so a lookup inside an assertion would
-- return null and the function would raise 'post not found' before reaching
-- the gate under test; and psql does not interpolate a \gset variable inside
-- a $$-quoted assertion body, so the id has to be written in.
insert into public.workout_posts (id, author_id, post_type, body, visibility, status)
values ('40270000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT',
        'post 0127', 'club', 'active');

-- =====================================================================
-- feed: the write paths that reach workout_posts without post_create
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.post_edit_caption(
  '40270000-0000-4000-8000-000000000001'::uuid,
  'edited while on') $$, 'post_edit_caption: works while the feed module is on');
select tests.clear_auth();

update public.club_features set enabled = false where module_key = 'feed';
select tests.set_auth(tests.uid('m1'));

select throws_ok($$ select public.post_edit_caption(
  '40270000-0000-4000-8000-000000000001'::uuid,
  'edited while off') $$,
  'P0001', 'feed disabled', 'post_edit_caption: refuses once the feed module is off');

select throws_ok($$ select public.post_set_visibility(
  '40270000-0000-4000-8000-000000000001'::uuid,
  'only_me'::public.post_visibility) $$,
  'P0001', 'feed disabled', 'post_set_visibility: refuses once the feed module is off');

select throws_ok($$ select public.add_post_comment(
  '40270000-0000-4000-8000-000000000001'::uuid,
  'comment while off', null::uuid) $$,
  'P0001', 'feed disabled', 'add_post_comment: refuses once the feed module is off');

select throws_ok($$ select public.toggle_reaction(
  '40270000-0000-4000-8000-000000000001'::uuid, null::uuid) $$,
  'P0001', 'feed disabled', 'toggle_reaction: refuses once the feed module is off');

select throws_ok($$ select public.community_profile(tests.uid('m2')) $$,
  'P0001', 'feed disabled', 'community_profile: refuses once the feed module is off');

select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'feed';

-- =====================================================================
-- challenges: progress and the club summary that reads it
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.chal_record_progress(
  'c1270000-0000-4000-8000-000000000001', tests.uid('m1'), 5, 'on', null) $$,
  'chal_record_progress: works while the challenges module is on');
select tests.clear_auth();

update public.club_features set enabled = false where module_key = 'challenges';

select tests.set_auth(tests.uid('coach'));
select throws_ok($$ select public.chal_record_progress(
  'c1270000-0000-4000-8000-000000000001', tests.uid('m1'), 5, 'off', null) $$,
  'P0001', 'challenges disabled', 'chal_record_progress: refuses once challenges is off');
select tests.clear_auth();

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.club_summary() $$,
  'P0001', 'challenges disabled', 'club_summary: refuses once challenges is off - its payload is the live challenges');
select tests.clear_auth();

-- The scheduled notifier returns a count, so it must return 0, not raise:
-- raising inside a cron job turns a switched-off module into a failing job.
select is(public.chal_notify_ending_soon(), 0,
  'chal_notify_ending_soon: sends nothing and returns 0 while challenges is off, rather than raising');

update public.club_features set enabled = true where module_key = 'challenges';

-- =====================================================================
-- The notification paths SKIP rather than abort the underlying write
-- =====================================================================
update public.club_features set enabled = false where module_key = 'achievements';

-- The achievement is still recorded; only the notification is skipped.
select lives_ok($$
  insert into public.member_achievements (user_id, achievement_id, visibility)
  select tests.uid('m1'), d.id, 'club'
  from public.achievement_definitions d order by d.id limit 1 $$,
  'notif_on_achievement: an achievement is still RECORDED while achievements is off');

select is_empty($$
  select 1 from public.notifications
  where user_id = tests.uid('m1') and type = 'achievement_unlocked' $$,
  'notif_on_achievement: and no notification was written for it');

update public.club_features set enabled = true where module_key = 'achievements';

update public.club_features set enabled = false where module_key = 'events';
insert into public.events (id, title, event_type, start_at, created_by, status)
  values ('e1270000-0000-4000-8000-000000000001', 'Event 0127', 'social_night',
          now() + interval '1 day', tests.uid('coach'), 'published');
insert into public.event_attendees (event_id, user_id, response)
  values ('e1270000-0000-4000-8000-000000000001', tests.uid('m1'), 'going');

select lives_ok($$ update public.events set status = 'cancelled'
                   where id = 'e1270000-0000-4000-8000-000000000001' $$,
  'notif_on_event_cancelled: the cancellation still SUCCEEDS while events is off');

select is_empty($$
  select 1 from public.notifications
  where user_id = tests.uid('m1') and type = 'event_cancelled' $$,
  'notif_on_event_cancelled: and no notification was written for it');

update public.club_features set enabled = true where module_key = 'events';

select * from finish();
rollback;
