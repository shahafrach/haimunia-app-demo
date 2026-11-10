-- 202611100001: the lost-code reset (fix plan F19).
--
-- Defended here:
--   1. reset_requests has no client grant (anon, authenticated, PUBLIC), RLS on,
--      no policy; service_role can use it.
--   2. my_pending_reset() answers only for the caller, and only while the
--      request is open (not cancelled, not expired).
--   3. cancel_my_reset() cancels only the caller's own request, blocks new ones
--      for 24 hours, and anon cannot call it.
--   4. reset_notify_requested() is service_role only, and its row is pushed with
--      no preference row (notif_push_pending), to the account's own devices only.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- 1. The table is closed
select ok(not has_table_privilege('anon', 'public.reset_requests', 'select'), 'anon cannot select reset_requests');
select ok(not has_table_privilege('authenticated', 'public.reset_requests', 'select'), 'authenticated cannot select reset_requests');
select ok(not has_table_privilege('authenticated', 'public.reset_requests', 'insert'), 'authenticated cannot insert reset_requests');
select ok(not has_table_privilege('authenticated', 'public.reset_requests', 'update'), 'authenticated cannot update reset_requests');
select ok(not has_table_privilege('authenticated', 'public.reset_requests', 'delete'), 'authenticated cannot delete reset_requests');
select ok(has_table_privilege('service_role', 'public.reset_requests', 'insert'), 'service_role can write it');
select is((select relrowsecurity from pg_class where oid = 'public.reset_requests'::regclass), true, 'RLS is on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'reset_requests'), 0, 'and there is no policy');

insert into public.reset_requests (user_id, token_hmac, created_at, ready_at, expires_at) values
  (tests.uid('m1'), repeat('a', 64), now() - interval '1 hour', now() + interval '11 hours', now() + interval '35 hours'),
  (tests.uid('m2'), repeat('b', 64), now() - interval '40 hours', now() - interval '28 hours', now() - interval '4 hours');

-- 2. my_pending_reset
select ok(not has_function_privilege('anon', 'public.my_pending_reset()', 'execute'), 'anon cannot ask for a pending reset');
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.my_pending_reset()), 1, 'a member sees their own open request');
select ok((select ready_at > now() from public.my_pending_reset()), 'with when the wait ends');
select throws_ok($$ select * from public.reset_requests $$, '42501', null, 'and cannot read the table itself');
select tests.clear_auth();
select tests.set_auth(tests.uid('m2'));
select is((select count(*)::int from public.my_pending_reset()), 0, 'an expired request is not shown');
select tests.clear_auth();
select tests.set_auth(tests.uid('m3'));
select is((select count(*)::int from public.my_pending_reset()), 0, 'another member sees nothing of m1''s request');

-- 3. cancel_my_reset
select is(public.cancel_my_reset(), false, 'a member with no open request cancels nothing');
select tests.clear_auth();
select is((select cancelled_at from public.reset_requests where user_id = tests.uid('m1')), null::timestamptz, 'm3''s call left m1''s request alone');
select ok(not has_function_privilege('anon', 'public.cancel_my_reset()', 'execute'), 'anon cannot cancel');
select tests.set_auth(tests.uid('m1'));
select is(public.cancel_my_reset(), true, 'the member cancels their own request');
select is((select count(*)::int from public.my_pending_reset()), 0, 'and it is no longer pending');
select tests.clear_auth();
select ok((select blocked_until > now() + interval '23 hours' from public.reset_requests where user_id = tests.uid('m1')),
  'a cancel blocks new requests for 24 hours');

-- 4. The push
select ok(not has_function_privilege('authenticated', 'public.reset_notify_requested(uuid, timestamp with time zone)', 'execute'), 'authenticated cannot write a reset notification');
select ok(not has_function_privilege('anon', 'public.reset_notify_requested(uuid, timestamp with time zone)', 'execute'), 'anon cannot');
select ok(has_function_privilege('service_role', 'public.reset_notify_requested(uuid, timestamp with time zone)', 'execute'), 'service_role can');

delete from public.notification_preferences where user_id in (tests.uid('m1'), tests.uid('m2'));
insert into public.push_subscriptions (user_id, endpoint, keys) values
  (tests.uid('m1'), 'https://push.example/reset-m1', '{"p256dh":"x","auth":"y"}'),
  (tests.uid('m2'), 'https://push.example/reset-m2', '{"p256dh":"x","auth":"y"}');
select isnt(public.reset_notify_requested(tests.uid('m1'), now() + interval '12 hours'), null::uuid, 'the notification is written');
select is((select count(*)::int from public.notif_push_pending(100) where notification_type = 'reset_requested' and endpoint = 'https://push.example/reset-m1'), 1,
  'it is pushed with no preference row, to the account''s own device');
select is((select count(*)::int from public.notif_push_pending(100) where notification_type = 'reset_requested' and endpoint <> 'https://push.example/reset-m1'), 0,
  'and to no other member''s device');
select is((select count(*)::int from public.notif_push_pending(100) where notification_type = 'workout_reminder'), 0,
  'other personal types still need their preference row');

select * from finish();
rollback;
