-- notif_create: the one immediate insert path (rewritten for circles, 202610260001).
--
-- Nothing is written unless the type is one of the four, the recipient (and the
-- actor, if any) are in the named circle, no block separates them, and the
-- recipient turned the type on. Nothing is callable by a client.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

-- Circle A = m1 (owner), m2, m3.   Circle B = owner (owner), norec.
insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('owner'));
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'member'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('owner'), 'owner'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('norec'), 'member');

-- 1. No client role can call it ---------------------------------------------------
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
       gen_random_uuid(), '/circles', 'a0000000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'a plain member cannot call notif_create directly');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ select public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
       gen_random_uuid(), '/circles', 'a0000000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'neither can anyone else - the boundary is the missing grant, not a role check');
select tests.clear_auth();

-- 2. The deep-link CHECK still stops an open redirect ---------------------------------
select lives_ok(
  $$ insert into public.notifications (user_id, type, category, deep_link)
     values (tests.uid('m1'), 'trained_together', 'community',
             '/circles?c=' || gen_random_uuid()::text || '&post=' || gen_random_uuid()::text) $$,
  'a real deep link into a circle and a post inserts');
select throws_ok(
  $$ insert into public.notifications (user_id, type, category, deep_link)
     values (tests.uid('m1'), 'trained_together', 'community', 'https://evil.example/redirect') $$,
  '23514', null, 'a deep_link with no leading slash fails the CHECK');

-- 3. What is refused outright -----------------------------------------------------------
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'not a valid type', 'community', 't', 'b', null, null, null,
       'a0000000-0000-4000-8000-00000000000a') $$,
  'P0001', null, 'a type of the wrong shape raises');
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'streak_at_risk', 'community', 't', 'b', null, null, null,
       'a0000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'unknown notification type streak_at_risk', 'a gym-era type raises: only the four exist');
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'coach_mention', 'community', 't', 'b', null, null, null,
       'a0000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'unknown notification type coach_mention', 'so does a coach type');
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'trained_together', 'events', 't', 'b', null, null, null,
       'a0000000-0000-4000-8000-00000000000a') $$,
  'P0001', 'unknown notification category events', 'a gym-era category raises');
select throws_ok(
  $$ select public.notif_create(tests.uid('m1'), 'trained_together', 'community', 't', 'b', null, null, null) $$,
  'P0001', 'a notification belongs to a circle', 'a notification with no circle raises');

-- 4. Off by default -------------------------------------------------------------------------
select is(
  public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a1', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1')),
  null::uuid, 'no preference row means nothing is written');
select is_empty($$ select 1 from public.notifications where user_id = tests.uid('m2') $$, 'and nothing landed');

insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m2'), 'trained_together', 'in_app'),
  (tests.uid('m3'), 'trained_together', 'off'),
  (tests.uid('norec'), 'trained_together', 'in_app');

select isnt(
  public.notif_create(tests.uid('m2'), 'trained_together', 'community', 'hi', 'body', 'post',
    'c0260000-0000-4000-8000-0000000000a1', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1')),
  null::uuid, 'turned on, the row is written');
select results_eq(
  $$ select circle_id, actor_id from public.notifications where user_id = tests.uid('m2') $$,
  $$ values ('a0000000-0000-4000-8000-00000000000a'::uuid, tests.uid('m1')) $$,
  'and it knows its circle and who caused it');

select is(
  public.notif_create(tests.uid('m3'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a2', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1')),
  null::uuid, 'an explicit off writes nothing');

select public.notif_create(tests.uid('m2'), 'week_card', 'community', repeat('t', 200), repeat('b', 600), null,
  'c0260000-0000-4000-8000-0000000000a3', null, 'a0000000-0000-4000-8000-00000000000a', null);
select is((select count(*)::int from public.notifications where user_id = tests.uid('m2') and type = 'week_card'), 0,
  'a type the member did not turn on is not written even though another type is on');

-- 5. Circle scoping ------------------------------------------------------------------------------
select is(
  public.notif_create(tests.uid('norec'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a4', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1')),
  null::uuid, 'a recipient who is not in the named circle is not told about it');
select is(
  public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a5', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('norec')),
  null::uuid, 'and an actor from another circle cannot reach a member of this one');
select is(
  public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a6', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m2')),
  null::uuid, 'nobody is notified of their own act');

-- 6. Blocks, in both directions ------------------------------------------------------------------
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m1'), 'trained_together', 'in_app');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));
select is(
  public.notif_create(tests.uid('m1'), 'trained_together', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a7', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m3')),
  null::uuid, 'a block suppresses the write: recipient blocked the actor');
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('m3'), 'reaction', 'in_app');
select is(
  public.notif_create(tests.uid('m3'), 'reaction', 'community', 't', 'b', 'post',
    'c0260000-0000-4000-8000-0000000000a8', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1')),
  null::uuid, '...and the other way round: recipient was blocked by the actor');

-- 7. De-duplication: one event fired twice is one row --------------------------------------------
select public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
  'c0260000-0000-4000-8000-0000000000a9', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1'));
select public.notif_create(tests.uid('m2'), 'trained_together', 'community', 't', 'b', 'post',
  'c0260000-0000-4000-8000-0000000000a9', '/circles?c=x', 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1'));
select is(
  (select count(*)::int from public.notifications
    where user_id = tests.uid('m2') and source_id = 'c0260000-0000-4000-8000-0000000000a9'),
  1, 'the same (recipient, type, source) inside the window writes exactly one row');
select is(
  (select count(*)::int from public.notifications where user_id = tests.uid('m2') and type = 'trained_together'),
  2, 'a different source is a different event');

-- 8. Long text is cut, not refused ---------------------------------------------------------------
select public.notif_create(tests.uid('m2'), 'trained_together', 'community', repeat('t', 200), repeat('b', 600), 'post',
  'c0260000-0000-4000-8000-0000000000aa', null, 'a0000000-0000-4000-8000-00000000000a', tests.uid('m1'));
select results_eq(
  $$ select char_length(title), char_length(body) from public.notifications
      where source_id = 'c0260000-0000-4000-8000-0000000000aa' $$,
  $$ values (160, 500) $$,
  'a 200-character title and a 600-character body are cut to 160 and 500');

select * from finish();
rollback;
