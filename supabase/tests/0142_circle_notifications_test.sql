-- Circle notifications (202610260001): who is pushed to, and when.
--
--   Circle A = m1 (owner), m2, m3        Circle C = owner (m1, m2, m3 are NOT in it)
--
-- notif_push_pending re-checks the circle rules at SEND time, because a row can
-- outlive the facts that justified it: the recipient left, the actor left, a
-- block appeared, the post went. Also: the week card, preference types, and
-- account deletion removing the push subscriptions.

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

insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('c0000000-0000-4000-8000-00000000000c', 'Circle C', 'friends', tests.uid('owner'));
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'member'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('owner'), 'owner');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d0000000-0000-4000-8000-000000000001', tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'M2 workout', 'active', '2026-10-27T08:00:00Z', '2026-10-27');

insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m2'), 'reaction', 'push'),
  (tests.uid('m3'), 'reaction', 'push');
insert into public.push_subscriptions (id, user_id, endpoint, keys) values
  ('d1000000-0000-4000-8000-000000000002', tests.uid('m2'), 'https://push.example/m2', '{"p256dh":"BPk","auth":"aGk"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000003', tests.uid('m3'), 'https://push.example/m3', '{"p256dh":"BPk","auth":"aGk"}'::jsonb);

-- n1: a normal one. n2: about a circle the recipient is NOT in (left, or never was).
-- n3: caused by someone no longer in the circle. n4: no circle at all.
-- n5: about a post that is gone. n6: caused by a member who is blocked later.
insert into public.notifications (id, user_id, type, category, title, body, deep_link, circle_id, actor_id, source_type, source_id) values
  ('d2000000-0000-4000-8000-000000000001', tests.uid('m2'), 'reaction', 'community', 't', 'b', '/circles?c=a', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'post', 'd0000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000002', tests.uid('m3'), 'reaction', 'community', 't', 'b', '/circles?c=c', 'c0000000-0000-4000-8000-00000000000c', tests.uid('owner'), null, null),
  ('d2000000-0000-4000-8000-000000000003', tests.uid('m3'), 'reaction', 'community', 't', 'b', '/circles?c=a', 'a0000000-0000-4000-8000-00000000000a', tests.uid('owner'), null, null),
  ('d2000000-0000-4000-8000-000000000004', tests.uid('m3'), 'reaction', 'community', 't', 'b', '/circles', null, tests.uid('m1'), null, null),
  ('d2000000-0000-4000-8000-000000000005', tests.uid('m3'), 'reaction', 'community', 't', 'b', '/circles?c=a', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'post', 'd0000000-0000-4000-8000-0000000000ff');

create function tests.pending(p_id uuid) returns integer language sql as
  $$ select count(*)::int from public.notif_push_pending(100) where notification_id = p_id $$;

-- 1. The ordinary case, then each rule that must take it away ------------------------------------
select is(tests.pending('d2000000-0000-4000-8000-000000000001'), 1, 'opted in to push, in the circle, nobody blocked: pending');
select is(tests.pending('d2000000-0000-4000-8000-000000000002'), 0, 'NO PUSH ABOUT A CIRCLE THE RECIPIENT IS NOT IN: m3 is not in circle C');
select is(tests.pending('d2000000-0000-4000-8000-000000000003'), 0, 'nor one caused by someone who is no longer in the circle');
select is(tests.pending('d2000000-0000-4000-8000-000000000004'), 0, 'a notification with no circle is never pushed (fail closed)');
select is(tests.pending('d2000000-0000-4000-8000-000000000005'), 0, 'nor one about a post that no longer exists');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m1'));
select is(tests.pending('d2000000-0000-4000-8000-000000000001'), 0, 'NO PUSH BETWEEN BLOCKED MEMBERS: m2 blocked m1 after the row was written');
delete from public.blocks;
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m2'));
select is(tests.pending('d2000000-0000-4000-8000-000000000001'), 0, '...and the other direction: m1 blocked m2');
delete from public.blocks;
select is(tests.pending('d2000000-0000-4000-8000-000000000001'), 1, 'lifting the block makes it deliverable again');

-- m2 leaves circle A: the row is removed with them, and could not be pushed anyway.
delete from public.circle_members where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m2');
select is(tests.pending('d2000000-0000-4000-8000-000000000001'), 0, 'a member who left the circle is not pushed about it');
select is((select count(*)::int from public.notifications where id = 'd2000000-0000-4000-8000-000000000001'), 0, '...and the notification itself went when they left');
select is((select count(*)::int from public.notifications where id = 'd2000000-0000-4000-8000-000000000005'), 1, 'while an unrelated member''s notification about the same circle stays');

-- 2. Preference types: only the four, gym-era keys are refused ------------------------------------------
select lives_ok($$ insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'week_card', 'push') $$,
  'week_card is a preference type');
select throws_ok($$ insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'coach_mention', 'push') $$,
  '23514', null, 'a coach preference is refused');
select throws_ok($$ insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'event_cancelled', 'push') $$,
  '23514', null, 'an event preference is refused');
select throws_ok($$ insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'challenge_complete', 'push') $$,
  '23514', null, 'a challenge preference is refused');
select throws_ok($$ insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m1'), 'reactions', 'push') $$,
  '23514', null, 'and the old plural reactions key is gone');
select is(public.notif_pref_allows(tests.uid('m1'), 'circle_joined'), false, 'no row means a type is off');
select is(public.notif_pref_allows(tests.uid('m1'), 'week_card'), true, 'a row that is not off means on');

-- 3. The week card -------------------------------------------------------------------------------------------
-- m3 and m1 are in circle A (m2 left, and took their workout with them), which has m3's workout in the week of Sunday 2026-10-25.
-- Israel is UTC+2 that week, so Saturday 21:30 local is 19:30Z.
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m3'), 'week_card', 'push');
insert into public.member_targets (user_id, weekly_target, paused_until) values
  (tests.uid('m1'), 3, '2026-12-01');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d0000000-0000-4000-8000-000000000002', tests.uid('m3'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'M3 workout', 'active', '2026-10-27T08:00:00Z', '2026-10-27');
-- m1 turned the card on too, but is paused.
select is(public.notif_week_card_due('2026-10-30T10:00:00Z'), 0, 'Friday: the card is not ready');
select is(public.notif_week_card_due('2026-10-31T18:59:00Z'), 0, 'Saturday before 21:00 Israel time: not yet');
select is(public.notif_week_card_due('2026-10-31T19:30:00Z'), 1, 'Saturday night: the one unpaused member who turned it on is told (m1 is paused, m2 left, m3 is on)');
select results_eq(
  $$ select user_id, circle_id, deep_link from public.notifications where type = 'week_card' $$,
  $$ values (tests.uid('m3'), 'a0000000-0000-4000-8000-00000000000a'::uuid, '/circles?c=a0000000-0000-4000-8000-00000000000a&week=1') $$,
  'scoped to the circle, deep link to its week');
select is(public.notif_week_card_due('2026-10-31T20:30:00Z'), 0, 'the next hourly run sends nothing more');
update public.notifications set created_at = now() - interval '3 hours' where type = 'week_card';
select is(public.notif_week_card_due('2026-11-01T06:00:00Z'), 0, 'Sunday morning, even outside the dedupe window: still one per member per circle per week');
select is(public.notif_week_card_due('2026-11-01T11:00:00Z'), 0, 'Sunday afternoon: the window is over');
delete from public.workout_posts;
delete from public.notifications where type = 'week_card';
select is(public.notif_week_card_due('2026-10-31T19:30:00Z'), 0, 'a circle with no workout that week sends no card');

select is(has_function_privilege('authenticated', 'public.notif_week_card_due(timestamptz)', 'execute'), false, 'a member cannot trigger the week card job');
select is(has_function_privilege('service_role', 'public.notif_week_card_due(timestamptz)', 'execute'), true, 'the job runs as service_role');
select is((select count(*)::int from cron.job where jobname = 'week-card-notify'), 1, 'and it is scheduled');

-- 4. Account deletion removes the push subscriptions at once --------------------------------------------------
select is((select count(*)::int from public.push_subscriptions where user_id = tests.uid('m3')), 1, 'before: m3 has a push subscription');
select tests.set_auth(tests.uid('m3'));
select lives_ok($$ select public.request_account_deletion() $$, 'm3 asks for their account to be deleted');
select tests.clear_auth();
select is((select count(*)::int from public.push_subscriptions where user_id = tests.uid('m3')), 0, 'after: no device of theirs can be pushed to');

select * from finish();
rollback;
