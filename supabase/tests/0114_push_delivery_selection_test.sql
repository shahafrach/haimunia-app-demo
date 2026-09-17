-- Who actually receives a push notification.
--
-- The Edge Function that sends these (supabase/functions/notif_push_send)
-- contains no policy at all, on purpose: it fetches, encrypts and posts.
-- Every decision about WHO gets one - opted in, still a member, endpoint
-- still alive, notification still fresh - is made by notif_push_pending()
-- and is therefore testable here, against a real Postgres, instead of in
-- TypeScript against a push service nobody can observe.
--
-- That matters more than usual for this feature. A push that goes to the
-- wrong person cannot be recalled, and a push that silently goes nowhere
-- produces no error anywhere: the push service returns 201 and the phone
-- shows nothing. Both failures are invisible from the application.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- Fixtures: one opted-in member with a live subscription, one member who
-- never opted in, and one whose profile is gone.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pushyes@members.haimuniya.invalid',  '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pushno@members.haimuniya.invalid',   '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'pushgone@members.haimuniya.invalid', '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, handle, display_name, recovery_verified_at, deleted_at)
values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'push_yes',  'Opted In',   now(), null),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'push_no',   'Never Set',  now(), null),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'push_gone', 'Removed',    now(), now())
on conflict (id) do nothing;

insert into public.invite_redemptions (user_id, invite_id, role)
values
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-2222-4333-8444-555555555555', 'member'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-2222-4333-8444-555555555555', 'member'),
  ('bbbbbbbb-0000-4000-8000-000000000003', '11111111-2222-4333-8444-555555555555', 'member')
on conflict (user_id) do nothing;

-- Explicit opt-in to push. A missing row means in_app (notif_pref_allows's
-- rule), so this is the ONLY thing that makes a member reachable by push.
insert into public.notification_preferences (user_id, type, channel) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'streak_at_risk', 'push'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'streak_at_risk', 'push')
on conflict (user_id, type) do update set channel = excluded.channel;

insert into public.push_subscriptions (id, user_id, endpoint, keys) values
  ('44444444-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'https://push.example/live',    '{"p256dh":"BPk","auth":"aGk"}'::jsonb),
  ('44444444-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'https://push.example/nopref',  '{"p256dh":"BPk","auth":"aGk"}'::jsonb),
  ('44444444-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000003', 'https://push.example/deleted', '{"p256dh":"BPk","auth":"aGk"}'::jsonb)
on conflict (endpoint) do nothing;

insert into public.notifications (id, user_id, type, category, title, body, deep_link) values
  ('55555555-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'streak_at_risk', 'training', 'הרצף בסכנה', 'לא התאמנת היום', '/streak'),
  ('55555555-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'streak_at_risk', 'training', 'הרצף בסכנה', 'לא התאמנת היום', '/streak'),
  ('55555555-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000003', 'streak_at_risk', 'training', 'הרצף בסכנה', 'לא התאמנת היום', '/streak')
on conflict (id) do nothing;

-- =====================================================================
-- 1. The opt-in gate. Nobody is pushed to by default.
-- =====================================================================
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  1,
  'a member who explicitly set this type to push, with a live subscription, is pending');

select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000002'),
  0,
  'a member with NO preference row is not pushed to - a missing row means in_app, not push');

select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000003'),
  0,
  'a deleted profile is never pushed to, even though the opt-in and the subscription both survive it');

-- in_app and off are both "not push". Asserting each separately, because a
-- predicate written as `channel <> 'off'` would pass the off case and quietly
-- push to every in_app member in the club.
update public.notification_preferences set channel = 'in_app'
 where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'channel = in_app is not push');

update public.notification_preferences set channel = 'off'
 where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'channel = off is not push either');

update public.notification_preferences set channel = 'push'
 where user_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- =====================================================================
-- 2. Subscription hygiene.
-- =====================================================================
update public.push_subscriptions set revoked_at = now()
 where id = '44444444-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'a revoked subscription is not sent to');
update public.push_subscriptions set revoked_at = null
 where id = '44444444-0000-4000-8000-000000000001';

-- Encryption needs both halves. A row with one is not a usable subscription,
-- and encrypting against a null would build a body no browser can decrypt -
-- which the push service would still accept with a 201.
update public.push_subscriptions set keys = '{"auth":"aGk"}'::jsonb
 where id = '44444444-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'a subscription missing p256dh is skipped rather than sent an undecryptable body');
update public.push_subscriptions set keys = '{"p256dh":"BPk","auth":"aGk"}'::jsonb
 where id = '44444444-0000-4000-8000-000000000001';

-- =====================================================================
-- 3. Freshness and delivery marking.
-- =====================================================================
update public.notifications set created_at = now() - interval '25 hours'
 where id = '55555555-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'a notification older than 24h is dropped rather than delivered late - and that floor is also '
  'what stops a permanently failing endpoint being retried forever');
update public.notifications set created_at = now()
 where id = '55555555-0000-4000-8000-000000000001';

select is(
  public.notif_push_mark_sent(array['55555555-0000-4000-8000-000000000001']::uuid[]),
  1,
  'marking delivery stamps exactly the row asked for');

-- THE TRIGGER TRAP. protect_notification_content() blanks push_sent_at back to
-- its old value, and only checks auth.role() = 'authenticated'. If that guard
-- is ever widened, this stamp silently stops sticking, notif_push_pending
-- keeps returning the same row, and every member is re-sent the same
-- notification every three minutes until it ages out.
select isnt(
  (select push_sent_at from public.notifications where id = '55555555-0000-4000-8000-000000000001'),
  null,
  'and the stamp actually persisted - protect_notification_content does not block a service-side write');

select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  0,
  'a notification already marked sent is not pending again');

select is(
  public.notif_push_mark_sent(array['55555555-0000-4000-8000-000000000001']::uuid[]),
  0,
  'marking it a second time changes nothing - a retried Edge Function call cannot move the timestamp');

select is(
  public.notif_push_revoke(array['44444444-0000-4000-8000-000000000001']::uuid[]),
  1,
  'a 404/410 from the push service retires the endpoint');
select is(
  public.notif_push_revoke(array['44444444-0000-4000-8000-000000000001']::uuid[]),
  0,
  'and retiring it twice is a no-op');

-- =====================================================================
-- 4. These three read and write every member's notifications. No client
--    role may reach them.
-- =====================================================================
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('notif_push_pending', 'notif_push_mark_sent', 'notif_push_revoke')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))),
  0,
  'no push-delivery function is callable by anon or authenticated - notif_push_pending returns '
  'other members endpoints and notification bodies');

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('notif_push_pending', 'notif_push_mark_sent', 'notif_push_revoke')
      and has_function_privilege('service_role', p.oid, 'execute')),
  3,
  'and all three are callable by service_role, which is the only caller there is');

-- =====================================================================
-- 5. The schedule. A sender nothing invokes is a sender that never sends.
-- =====================================================================
select is(
  (select count(*)::int from cron.job where jobname = 'notif-push-send'),
  1,
  'the notif-push-send job is scheduled');

select is(
  btrim((select command from cron.job where jobname = 'notif-push-send')),
  'select public.cron_invoke_edge_function(''notif_push_send'')',
  'and it reaches the Edge Function through the same bridge recap_weekly uses');

-- =====================================================================
-- 6. The admin kill switch (202609170003).
--
-- The owner asked for one switch that stops push for the whole club. Five of
-- the toggles added on 2026-09-15 are clientOnly - they hide a control and
-- the panel says so. This one must not be: a member already subscribed, on a
-- notification already written, with a cron already running, must stop
-- receiving. So the assertion is on the SQL, not on the rendering.
-- =====================================================================
-- Put one row back in a deliverable state first, so "nothing pending" below
-- means the switch did it and not the fixtures.
update public.notifications set push_sent_at = null, created_at = now()
 where id = '55555555-0000-4000-8000-000000000001';
update public.push_subscriptions set revoked_at = null
 where id = '44444444-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  1,
  'deliverable again with the module on - so the next assertion measures the switch');

update public.club_features set enabled = false where module_key = 'push_notifications';
select is(
  (select count(*)::int from public.notif_push_pending(100)),
  0,
  'with the club module off, NOTHING is pending for anybody - not filtered per member, off');

-- And the off period must not silently consume the notifications written
-- during it. push_sent_at stays null, so they become deliverable again when
-- the switch goes back on, provided they are still inside the 24h window.
select is(
  (select push_sent_at from public.notifications where id = '55555555-0000-4000-8000-000000000001'),
  null,
  'a notification written while push is off is not marked sent - turning push off for an '
  'afternoon does not throw that afternoon away');

update public.club_features set enabled = true where module_key = 'push_notifications';
select is(
  (select count(*)::int from public.notif_push_pending(100)
    where notification_id = '55555555-0000-4000-8000-000000000001'),
  1,
  'and switching it back on resumes delivery of the row that was waiting');

select is(
  (select count(*)::int from public.club_features where module_key = 'push_notifications'),
  1,
  'the module has a row, so the admin panel is not rendering a toggle with nothing behind it');

select * from finish();
rollback;
