-- Cross-circle leak tests (202610250003). GENERATED once from a table list and
-- committed as plain SQL; edit it by hand from here.
--
-- For EVERY table in public: a member of circle A (m1) sees zero rows of
-- circle B (or of a person outside A), and can neither insert, update nor
-- delete them. "Zero" is a count of rows, not an absence of an error: select
-- and DML both run and are counted. Only 42501 (permission denied / RLS
-- violation) is swallowed, so a typo in a statement fails loudly instead of
-- passing as "blocked". Every victim row is first proven to exist.
--
-- Circle A: m1, m2.   Circle B: m3 (member), owner (owner).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- Real columns, not the fixture's in-transaction defaults.
alter table public.workout_posts alter column club_id drop default;
alter table public.post_training_partners alter column club_id drop default;

-- Counting helpers, run as the impersonated member.
create function tests.leak_count(p_tbl text, p_pred text) returns bigint
language plpgsql as $fn$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s', p_tbl, p_pred) into n;
  return n;
exception when insufficient_privilege then return 0;
end $fn$;
create function tests.leak_dml(p_sql text) returns integer
language plpgsql as $fn$
declare n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when insufficient_privilege then return 0;
end $fn$;
grant execute on function tests.leak_count(text, text), tests.leak_dml(text) to authenticated;

-- ---------------------------------------------------------------------
-- Fixtures: two circles, two posts.
-- ---------------------------------------------------------------------
select tests.clear_auth();
delete from public.circle_members;
delete from public.clubs;

insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('m3'));
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'), ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('owner'), 'owner'), ('b0000000-0000-4000-8000-00000000000b', tests.uid('m3'), 'member');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('a1000000-0000-4000-8000-000000000001', tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a', 'POST_TEXT', 'A post', 'active', now()),
  ('b1000000-0000-4000-8000-000000000001', tests.uid('m3'), 'b0000000-0000-4000-8000-00000000000b', 'POST_TEXT', 'B post', 'active', now());

insert into public.account_deletion_requests (user_id, purge_after) values (tests.uid('m3'), now() + interval '30 days');
insert into public.achievement_definitions (code, name, description, category, trigger_type, visibility) values ('leak_probe', 'Probe', 'd', 'consistency', 'WORKOUT_COMPLETED', 'club');
insert into public.analytics_events (user_id, event_name) values (tests.uid('m3'), 'leak_probe');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('owner'));
insert into public.bug_reports (reporter_id, body) values (tests.uid('m3'), 'probe');
insert into public.circle_invites (club_id, token_hash, created_by, expires_at) values ('b0000000-0000-4000-8000-00000000000b', repeat('b', 64), tests.uid('owner'), now() + interval '7 days');
insert into public.edge_function_invocations (request_id, slug) values (987654321, 'leak_probe');
insert into public.invite_attempts (user_id, actor_key_hash) values (tests.uid('m3'), repeat('d', 64));
insert into public.invite_codes (code_hash, role, active, max_uses) values (repeat('b', 64), 'member', true, 5);
insert into public.invites (club_id, code_hash, role) values ('b0000000-0000-4000-8000-00000000000b', repeat('f', 64), 'member');
insert into public.job_health_state (id) values (true) on conflict do nothing;
insert into public.member_achievements (user_id, achievement_id) select tests.uid('m3'), id from public.achievement_definitions where code = 'leak_probe';
insert into public.member_targets (user_id, weekly_target) values (tests.uid('m3'), 4);
insert into public.notification_batches (user_id, category, pending_count, pending, window_started_at, next_flush_at) values (tests.uid('m3'), 'community', 0, '[]'::jsonb, now(), now());
insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m3'), 'reaction', 'off');
insert into public.notifications (user_id, type, category, title, body) values (tests.uid('m3'), 'leak_probe', 'community', 't', 'b');
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by) values ('b1000000-0000-4000-8000-000000000001', tests.uid('owner'), tests.uid('m3'));
insert into public.private_records (user_id, record_type, record_id, payload) values (tests.uid('m3'), 'session_note', 'leak-probe', '{}'::jsonb);
insert into public.push_subscriptions (user_id, endpoint, keys) values (tests.uid('m3'), 'https://example.test/leak', '{"p256dh":"k","auth":"a"}'::jsonb);
insert into public.rate_limits (user_id, action) values (tests.uid('m3'), 'leak_probe');
insert into public.reactions (post_id, user_id, kind) values ('b1000000-0000-4000-8000-000000000001', tests.uid('owner'), 'cheer');
insert into public.request_idempotency (user_id, action, idempotency_key) values (tests.uid('m3'), 'leak_probe', gen_random_uuid());

-- Positive controls: the victim rows exist, so a count of zero below means something.
select cmp_ok((select count(*) from public.account_deletion_requests where user_id = tests.uid('m3')), '>', 0::bigint, 'account_deletion_requests: the victim row exists');
select cmp_ok((select count(*) from public.achievement_definitions where code = 'leak_probe'), '>', 0::bigint, 'achievement_definitions: the victim row exists');
select cmp_ok((select count(*) from public.analytics_events where event_name = 'leak_probe'), '>', 0::bigint, 'analytics_events: the victim row exists');
select cmp_ok((select count(*) from public.blocks where blocker_id = tests.uid('m3')), '>', 0::bigint, 'blocks: the victim row exists');
select cmp_ok((select count(*) from public.bug_reports where reporter_id = tests.uid('m3')), '>', 0::bigint, 'bug_reports: the victim row exists');
select cmp_ok((select count(*) from public.circle_invites where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'circle_invites: the victim row exists');
select cmp_ok((select count(*) from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'circle_members: the victim row exists');
select cmp_ok((select count(*) from public.clubs where id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'clubs: the victim row exists');
select cmp_ok((select count(*) from public.edge_function_invocations where slug = 'leak_probe'), '>', 0::bigint, 'edge_function_invocations: the victim row exists');
select cmp_ok((select count(*) from public.invite_attempts where user_id = tests.uid('m3')), '>', 0::bigint, 'invite_attempts: the victim row exists');
select cmp_ok((select count(*) from public.invite_codes where code_hash = repeat('b', 64)), '>', 0::bigint, 'invite_codes: the victim row exists');
select cmp_ok((select count(*) from public.invite_redemptions where user_id = tests.uid('m3')), '>', 0::bigint, 'invite_redemptions: the victim row exists');
select cmp_ok((select count(*) from public.invites where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'invites: the victim row exists');
select cmp_ok((select count(*) from public.job_health_state where true), '>', 0::bigint, 'job_health_state: the victim row exists');
select cmp_ok((select count(*) from public.member_achievements where user_id = tests.uid('m3')), '>', 0::bigint, 'member_achievements: the victim row exists');
select cmp_ok((select count(*) from public.member_targets where user_id = tests.uid('m3')), '>', 0::bigint, 'member_targets: the victim row exists');
select cmp_ok((select count(*) from public.notification_batches where user_id = tests.uid('m3')), '>', 0::bigint, 'notification_batches: the victim row exists');
select cmp_ok((select count(*) from public.notification_preferences where user_id = tests.uid('m3')), '>', 0::bigint, 'notification_preferences: the victim row exists');
select cmp_ok((select count(*) from public.notifications where user_id = tests.uid('m3')), '>', 0::bigint, 'notifications: the victim row exists');
select cmp_ok((select count(*) from public.post_training_partners where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'post_training_partners: the victim row exists');
select cmp_ok((select count(*) from public.private_records where user_id = tests.uid('m3')), '>', 0::bigint, 'private_records: the victim row exists');
select cmp_ok((select count(*) from public.profiles where id = tests.uid('m3')), '>', 0::bigint, 'profiles: the victim row exists');
select cmp_ok((select count(*) from public.push_subscriptions where user_id = tests.uid('m3')), '>', 0::bigint, 'push_subscriptions: the victim row exists');
select cmp_ok((select count(*) from public.rate_limits where user_id = tests.uid('m3')), '>', 0::bigint, 'rate_limits: the victim row exists');
select cmp_ok((select count(*) from public.reactions where post_id = 'b1000000-0000-4000-8000-000000000001'), '>', 0::bigint, 'reactions: the victim row exists');
select cmp_ok((select count(*) from public.request_idempotency where user_id = tests.uid('m3')), '>', 0::bigint, 'request_idempotency: the victim row exists');
select cmp_ok((select count(*) from public.workout_posts where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'workout_posts: the victim row exists');

-- Positive controls for the attacker's own circle.
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('workout_posts', 'club_id = ''a0000000-0000-4000-8000-00000000000a'''), 1::bigint, 'control: m1 reads circle A''s post');
select is(tests.leak_count('clubs', 'id = ''a0000000-0000-4000-8000-00000000000a'''), 1::bigint, 'control: m1 reads circle A');
select is(tests.leak_count('circle_members', 'club_id = ''a0000000-0000-4000-8000-00000000000a'''), 2::bigint, 'control: m1 reads circle A''s roster');
select is(tests.leak_count('profiles', 'id = tests.uid(''m2'')'), 1::bigint, 'control: m1 reads a circle-mate''s profile');
select is(tests.leak_dml('insert into public.circle_members (club_id, user_id) values (''a0000000-0000-4000-8000-00000000000a'', tests.uid(''m3''))'), 0, 'control: a member cannot add people to their own circle either (RPC only)');
-- ---------------------------------------------------------------------
-- The attacker: m1, a member of circle A only.
-- ---------------------------------------------------------------------

-- account_deletion_requests
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('account_deletion_requests', 'user_id = tests.uid(''m3'')'), 0::bigint, 'account_deletion_requests: select sees zero rows of circle B');
select is(tests.leak_dml('update public.account_deletion_requests set purge_after = purge_after where user_id = tests.uid(''m3'')'), 0, 'account_deletion_requests: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.account_deletion_requests where user_id = tests.uid(''m3'')'), 0, 'account_deletion_requests: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.account_deletion_requests (user_id, purge_after) values (tests.uid(''m3''), now())'), 0, 'account_deletion_requests: insert into circle B is refused');

-- achievement_definitions: a global catalogue with no circle data: readable by design, so only writes are asserted
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_dml('update public.achievement_definitions set name = ''hacked'' where code = ''leak_probe'''), 0, 'achievement_definitions: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.achievement_definitions where code = ''leak_probe'''), 0, 'achievement_definitions: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.achievement_definitions (code, name, description, category, trigger_type) values (''leak_probe_2'', ''Probe'', ''d'', ''consistency'', ''WORKOUT_COMPLETED'')'), 0, 'achievement_definitions: insert into circle B is refused');

-- analytics_events
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('analytics_events', 'event_name = ''leak_probe'''), 0::bigint, 'analytics_events: select sees zero rows of circle B');
select is(tests.leak_dml('update public.analytics_events set props = props where event_name = ''leak_probe'''), 0, 'analytics_events: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.analytics_events where event_name = ''leak_probe'''), 0, 'analytics_events: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.analytics_events (user_id, event_name) values (tests.uid(''m3''), ''leak_probe_2'')'), 0, 'analytics_events: insert into circle B is refused');

-- blocks
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('blocks', 'blocker_id = tests.uid(''m3'')'), 0::bigint, 'blocks: select sees zero rows of circle B');
select is(tests.leak_dml('update public.blocks set created_at = created_at where blocker_id = tests.uid(''m3'')'), 0, 'blocks: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.blocks where blocker_id = tests.uid(''m3'')'), 0, 'blocks: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.blocks (blocker_id, blocked_id) values (tests.uid(''m3''), tests.uid(''m1''))'), 0, 'blocks: insert into circle B is refused');

-- bug_reports
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('bug_reports', 'reporter_id = tests.uid(''m3'')'), 0::bigint, 'bug_reports: select sees zero rows of circle B');
select is(tests.leak_dml('update public.bug_reports set body = body where reporter_id = tests.uid(''m3'')'), 0, 'bug_reports: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.bug_reports where reporter_id = tests.uid(''m3'')'), 0, 'bug_reports: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.bug_reports (reporter_id, body) values (tests.uid(''m3''), ''probe 2'')'), 0, 'bug_reports: insert into circle B is refused');

-- circle_invites
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('circle_invites', 'club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'circle_invites: select sees zero rows of circle B');
select is(tests.leak_dml('update public.circle_invites set uses = uses where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'circle_invites: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.circle_invites where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'circle_invites: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.circle_invites (club_id, token_hash, expires_at) values (''b0000000-0000-4000-8000-00000000000b'', repeat(''c'', 64), now() + interval ''7 days'')'), 0, 'circle_invites: insert into circle B is refused');

-- circle_members
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('circle_members', 'club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'circle_members: select sees zero rows of circle B');
select is(tests.leak_dml('update public.circle_members set role = role where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'circle_members: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.circle_members where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'circle_members: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.circle_members (club_id, user_id) values (''b0000000-0000-4000-8000-00000000000b'', tests.uid(''m1''))'), 0, 'circle_members: insert into circle B is refused');

-- clubs
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('clubs', 'id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'clubs: select sees zero rows of circle B');
select is(tests.leak_dml('update public.clubs set name = name where id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'clubs: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.clubs where id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'clubs: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.clubs (id, name, type) values (gen_random_uuid(), ''x'', ''friends'')'), 0, 'clubs: insert into circle B is refused');

-- edge_function_invocations
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('edge_function_invocations', 'slug = ''leak_probe'''), 0::bigint, 'edge_function_invocations: select sees zero rows of circle B');
select is(tests.leak_dml('update public.edge_function_invocations set slug = slug where slug = ''leak_probe'''), 0, 'edge_function_invocations: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.edge_function_invocations where slug = ''leak_probe'''), 0, 'edge_function_invocations: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.edge_function_invocations (request_id, slug) values (987654322, ''leak_probe'')'), 0, 'edge_function_invocations: insert into circle B is refused');

-- invite_attempts
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('invite_attempts', 'user_id = tests.uid(''m3'')'), 0::bigint, 'invite_attempts: select sees zero rows of circle B');
select is(tests.leak_dml('update public.invite_attempts set attempt_count = attempt_count where user_id = tests.uid(''m3'')'), 0, 'invite_attempts: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.invite_attempts where user_id = tests.uid(''m3'')'), 0, 'invite_attempts: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.invite_attempts (user_id, actor_key_hash) values (tests.uid(''m3''), repeat(''e'', 64))'), 0, 'invite_attempts: insert into circle B is refused');

-- invite_codes
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('invite_codes', 'code_hash = repeat(''b'', 64)'), 0::bigint, 'invite_codes: select sees zero rows of circle B');
select is(tests.leak_dml('update public.invite_codes set active = active where code_hash = repeat(''b'', 64)'), 0, 'invite_codes: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.invite_codes where code_hash = repeat(''b'', 64)'), 0, 'invite_codes: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.invite_codes (code_hash, role, active, max_uses) values (repeat(''c'', 64), ''member'', true, 5)'), 0, 'invite_codes: insert into circle B is refused');

-- invite_redemptions
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('invite_redemptions', 'user_id = tests.uid(''m3'')'), 0::bigint, 'invite_redemptions: select sees zero rows of circle B');
select is(tests.leak_dml('update public.invite_redemptions set role = role where user_id = tests.uid(''m3'')'), 0, 'invite_redemptions: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.invite_redemptions where user_id = tests.uid(''m3'')'), 0, 'invite_redemptions: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.invite_redemptions (user_id, invite_id, role) values (tests.uid(''m3''), ''11111111-2222-4333-8444-555555555555'', ''member'')'), 0, 'invite_redemptions: insert into circle B is refused');

-- invites
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('invites', 'club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'invites: select sees zero rows of circle B');
select is(tests.leak_dml('update public.invites set label = label where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'invites: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.invites where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'invites: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.invites (club_id, code_hash, role) values (''b0000000-0000-4000-8000-00000000000b'', repeat(''9'', 64), ''member'')'), 0, 'invites: insert into circle B is refused');

-- job_health_state
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('job_health_state', 'true'), 0::bigint, 'job_health_state: select sees zero rows of circle B');
select is(tests.leak_dml('update public.job_health_state set ok = ok'), 0, 'job_health_state: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.job_health_state where true'), 0, 'job_health_state: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.job_health_state (id) values (false)'), 0, 'job_health_state: insert into circle B is refused');

-- member_achievements
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('member_achievements', 'user_id = tests.uid(''m3'')'), 0::bigint, 'member_achievements: select sees zero rows of circle B');
select is(tests.leak_dml('update public.member_achievements set visibility = visibility where user_id = tests.uid(''m3'')'), 0, 'member_achievements: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.member_achievements where user_id = tests.uid(''m3'')'), 0, 'member_achievements: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.member_achievements (user_id, achievement_id) select tests.uid(''m1''), id from public.achievement_definitions where code = ''leak_probe'''), 0, 'member_achievements: insert into circle B is refused');

-- member_targets
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('member_targets', 'user_id = tests.uid(''m3'')'), 0::bigint, 'member_targets: select sees zero rows of circle B');
select is(tests.leak_dml('update public.member_targets set weekly_target = 1 where user_id = tests.uid(''m3'')'), 0, 'member_targets: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.member_targets where user_id = tests.uid(''m3'')'), 0, 'member_targets: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.member_targets (user_id, weekly_target) values (tests.uid(''m3''), 2)'), 0, 'member_targets: insert into circle B is refused');

-- notification_batches
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('notification_batches', 'user_id = tests.uid(''m3'')'), 0::bigint, 'notification_batches: select sees zero rows of circle B');
select is(tests.leak_dml('update public.notification_batches set pending_count = pending_count where user_id = tests.uid(''m3'')'), 0, 'notification_batches: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.notification_batches where user_id = tests.uid(''m3'')'), 0, 'notification_batches: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.notification_batches (user_id, category, pending_count, pending, window_started_at, next_flush_at) values (tests.uid(''m3''), ''training'', 0, ''[]''::jsonb, now(), now())'), 0, 'notification_batches: insert into circle B is refused');

-- notification_preferences
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('notification_preferences', 'user_id = tests.uid(''m3'')'), 0::bigint, 'notification_preferences: select sees zero rows of circle B');
select is(tests.leak_dml('update public.notification_preferences set channel = channel where user_id = tests.uid(''m3'')'), 0, 'notification_preferences: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.notification_preferences where user_id = tests.uid(''m3'')'), 0, 'notification_preferences: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.notification_preferences (user_id, type, channel) values (tests.uid(''m3''), ''weekly_card'', ''off'')'), 0, 'notification_preferences: insert into circle B is refused');

-- notifications
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('notifications', 'user_id = tests.uid(''m3'')'), 0::bigint, 'notifications: select sees zero rows of circle B');
select is(tests.leak_dml('update public.notifications set read_at = now() where user_id = tests.uid(''m3'')'), 0, 'notifications: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.notifications where user_id = tests.uid(''m3'')'), 0, 'notifications: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.notifications (user_id, type, category, title, body) values (tests.uid(''m3''), ''leak_probe_2'', ''community'', ''t'', ''b'')'), 0, 'notifications: insert into circle B is refused');

-- post_training_partners
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('post_training_partners', 'club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'post_training_partners: select sees zero rows of circle B');
select is(tests.leak_dml('update public.post_training_partners set created_at = created_at where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'post_training_partners: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.post_training_partners where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'post_training_partners: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.post_training_partners (post_id, tagged_user_id, tagged_by) values (''b1000000-0000-4000-8000-000000000001'', tests.uid(''owner''), tests.uid(''m1''))'), 0, 'post_training_partners: insert into circle B is refused');

-- private_records
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('private_records', 'user_id = tests.uid(''m3'')'), 0::bigint, 'private_records: select sees zero rows of circle B');
select is(tests.leak_dml('update public.private_records set payload = payload where user_id = tests.uid(''m3'')'), 0, 'private_records: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.private_records where user_id = tests.uid(''m3'')'), 0, 'private_records: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.private_records (user_id, record_type, record_id, payload) values (tests.uid(''m3''), ''session_note'', ''leak-probe-2'', ''{}''::jsonb)'), 0, 'private_records: insert into circle B is refused');

-- profiles
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('profiles', 'id = tests.uid(''m3'')'), 0::bigint, 'profiles: select sees zero rows of circle B');
select is(tests.leak_dml('update public.profiles set display_name = display_name where id = tests.uid(''m3'')'), 0, 'profiles: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.profiles where id = tests.uid(''m3'')'), 0, 'profiles: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.profiles (id, handle, display_name) values (tests.uid(''m3''), ''dup_member_c'', ''Dup'')'), 0, 'profiles: insert into circle B is refused');

-- push_subscriptions
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('push_subscriptions', 'user_id = tests.uid(''m3'')'), 0::bigint, 'push_subscriptions: select sees zero rows of circle B');
select is(tests.leak_dml('update public.push_subscriptions set endpoint = endpoint where user_id = tests.uid(''m3'')'), 0, 'push_subscriptions: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.push_subscriptions where user_id = tests.uid(''m3'')'), 0, 'push_subscriptions: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.push_subscriptions (user_id, endpoint, keys) values (tests.uid(''m3''), ''https://example.test/leak2'', ''{"p256dh":"k","auth":"a"}''::jsonb)'), 0, 'push_subscriptions: insert into circle B is refused');

-- rate_limits
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('rate_limits', 'user_id = tests.uid(''m3'')'), 0::bigint, 'rate_limits: select sees zero rows of circle B');
select is(tests.leak_dml('update public.rate_limits set attempt_count = attempt_count where user_id = tests.uid(''m3'')'), 0, 'rate_limits: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.rate_limits where user_id = tests.uid(''m3'')'), 0, 'rate_limits: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.rate_limits (user_id, action) values (tests.uid(''m3''), ''leak_probe_2'')'), 0, 'rate_limits: insert into circle B is refused');

-- reactions
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('reactions', 'post_id = ''b1000000-0000-4000-8000-000000000001'''), 0::bigint, 'reactions: select sees zero rows of circle B');
select is(tests.leak_dml('update public.reactions set kind = kind where post_id = ''b1000000-0000-4000-8000-000000000001'''), 0, 'reactions: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.reactions where post_id = ''b1000000-0000-4000-8000-000000000001'''), 0, 'reactions: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.reactions (post_id, user_id, kind) values (''b1000000-0000-4000-8000-000000000001'', tests.uid(''m1''), ''cheer'')'), 0, 'reactions: insert into circle B is refused');

-- request_idempotency
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('request_idempotency', 'user_id = tests.uid(''m3'')'), 0::bigint, 'request_idempotency: select sees zero rows of circle B');
select is(tests.leak_dml('update public.request_idempotency set action = action where user_id = tests.uid(''m3'')'), 0, 'request_idempotency: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.request_idempotency where user_id = tests.uid(''m3'')'), 0, 'request_idempotency: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.request_idempotency (user_id, action, idempotency_key) values (tests.uid(''m3''), ''leak_probe_2'', gen_random_uuid())'), 0, 'request_idempotency: insert into circle B is refused');

-- workout_posts
select tests.set_auth(tests.uid('m1'));
select is(tests.leak_count('workout_posts', 'club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0::bigint, 'workout_posts: select sees zero rows of circle B');
select is(tests.leak_dml('update public.workout_posts set body = ''hacked'' where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'workout_posts: update touches zero rows of circle B');
select is(tests.leak_dml('delete from public.workout_posts where club_id = ''b0000000-0000-4000-8000-00000000000b'''), 0, 'workout_posts: delete removes zero rows of circle B');
select is(tests.leak_dml('insert into public.workout_posts (author_id, club_id, post_type, title, status, published_at) values (tests.uid(''m1''), ''b0000000-0000-4000-8000-00000000000b'', ''POST_TEXT'', ''x'', ''active'', now())'), 0, 'workout_posts: insert into circle B is refused');

-- The victims are still there, unchanged in count.
select tests.clear_auth();
select cmp_ok((select count(*) from public.account_deletion_requests where user_id = tests.uid('m3')), '>', 0::bigint, 'account_deletion_requests: the victim rows survived');
select cmp_ok((select count(*) from public.achievement_definitions where code = 'leak_probe'), '>', 0::bigint, 'achievement_definitions: the victim rows survived');
select cmp_ok((select count(*) from public.analytics_events where event_name = 'leak_probe'), '>', 0::bigint, 'analytics_events: the victim rows survived');
select cmp_ok((select count(*) from public.blocks where blocker_id = tests.uid('m3')), '>', 0::bigint, 'blocks: the victim rows survived');
select cmp_ok((select count(*) from public.bug_reports where reporter_id = tests.uid('m3')), '>', 0::bigint, 'bug_reports: the victim rows survived');
select cmp_ok((select count(*) from public.circle_invites where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'circle_invites: the victim rows survived');
select cmp_ok((select count(*) from public.circle_members where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'circle_members: the victim rows survived');
select cmp_ok((select count(*) from public.clubs where id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'clubs: the victim rows survived');
select cmp_ok((select count(*) from public.edge_function_invocations where slug = 'leak_probe'), '>', 0::bigint, 'edge_function_invocations: the victim rows survived');
select cmp_ok((select count(*) from public.invite_attempts where user_id = tests.uid('m3')), '>', 0::bigint, 'invite_attempts: the victim rows survived');
select cmp_ok((select count(*) from public.invite_codes where code_hash = repeat('b', 64)), '>', 0::bigint, 'invite_codes: the victim rows survived');
select cmp_ok((select count(*) from public.invite_redemptions where user_id = tests.uid('m3')), '>', 0::bigint, 'invite_redemptions: the victim rows survived');
select cmp_ok((select count(*) from public.invites where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'invites: the victim rows survived');
select cmp_ok((select count(*) from public.job_health_state where true), '>', 0::bigint, 'job_health_state: the victim rows survived');
select cmp_ok((select count(*) from public.member_achievements where user_id = tests.uid('m3')), '>', 0::bigint, 'member_achievements: the victim rows survived');
select cmp_ok((select count(*) from public.member_targets where user_id = tests.uid('m3')), '>', 0::bigint, 'member_targets: the victim rows survived');
select cmp_ok((select count(*) from public.notification_batches where user_id = tests.uid('m3')), '>', 0::bigint, 'notification_batches: the victim rows survived');
select cmp_ok((select count(*) from public.notification_preferences where user_id = tests.uid('m3')), '>', 0::bigint, 'notification_preferences: the victim rows survived');
select cmp_ok((select count(*) from public.notifications where user_id = tests.uid('m3')), '>', 0::bigint, 'notifications: the victim rows survived');
select cmp_ok((select count(*) from public.post_training_partners where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'post_training_partners: the victim rows survived');
select cmp_ok((select count(*) from public.private_records where user_id = tests.uid('m3')), '>', 0::bigint, 'private_records: the victim rows survived');
select cmp_ok((select count(*) from public.profiles where id = tests.uid('m3')), '>', 0::bigint, 'profiles: the victim rows survived');
select cmp_ok((select count(*) from public.push_subscriptions where user_id = tests.uid('m3')), '>', 0::bigint, 'push_subscriptions: the victim rows survived');
select cmp_ok((select count(*) from public.rate_limits where user_id = tests.uid('m3')), '>', 0::bigint, 'rate_limits: the victim rows survived');
select cmp_ok((select count(*) from public.reactions where post_id = 'b1000000-0000-4000-8000-000000000001'), '>', 0::bigint, 'reactions: the victim rows survived');
select cmp_ok((select count(*) from public.request_idempotency where user_id = tests.uid('m3')), '>', 0::bigint, 'request_idempotency: the victim rows survived');
select cmp_ok((select count(*) from public.workout_posts where club_id = 'b0000000-0000-4000-8000-00000000000b'), '>', 0::bigint, 'workout_posts: the victim rows survived');

-- Every table in public is covered above.
select is_empty(
  $$ select c.relname::text from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
        and c.relname not in ('account_deletion_requests', 'achievement_definitions', 'analytics_events', 'blocks', 'bug_reports', 'circle_invites', 'circle_members', 'clubs', 'edge_function_invocations', 'invite_attempts', 'invite_codes', 'invite_redemptions', 'invites', 'job_health_state', 'member_achievements', 'member_targets', 'notification_batches', 'notification_preferences', 'notifications', 'post_training_partners', 'private_records', 'profiles', 'push_subscriptions', 'rate_limits', 'reactions', 'request_idempotency', 'workout_posts') $$,
  'this file covers every table in public: a new table must be added here');

select * from finish();
rollback;
