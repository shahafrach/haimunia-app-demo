-- Module switches gate the server paths that bypassed them (202609230001).
--
-- For each function the migration gates: one case with the module on (the
-- call behaves as before) and one with it off (it refuses with
-- '<module_key> disabled', or - for the announcement fan-out - sends
-- nothing). Modules are switched as the bootstrap superuser, not through
-- admin_set_club_feature(), so the fixture leaves no admin_actions row.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.events (id, title, event_type, start_at, created_by, status)
  values ('e1250000-0000-4000-8000-000000000001', 'Event 0125', 'social_night', now() + interval '1 day', tests.uid('coach'), 'published');
insert into public.challenges (id, title, challenge_type, metric_type, start_at, end_at, created_by, status)
  values ('c1250000-0000-4000-8000-000000000001', 'Challenge 0125', 'individual_target', 'reps', now(), now() + interval '7 days', tests.uid('coach'), 'active');

-- =====================================================================
-- feed_page ('feed')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select * from public.feed_page(null, 20, 'for_you') $$,
  'feed_page: callable while the feed module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'feed';
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select * from public.feed_page(null, 20, 'for_you') $$,
  'P0001', 'feed disabled', 'feed_page: refuses once the feed module is off');
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'feed';

-- =====================================================================
-- post_create ('feed')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.post_create('post 0125 on', 'club', null, null) $$,
  'post_create: a member posts while the feed module is on');
select tests.clear_auth();
select isnt_empty($$ select 1 from public.workout_posts where body = 'post 0125 on' $$,
  'post_create: and the post exists');
update public.club_features set enabled = false where module_key = 'feed';
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.post_create('post 0125 off', 'club', null, null) $$,
  'P0001', 'feed disabled', 'post_create: refuses once the feed module is off');
select tests.clear_auth();
select is_empty($$ select 1 from public.workout_posts where body = 'post 0125 off' $$,
  'post_create: and nothing was written');
update public.club_features set enabled = true where module_key = 'feed';

-- =====================================================================
-- event_rsvp ('events')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.event_rsvp('e1250000-0000-4000-8000-000000000001', 'going') $$,
  'event_rsvp: a member RSVPs while the events module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'events';
select tests.set_auth(tests.uid('m2'));
select throws_ok($$ select public.event_rsvp('e1250000-0000-4000-8000-000000000001', 'going') $$,
  'P0001', 'events disabled', 'event_rsvp: refuses once the events module is off');
select tests.clear_auth();
select results_eq(
  $$ select user_id from public.event_attendees where event_id = 'e1250000-0000-4000-8000-000000000001' $$,
  $$ values (tests.uid('m1')) $$,
  'event_rsvp: only the RSVP made while the module was on exists');
update public.club_features set enabled = true where module_key = 'events';

-- =====================================================================
-- chal_progress ('challenges')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is((public.chal_progress('c1250000-0000-4000-8000-000000000001')).title, 'Challenge 0125',
  'chal_progress: readable while the challenges module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'challenges';
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.chal_progress('c1250000-0000-4000-8000-000000000001') $$,
  'P0001', 'challenges disabled', 'chal_progress: refuses once the challenges module is off');
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'challenges';

-- =====================================================================
-- ach_claim ('achievements')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select results_eq($$ select code from public.ach_claim(array['first_workout']) $$,
  $$ values ('first_workout') $$,
  'ach_claim: a member claims while the achievements module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'achievements';
select tests.set_auth(tests.uid('m2'));
select throws_ok($$ select * from public.ach_claim(array['first_workout']) $$,
  'P0001', 'achievements disabled', 'ach_claim: refuses once the achievements module is off');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.member_achievements ma
       join public.achievement_definitions d on d.id = ma.achievement_id
      where d.code = 'first_workout' and ma.user_id = tests.uid('m2') $$,
  'ach_claim: and nothing was awarded');
update public.club_features set enabled = true where module_key = 'achievements';

-- =====================================================================
-- community_streaks ('leaderboards')
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select * from public.community_streaks(50) $$,
  'community_streaks: callable while the leaderboards module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'leaderboards';
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select * from public.community_streaks(50) $$,
  'P0001', 'leaderboards disabled', 'community_streaks: refuses once the leaderboards module is off');
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'leaderboards';

-- =====================================================================
-- announcements insert (announcements_module_gate)
-- =====================================================================
-- m2 has announcements switched off, so the INSERT pass skips them and only
-- an escalation can reach them - the case the escalation checks below need.
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m2'), 'announcements', 'off')
on conflict (user_id, type) do update set channel = 'off';

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ insert into public.announcements (id, author_id, title, body)
     values ('a1250000-0000-4000-8000-000000000001', tests.uid('coach'), 'on', 'ann 0125 on') $$,
  'announcement insert: a coach publishes while the announcements module is on');
select tests.clear_auth();
update public.club_features set enabled = false where module_key = 'announcements';
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.announcements (author_id, title, body)
     values (tests.uid('coach'), 'off', 'ann 0125 off') $$,
  'P0001', 'announcements disabled', 'announcement insert: refuses once the announcements module is off');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.announcements (author_id, title, body)
     values (tests.uid('m1'), 'off', 'ann 0125 member off') $$,
  'P0001', 'announcements disabled', 'announcement insert: a member is refused with the module reason too');
select tests.clear_auth();
update public.club_features set enabled = true where module_key = 'announcements';

-- The module being on does not widen who may publish.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.announcements (author_id, title, body)
     values (tests.uid('m1'), 'member', 'ann 0125 member on') $$,
  '42501', null, 'announcement insert: with the module on, a member is still refused by announcements_insert_admin');
select tests.clear_auth();

-- =====================================================================
-- notif_announcement_fanout (announcements) - insert and escalation
-- =====================================================================
select isnt_empty(
  $$ select 1 from public.notifications
      where type = 'announcement' and source_id = 'a1250000-0000-4000-8000-000000000001'
        and user_id = tests.uid('m1') $$,
  'announcement notifications: sent while the announcements module is on');

update public.club_features set enabled = false where module_key = 'announcements';
-- Session-less: the insert trigger lets it through; the fan-out must not.
insert into public.announcements (id, author_id, title, body)
  values ('a1250000-0000-4000-8000-000000000002', tests.uid('coach'), 'off', 'ann 0125 sessionless off');
select is_empty(
  $$ select 1 from public.notifications
      where type = 'announcement' and source_id = 'a1250000-0000-4000-8000-000000000002' $$,
  'announcement notifications: nothing sent for an announcement written while the module is off');

-- Escalation to urgent while off reaches nobody either - m2, whose
-- preference is off, is the escalation pass's own audience.
update public.announcements set priority = 'urgent' where id = 'a1250000-0000-4000-8000-000000000001';
select is_empty(
  $$ select 1 from public.notifications
      where type = 'announcement' and source_id = 'a1250000-0000-4000-8000-000000000001'
        and user_id = tests.uid('m2') $$,
  'announcement notifications: an escalation while the module is off sends nothing');
update public.club_features set enabled = true where module_key = 'announcements';

-- And back on, the same escalation path does reach them.
update public.announcements set priority = 'normal' where id = 'a1250000-0000-4000-8000-000000000001';
update public.announcements set priority = 'urgent' where id = 'a1250000-0000-4000-8000-000000000001';
select isnt_empty(
  $$ select 1 from public.notifications
      where type = 'announcement' and source_id = 'a1250000-0000-4000-8000-000000000001'
        and user_id = tests.uid('m2') $$,
  'announcement notifications: with the module back on, the escalation reaches the member it skipped');

select * from finish();
rollback;
