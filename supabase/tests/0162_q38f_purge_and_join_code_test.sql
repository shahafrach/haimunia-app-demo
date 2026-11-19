-- Q-38f (202611180003): the purge of abandoned club accounts (warn first, never staff, a batch gate, one
-- deletion body) and the join code's HMAC, per-IP limit and global ceiling.
--
--   Club K: owner (owner), coach (coach), m3, norec, admin, m2

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

alter table public.workout_posts alter column club_id drop default;

select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, anon, service_role;

select is(public.owner_create_club('owner', 'Haimunia'), 'created', 'setup: the club');
insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'),
  (tests.kid(), tests.uid('norec'), 'member'), (tests.kid(), tests.uid('admin'), 'member'), (tests.kid(), tests.uid('m2'), 'member');
select is(public.owner_set_coach('coach'), 'set', 'setup: the coach');

-- Everyone looks 400 days idle. Then: m3 has a recent post, admin a recent mark_active.
update auth.users set created_at = now() - interval '400 days', last_sign_in_at = now() - interval '400 days'
 where id in (tests.uid('owner'), tests.uid('coach'), tests.uid('m3'), tests.uid('norec'), tests.uid('admin'), tests.uid('m2'));
delete from auth.sessions where user_id in (tests.uid('owner'), tests.uid('coach'), tests.uid('m3'), tests.uid('norec'), tests.uid('admin'), tests.uid('m2'));
delete from auth.refresh_tokens where user_id in (tests.uid('owner')::text, tests.uid('coach')::text, tests.uid('m3')::text, tests.uid('norec')::text, tests.uid('admin')::text, tests.uid('m2')::text);
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on)
values ('f3a00000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3', 'active', now() - interval '20 days', current_date);

-- =====================================================================================================
-- 1. Closed to clients; mark_active is the member's own
-- =====================================================================================================
select ok(not has_table_privilege('authenticated', 'public.account_activity', 'select'), 'account_activity: no client reads');
select ok(not has_function_privilege('authenticated', 'public.purge_abandoned_club_accounts(integer, integer)', 'execute'), 'purge: no role');
select ok(not has_function_privilege('service_role', 'public.delete_account_now(uuid)', 'execute'), 'delete_account_now: no role');
select ok(not has_function_privilege('authenticated', 'public.join_code_key()', 'execute'), 'join_code_key: no role');
select ok(has_function_privilege('authenticated', 'public.mark_active()', 'execute'), 'mark_active: authenticated');

select tests.set_auth(tests.uid('admin'));
select lives_ok($$ select public.mark_active() $$, 'admin opens the app');
select tests.clear_auth();
select ok((select last_active_at > now() - interval '1 minute' from public.account_activity where user_id = tests.uid('admin')), 'and is active now');
select ok(public.account_last_activity(tests.uid('m3')) > now() - interval '21 days', 'a post counts as activity');

-- =====================================================================================================
-- 2. Warn first, never staff
-- =====================================================================================================
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.purge_abandoned_club_accounts(365, 25) $$, '42501', null, 'not callable from a session');
select tests.clear_auth();

select is(public.purge_abandoned_club_accounts(365, 25), '{"aborted": false, "warned": 2, "deleted": 0, "failed": 0}'::jsonb,
  'first run: norec and m2 are warned, nobody is deleted');
select is((select count(*)::int from public.notifications where type = 'account_purge_warning'), 2, 'one warning each');
select ok(not exists (select 1 from public.notifications where type = 'account_purge_warning'
                       and user_id in (tests.uid('owner'), tests.uid('coach'))), 'never the owner or the coach, however idle');
select is(public.purge_abandoned_club_accounts(365, 25) ->> 'warned', '0', 'a second run does not warn again');

-- m2 opens the app after the warning: the clock starts again.
select tests.set_auth(tests.uid('m2'));
select public.mark_active();
select tests.clear_auth();
-- 31 days pass for the warnings.
update public.account_activity set purge_warned_at = now() - interval '31 days' where purge_warned_at is not null;
update public.account_activity set last_active_at = now() - interval '1 day' where user_id = tests.uid('m2');

select is(public.purge_abandoned_club_accounts(365, 25), '{"aborted": false, "warned": 0, "deleted": 1, "failed": 0}'::jsonb,
  '31 days after the warning: norec is deleted; m2, active since, is not');
select ok(not exists (select 1 from auth.users where id = tests.uid('norec')), 'norec''s account is gone');
select ok(not exists (select 1 from public.circle_members where user_id = tests.uid('norec')), 'and its membership');
select ok(exists (select 1 from auth.users where id = tests.uid('m2')), 'm2 stays');
select ok(exists (select 1 from auth.users where id = tests.uid('owner')) and exists (select 1 from auth.users where id = tests.uid('coach')), 'staff stay');

-- =====================================================================================================
-- 3. The batch gate
-- =====================================================================================================
update public.account_activity set last_active_at = now() - interval '400 days' where user_id = tests.uid('m2');
insert into public.account_activity (user_id, purge_warned_at) values (tests.uid('admin'), now() - interval '40 days')
on conflict (user_id) do update set purge_warned_at = now() - interval '40 days', last_active_at = now() - interval '400 days';
update public.account_activity set purge_warned_at = now() - interval '40 days' where user_id = tests.uid('m2');
select is(public.purge_abandoned_club_accounts(365, 1), '{"aborted": true, "due": 2, "warned": 0, "deleted": 0}'::jsonb,
  'two due with a batch of one: aborted, nobody deleted');
select ok(exists (select 1 from auth.users where id = tests.uid('m2')) and exists (select 1 from auth.users where id = tests.uid('admin')), 'both still there');
select ok(exists (select 1 from cron.job where jobname = 'purge-abandoned-club-accounts' and command like '%purge_abandoned_club_accounts(365, 25)%'), 'the daily job');

-- =====================================================================================================
-- 4. The join code: HMAC, the old sha256 row, the per-IP limit and the global ceiling
-- =====================================================================================================
select tests.set_auth(tests.uid('coach'));
select public.rotate_club_invite(tests.kid()) ->> 'code' as code1 \gset
select tests.clear_auth();
select is((select code_hash from public.circle_invites where club_id = tests.kid()), public.join_code_hmac(:'code1'), 'stored as the HMAC under the Vault key');
select isnt((select code_hash from public.circle_invites where club_id = tests.kid()), encode(extensions.digest(:'code1', 'sha256'), 'hex'), 'not the plain sha256');

-- A row from before this migration (sha256) still works until it is rotated.
update public.circle_invites set code_hash = encode(extensions.digest(:'code1', 'sha256'), 'hex') where club_id = tests.kid();
delete from public.circle_members where user_id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));
select is(public.join_circle(:'code1') ->> 'status', 'joined', 'the legacy sha256 row still joins');
select tests.clear_auth();

-- Per IP: 20 code attempts an hour from one address.
select set_config('request.headers', '{"cf-connecting-ip": "203.0.113.9"}', true);
delete from public.transfer_attempts;
select tests.set_auth(tests.uid('admin'));
select is((select count(*)::int from (select public.join_circle('ZZZZ2345') ->> 'status' s from generate_series(1, 9)) x where s = 'invalid'), 9, 'wrong codes are invalid');
select tests.clear_auth();
update public.transfer_attempts set attempt_count = 20 where action = 'join_code';
select tests.set_auth(tests.uid('m2'));
select is(public.join_circle('ZZZZ2345') ->> 'status', 'rate_limited', 'the 21st from that address, from any account, is refused');
select tests.clear_auth();
select ok((select attempt_count from public.transfer_attempts where ip_hash = repeat('0', 64) and action = 'join_code_wrong') >= 9, 'wrong codes are counted globally');

-- Global: once 3000 wrong codes came in an hour (300 until Q-45, 202611190001), codes wait for everyone; the long token does not.
select set_config('request.headers', '{"cf-connecting-ip": "198.51.100.200"}', true);
update public.transfer_attempts set attempt_count = 3000 where ip_hash = repeat('0', 64) and action = 'join_code_wrong';
select tests.set_auth(tests.uid('m3'));
select is(public.join_circle(:'code1') ->> 'status', 'rate_limited', 'over the global ceiling even the right code waits');

select * from finish();
rollback;
