-- Haimunia club (202611110001): the club type, coach role, fixed link, announcements, the notification rule,
-- push routing by app, bug_reports.app, the transfer blob store and usage counting.
-- docs/club/research.md section C, tests 1-10.
--
--   Friends circle F: m1 (owner), m2, coach (a plain member here)
--   Club K:           owner (owner), coach (coach), m3, norec          m1 is NOT in K

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

create function tests.kid() returns uuid language sql stable security definer set search_path = '' as
  $$ select c.id from public.clubs c where c.type = 'club' $$;
grant execute on function tests.kid() to authenticated, anon, service_role;
create function tests.fid() returns uuid language sql immutable as $$ select 'f0000000-0000-4000-8000-00000000000f'::uuid $$;
grant execute on function tests.fid() to authenticated, anon, service_role;
create function tests.role_in(p_club uuid, p_user uuid) returns text language sql stable security definer set search_path = '' as
  $$ select m.role from public.circle_members m where m.club_id = p_club and m.user_id = p_user $$;
grant execute on function tests.role_in(uuid, uuid) to authenticated;

insert into public.clubs (id, name, type, created_by) values (tests.fid(), 'Friends F', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values
  (tests.fid(), tests.uid('m1'), 'owner'), (tests.fid(), tests.uid('m2'), 'member'), (tests.fid(), tests.uid('coach'), 'member');

-- =====================================================================================================
-- 1. Types, caps, defaults: explicit, and an unknown type raises
-- =====================================================================================================
select is(public.circle_member_cap('couple'), 2, 'cap: couple 2');
select is(public.circle_member_cap('friends'), 20, 'cap: friends 20');
select is(public.circle_member_cap('club'), 250, 'cap: club 250');
select throws_ok($$ select public.circle_member_cap('gym') $$, 'P0001', 'unknown circle type gym', 'cap: an unknown type raises, it never falls through to 20');
select is(public.circle_share_defaults('club'),
  '{"share_workouts": true, "share_prs": true, "share_percent": true, "share_weekly_count": true, "show_weights": false}'::jsonb,
  'club defaults: every workout posted, PRs and percent, absolute weights off (owner decision 4)');
select is(public.circle_share_defaults('friends') ->> 'share_workouts', 'false', 'friends defaults unchanged');
select throws_ok($$ select public.circle_share_defaults('gym') $$, 'P0001', 'unknown circle type gym', 'defaults: an unknown type raises');
select throws_ok($$ insert into public.clubs (name, type) values ('x', 'gym') $$, '23514', null, 'clubs.type refuses an unknown type');

-- =====================================================================================================
-- 2. Owner functions: granted to no role
-- =====================================================================================================
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.owner_create_club('owner', 'Haimunia') $$, '42501', null, 'owner_create_club: an authenticated caller cannot execute it');
select throws_ok($$ select public.owner_set_coach('coach') $$, '42501', null, 'owner_set_coach: an authenticated caller cannot execute it');
select throws_ok($$ select public.owner_set_club_owner('coach') $$, '42501', null, 'owner_set_club_owner: an authenticated caller cannot execute it');
select throws_ok($$ select public.training_log_usage_report(4) $$, '42501', null, 'training_log_usage_report: an authenticated caller cannot execute it');
select tests.clear_auth();
select is(public.owner_set_coach('coach'), 'no_club', 'owner_set_coach before the club exists: no_club');
select is(public.owner_create_club('nobody_here', 'Haimunia'), 'no_such_user', 'owner_create_club: an unknown username is refused');
select is(public.owner_create_club('Owner ', 'האימוניה'), 'created', 'owner_create_club: the club is created (username trimmed and lower-cased)');
select is(public.owner_create_club('owner', 'Second'), 'exists', 'a second club is refused');
select throws_ok($$ insert into public.clubs (name, type) values ('Another', 'club') $$, '23505', null, 'and the unique index refuses a second club row directly');
select is(tests.role_in(tests.kid(), tests.uid('owner')), 'owner', 'the owner is the club''s first member, as owner');
select is((select share_defaults from public.circle_members where club_id = tests.kid() and user_id = tests.uid('owner')),
  public.circle_share_defaults('club'), 'with the club''s share defaults');

insert into public.circle_members (club_id, user_id, role) values
  (tests.kid(), tests.uid('coach'), 'member'), (tests.kid(), tests.uid('m3'), 'member'), (tests.kid(), tests.uid('norec'), 'member');
select is(public.owner_set_coach('m1'), 'not_member', 'owner_set_coach: someone outside the club is refused');
select is(public.owner_set_coach('owner'), 'is_owner', 'owner_set_coach: the owner cannot also be the coach');
select is(public.owner_set_coach('sha256:' || encode(extensions.digest('coach', 'sha256'), 'hex')), 'set',
  'owner_set_coach by sha256 of the username (what club-admin.yml sends)');
select is(tests.role_in(tests.kid(), tests.uid('coach')), 'coach', 'the coach is set');
select is(public.owner_set_coach('coach'), 'already', 'owner_set_coach is idempotent');

-- =====================================================================================================
-- 3. Roles: coach only in a club, one coach, one owner
-- =====================================================================================================
select throws_ok($$ update public.circle_members set role = 'coach' where club_id = tests.fid() and user_id = tests.uid('m2') $$,
  'P0001', 'only a club has a coach', 'a friends circle has no coach (update)');
select throws_ok($$ insert into public.circle_members (club_id, user_id, role) values (tests.fid(), tests.uid('m3'), 'coach') $$,
  'P0001', 'only a club has a coach', 'a friends circle has no coach (insert)');
select throws_ok($$ update public.circle_members set role = 'coach' where club_id = tests.kid() and user_id = tests.uid('m3') $$,
  '23505', null, 'a club has one coach');
select throws_ok($$ update public.circle_members set role = 'owner' where club_id = tests.kid() and user_id = tests.uid('m3') $$,
  'P0001', 'a club has one owner', 'a club has one owner');

-- =====================================================================================================
-- 4. The fixed, rotatable join link
-- =====================================================================================================
select tests.set_auth(tests.uid('m3'));
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'not authorized', 'a plain member cannot rotate the link');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.rotate_club_link(tests.fid()) $$, 'P0001', 'not authorized', 'the owner of a friends circle cannot use rotate_club_link on it');
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'not authorized', 'nor on a club they are not in');
select tests.set_auth(tests.uid('owner'));
select throws_ok($$ select public.create_circle_invite(tests.kid()) $$, 'P0001', 'use rotate_club_link', 'a club has no per-person invites');
select tests.set_auth(tests.uid('coach'));
select public.rotate_club_link(tests.kid()) as tok1 \gset
select ok(:'tok1' ~ '^[0-9a-f]{64}$', 'the coach rotates the link: 32 random bytes as hex, returned once');
select tests.clear_auth();
select is((select count(*)::int from public.circle_invites where club_id = tests.kid()), 1, 'one link row per club');
select is((select expires_at from public.circle_invites where club_id = tests.kid()), 'infinity'::timestamptz, 'the link does not expire');
select ok(not exists (select 1 from public.circle_invites where token_hash = :'tok1'), 'only the hash is stored');
select tests.set_auth(tests.uid('m2'));
select is(public.join_circle(:'tok1') ->> 'status', 'joined', 'm2 joins the club with the link');
select is((select share_defaults from public.circle_members where club_id = tests.kid() and user_id = tests.uid('m2')),
  public.circle_share_defaults('club'), 'a joiner gets the club''s share defaults');
select tests.set_auth(tests.uid('owner'));
select public.rotate_club_link(tests.kid()) as tok2 \gset
select tests.set_auth(tests.uid('admin'));
select is(public.join_circle(:'tok1') ->> 'status', 'invalid', 'after a rotation the old link is invalid');
select is(public.join_circle(:'tok2') ->> 'status', 'joined', 'and the new one works');
select tests.set_auth(tests.uid('coach'));
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'rotation 2 of 5 today');
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'rotation 3 of 5 today');
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'rotation 4 of 5 today');
select lives_ok($$ select public.rotate_club_link(tests.kid()) $$, 'rotation 5 of 5 today');
select throws_ok($$ select public.rotate_club_link(tests.kid()) $$, 'P0001', 'rate_limited', 'a sixth rotation in a day is refused');

-- =====================================================================================================
-- 5. Coach rights: remove, delete posts, announcements; only in their own club
-- =====================================================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d5000000-0000-4000-8000-000000000001', tests.uid('m3'), tests.kid(), 'POST_WORKOUT', 'K m3 workout', 'active', now(), current_date),
  ('d5000000-0000-4000-8000-000000000002', tests.uid('m2'), tests.fid(), 'POST_WORKOUT', 'F m2 workout', 'active', now(), current_date),
  ('d5000000-0000-4000-8000-000000000003', tests.uid('norec'), tests.kid(), 'POST_WORKOUT', 'K norec workout', 'active', now(), current_date);

select tests.set_auth(tests.uid('coach'));
select ok(public.is_club_staff(tests.kid()), 'the coach is club staff');
select ok(not public.is_club_staff(tests.fid()), 'but not in the friends circle they are a member of');
select lives_ok($$ select public.post_delete('d5000000-0000-4000-8000-000000000001') $$, 'the coach deletes a member''s post in the club');
select throws_ok($$ select public.post_delete('d5000000-0000-4000-8000-000000000002') $$, 'P0001', 'not authorized', 'the coach cannot delete a post in a friends circle they are in');
select tests.set_auth(tests.uid('m1'));
select ok(not public.is_club_staff(tests.fid()), 'the owner of a friends circle is not club staff');
select throws_ok($$ select public.post_delete('d5000000-0000-4000-8000-000000000002') $$, 'P0001', 'not authorized', 'a friends circle has no moderation: its owner cannot delete a member''s post');
select tests.set_auth(tests.uid('m3'));
select throws_ok($$ select public.post_delete('d5000000-0000-4000-8000-000000000003') $$, 'P0001', 'not authorized', 'a club member cannot delete another member''s post');
select tests.clear_auth();
select is((select status from public.workout_posts where id = 'd5000000-0000-4000-8000-000000000001'), 'removed', 'the coach''s delete is a soft delete');

select tests.set_auth(tests.uid('coach'));
select throws_ok(format('select public.remove_member(%L, %L)', tests.kid(), tests.uid('owner')), 'P0001', 'an owner cannot be removed', 'the coach cannot remove the owner');
select throws_ok(format('select public.remove_member(%L, %L)', tests.fid(), tests.uid('m2')), 'P0001', 'not authorized', 'the coach cannot remove anyone from a friends circle');
select lives_ok(format('select public.remove_member(%L, %L)', tests.kid(), tests.uid('admin')), 'the coach removes a club member');
select is(tests.role_in(tests.kid(), tests.uid('admin')), null, 'who is then out');
select tests.set_auth(tests.uid('m3'));
select throws_ok(format('select public.remove_member(%L, %L)', tests.kid(), tests.uid('norec')), 'P0001', 'not authorized', 'a member cannot remove a member');

-- Announcements
select tests.set_auth(tests.uid('m3'));
select throws_ok(format('select public.club_announcement_post(%L, %L)', tests.kid(), 'hi'), 'P0001', 'not authorized', 'a member cannot announce');
select tests.set_auth(tests.uid('m1'));
select throws_ok(format('select public.club_announcement_post(%L, %L)', tests.fid(), 'hi'), 'P0001', 'not authorized', 'announcements exist only in a club');
select tests.set_auth(tests.uid('coach'));
select public.club_announcement_post(tests.kid(), 'אימון מיוחד ביום שישי', true) as ann1 \gset
select public.club_announcement_post(tests.kid(), 'second', true) as ann2 \gset
select tests.clear_auth();
select is((select count(*)::int from public.club_announcements where club_id = tests.kid() and pinned), 1, 'at most one pinned announcement: pinning the second unpinned the first');
select is((select count(*)::int from public.notifications where circle_id = tests.kid()), 0, 'an announcement is never a notification');
select tests.set_auth(tests.uid('m3'));
select is((select count(*)::int from public.club_announcements), 2, 'a club member reads the announcements');
select throws_ok(format('select public.club_announcement_delete(%L)', :'ann1'), 'P0001', 'not authorized', 'a member cannot delete one');
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.club_announcements), 0, 'someone outside the club reads none');
select tests.set_auth(tests.uid('owner'));
select lives_ok(format('select public.club_announcement_set_pinned(%L, true)', :'ann1'), 'the owner re-pins the first');
select lives_ok(format('select public.club_announcement_delete(%L)', :'ann2'), 'the owner deletes the second');
select tests.clear_auth();
select is((select pinned from public.club_announcements where id = :'ann1'), true, 'the first is pinned again');

-- =====================================================================================================
-- 6. Cross-type leaks: club members see nothing of F, F members see nothing of the club
-- =====================================================================================================
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.clubs where id = tests.kid()), 0, 'a friends member does not see the club row');
select is((select count(*)::int from public.circle_members where club_id = tests.kid()), 0, 'nor its members');
select is((select count(*)::int from public.workout_posts where club_id = tests.kid()), 0, 'nor its posts');
select throws_ok($$ select count(*) from public.circle_invites $$, '42501', null, 'nor any link: circle_invites has no client grant');
select tests.set_auth(tests.uid('m3'));
select is((select count(*)::int from public.clubs where id = tests.fid()), 0, 'a club member does not see the friends circle');
select is((select count(*)::int from public.circle_members where club_id = tests.fid()), 0, 'nor its members');
select is((select count(*)::int from public.workout_posts where club_id = tests.fid()), 0, 'nor its posts');
select is((select count(*)::int from public.workout_posts where club_id = tests.kid()), 1, 'but does see the club''s live post');
select tests.set_auth(tests.uid('coach'));

-- =====================================================================================================
-- 7. Notifications: no fan-out in a club
-- =====================================================================================================
select tests.clear_auth();
insert into public.notification_preferences (user_id, type, channel) values
  (tests.uid('owner'), 'pr_circle', 'push'), (tests.uid('m3'), 'pr_circle', 'push'), (tests.uid('norec'), 'pr_circle', 'push'),
  (tests.uid('m1'), 'pr_circle', 'push'), (tests.uid('coach'), 'pr_circle', 'push'),
  (tests.uid('owner'), 'circle_joined', 'push'), (tests.uid('m1'), 'circle_joined', 'push'),
  (tests.uid('m3'), 'week_card', 'push'), (tests.uid('m2'), 'week_card', 'push'),
  (tests.uid('m3'), 'trained_together', 'push');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('d7000000-0000-4000-8000-000000000001', tests.uid('m2'), tests.kid(), 'POST_PR', 'K PR', 'active', now());
select is((select count(*)::int from public.notifications where type = 'pr_circle' and circle_id = tests.kid()), 0,
  'a PR in the club writes no pr_circle row, though members turned the type on');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('d7000000-0000-4000-8000-000000000002', tests.uid('m2'), tests.fid(), 'POST_PR', 'F PR', 'active', now());
select ok((select count(*) from public.notifications where type = 'pr_circle' and circle_id = tests.fid()) > 0,
  'control: a PR in a friends circle still notifies');

insert into public.circle_members (club_id, user_id, role) values (tests.kid(), tests.uid('m1'), 'member');
select is((select count(*)::int from public.notifications where type = 'circle_joined' and circle_id = tests.kid()), 0,
  'a join to the club does not notify the owner');
delete from public.circle_members where club_id = tests.kid() and user_id = tests.uid('m1');
insert into public.circle_members (club_id, user_id, role) values (tests.fid(), tests.uid('m3'), 'member');
select is((select count(*)::int from public.notifications where type = 'circle_joined' and circle_id = tests.fid()), 1,
  'control: a join to a friends circle notifies its owner');
delete from public.circle_members where club_id = tests.fid() and user_id = tests.uid('m3');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at, occurred_on) values
  ('d7000000-0000-4000-8000-000000000003', tests.uid('norec'), tests.kid(), 'POST_WORKOUT', 'K week', 'active', '2026-10-27T08:00:00Z', '2026-10-27'),
  ('d7000000-0000-4000-8000-000000000004', tests.uid('coach'), tests.fid(), 'POST_WORKOUT', 'F week', 'active', '2026-10-27T08:00:00Z', '2026-10-27');
select lives_ok($$ select public.notif_week_card_due('2026-10-31T19:30:00Z') $$, 'the week card job runs Saturday night');
select is((select count(*)::int from public.notifications where type = 'week_card' and circle_id = tests.kid()), 0, 'a club has no week card');
select is((select count(*)::int from public.notifications where type = 'week_card' and circle_id = tests.fid()), 1, 'control: the friends circle''s card is ready for m2');

insert into public.reactions (post_id, user_id, kind) values ('d7000000-0000-4000-8000-000000000003', tests.uid('m3'), 'fire');
select is((select count(*)::int from public.notifications where type = 'reaction' and circle_id = tests.kid() and user_id = tests.uid('norec')), 1,
  'a reaction on your club post notifies you');
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by) values ('d7000000-0000-4000-8000-000000000003', tests.uid('m3'), tests.uid('norec'));
select is((select count(*)::int from public.notifications where type = 'trained_together' and circle_id = tests.kid() and user_id = tests.uid('m3')), 1,
  'and a trained-together tag asks for your confirmation');

-- =====================================================================================================
-- 8. Push goes to the app that shows the circle
-- =====================================================================================================
insert into public.push_subscriptions (id, user_id, endpoint, keys, app) values
  ('d8000000-0000-4000-8000-000000000001', tests.uid('norec'), 'https://push.example/norec-boxlog', '{"p256dh":"BPk","auth":"aGk"}', 'box-log'),
  ('d8000000-0000-4000-8000-000000000002', tests.uid('norec'), 'https://push.example/norec-club', '{"p256dh":"BPk","auth":"aGk"}', 'club'),
  ('d8000000-0000-4000-8000-000000000003', tests.uid('m2'), 'https://push.example/m2-boxlog', '{"p256dh":"BPk","auth":"aGk"}', 'box-log'),
  ('d8000000-0000-4000-8000-000000000004', tests.uid('m2'), 'https://push.example/m2-club', '{"p256dh":"BPk","auth":"aGk"}', 'club');
select throws_ok($$ insert into public.push_subscriptions (user_id, endpoint, app) values (tests.uid('m2'), 'https://push.example/x', 'other') $$,
  '23514', null, 'push_subscriptions.app is box-log or club');
select is((select default_value from (select column_default as default_value from information_schema.columns
            where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'app') x), '''box-log''::text',
  'an existing BOX-LOG client that sends no app registers as box-log');

create function tests.pushed_to(p_user uuid, p_type text) returns text language sql as $$
  select string_agg(s.app, ',' order by s.app) from public.notif_push_pending(1000) p
    join public.push_subscriptions s on s.id = p.subscription_id
    join public.notifications n on n.id = p.notification_id
   where n.user_id = p_user and n.type = p_type $$;
select is(tests.pushed_to(tests.uid('norec'), 'reaction'), 'club', 'a club reaction is pushed to the club app only');
insert into public.notifications (user_id, type, category, title, body, deep_link, circle_id, actor_id) values
  (tests.uid('m2'), 'reaction', 'community', 't', 'b', '/circles', tests.fid(), tests.uid('m1'));
select is(tests.pushed_to(tests.uid('m2'), 'reaction'), 'box-log', 'a friends-circle reaction is pushed to BOX-LOG only');
insert into public.notification_preferences (user_id, type, channel) values (tests.uid('m2'), 'workout_reminder', 'push');
insert into public.notifications (user_id, type, category, title, body, deep_link) values
  (tests.uid('m2'), 'workout_reminder', 'training', 't', 'b', '/tab/add');
select is(tests.pushed_to(tests.uid('m2'), 'workout_reminder'), 'box-log,club', 'a personal reminder goes to every device of the account');

-- The notification list and count per app
insert into public.notifications (user_id, type, category, title, body, deep_link, circle_id, actor_id) values
  (tests.uid('m2'), 'reaction', 'community', 't', 'b', '/circles', tests.kid(), tests.uid('m3'));
select tests.set_auth(tests.uid('m2'));
select is((select count(*)::int from public.notif_list(null, 40, null) where circle_id = tests.kid()), 0, 'BOX-LOG''s list (the default) leaves club rows out');
select ok((select count(*) from public.notif_list(null, 40, null) where circle_id = tests.fid()) > 0, 'and keeps its own circles');
select is((select count(*)::int from public.notif_list(null, 40, null, 'club') where circle_id = tests.fid()), 0, 'the club''s list leaves friends rows out');
select is((select count(*)::int from public.notif_list(null, 40, null, 'club') where circle_id = tests.kid()), 1, 'and shows the club''s');
select is((select count(*)::int from public.notif_list(null, 40, null, 'club') where circle_id is null), 1, 'a personal row shows in the club app');
select is((select count(*)::int from public.notif_list(null, 40, null) where circle_id is null), 1, 'and in BOX-LOG');
select is(public.notif_unread_count('club') + public.notif_unread_count(),
  (select count(*)::int from public.notifications where read_at is null) + 1, 'the two badge counts split the rows (the personal one counts in both)');
select throws_ok($$ select * from public.notif_list(null, 20, null, 'gym') $$, 'P0001', 'unknown app', 'an unknown app is refused');

-- =====================================================================================================
-- 9. bug_reports.app
-- =====================================================================================================
select tests.set_auth(tests.uid('m3'));
select public.bug_report_submit('club bug', '{"app": "club", "app_version": "1.0.0"}') as bug1 \gset
select public.bug_report_submit('boxlog bug', '{"app_version": "5.0.3"}') as bug2 \gset
select public.bug_report_submit('odd app', '{"app": "something"}') as bug3 \gset
select tests.clear_auth();
select is((select app from public.bug_reports where id = :'bug1'), 'club', 'a report from the club app is app = club');
select is((select app from public.bug_reports where id = :'bug2'), 'box-log', 'no app means box-log');
select is((select app from public.bug_reports where id = :'bug3'), 'box-log', 'an unknown app is stored as box-log');
select is((select diagnostics from public.bug_reports where id = :'bug1'), '{"app_version": "1.0.0"}'::jsonb, 'the app is a column, not kept in diagnostics');

-- =====================================================================================================
-- 10. Ownership passes to the coach, never to a random member; a club is never deleted automatically
-- =====================================================================================================
select tests.set_auth(tests.uid('owner'));
select lives_ok(format('select public.leave_circle(%L)', tests.kid()), 'the owner leaves the club');
select tests.clear_auth();
select is(tests.role_in(tests.kid(), tests.uid('coach')), 'owner', 'the coach becomes the owner');
select is((select count(*)::int from public.circle_members where club_id = tests.kid() and role = 'coach'), 0, 'and the coach seat is empty');
select tests.set_auth(tests.uid('coach'));
select lives_ok(format('select public.leave_circle(%L)', tests.kid()), 'the new owner leaves too, with no coach');
select tests.clear_auth();
select is((select count(*)::int from public.circle_members where club_id = tests.kid() and role = 'owner'), 0,
  'with no coach the club has no owner: nobody inherits it');
select ok(tests.kid() is not null, 'and the club still exists');
select is(public.owner_set_club_owner('nobody_here'), 'no_such_user', 'owner_set_club_owner: an unknown username');
select is(public.owner_set_club_owner('m1'), 'not_member', 'owner_set_club_owner: someone outside the club');
select is(public.owner_set_club_owner('m3'), 'set', 'owner_set_club_owner restores an owner (docs/ops/CLUB_OWNERSHIP.md)');
select is(public.owner_set_club_owner('m3'), 'already', 'and is idempotent');
select is(public.owner_set_coach('norec'), 'set', 'a new coach');
select is(public.owner_set_club_owner('norec'), 'set', 'reassigning to the coach');
select is(tests.role_in(tests.kid(), tests.uid('m3')), 'member', 'the previous owner becomes a member');
select is((select count(*)::int from public.circle_members where club_id = tests.kid() and role = 'coach'), 0, 'and the coach seat is empty again');
select is(public.owner_set_coach('m3'), 'set', 'm3 is now the coach');

-- Account deletion goes through the same trigger
select tests.set_auth(tests.uid('norec'));
select lives_ok($$ select public.request_account_deletion() $$, 'the owner requests account deletion');
select tests.clear_auth();
select is(tests.role_in(tests.kid(), tests.uid('m3')), 'owner', 'the coach becomes the owner at the request');

-- Everyone leaves: the club stays
delete from public.circle_members where club_id = tests.kid();
select ok(exists (select 1 from public.clubs where type = 'club'), 'the last member leaving does not delete a club');

-- =====================================================================================================
-- 11. Transfer blobs: opaque, one take, 24 hours
-- =====================================================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.transfer_put(repeat('a', 64), 'AAAAAAAAAAAAAAAA', 'AAAA', repeat('a', 64)) $$, '42501', null, 'an authenticated caller cannot execute transfer_put');
select throws_ok($$ select public.transfer_take(repeat('a', 64), repeat('a', 64)) $$, '42501', null, 'nor transfer_take');
select tests.clear_auth();
set local role anon;
select throws_ok($$ select public.transfer_take(repeat('a', 64), repeat('a', 64)) $$, '42501', null, 'nor can anon');
reset role;

create function tests.b64(p bytea) returns text language sql immutable as $$ select translate(encode(p, 'base64'), E'\n', '') $$;
create table tests.ct as select extensions.gen_random_bytes(1024) || extensions.gen_random_bytes(1024) as bytes;
set local role service_role;
select is(public.transfer_put(repeat('1', 64), tests.b64(extensions.gen_random_bytes(12)), tests.b64((select bytes from tests.ct)), repeat('e', 64)),
  'stored', 'service_role stores a random ciphertext');
select is(public.transfer_put(repeat('2', 64), tests.b64(extensions.gen_random_bytes(12)),
  tests.b64(convert_to('{"app":"box-log","version":1,"entries":[],"bodyweightEntries":[{"weight":80}]}', 'UTF8')), repeat('e', 64)),
  'plaintext', 'a plaintext backup is refused');
select is(public.transfer_put(repeat('3', 64), tests.b64(extensions.gen_random_bytes(12)),
  tests.b64(extensions.gen_random_bytes(40) || convert_to('"entries"', 'UTF8') || extensions.gen_random_bytes(40)), repeat('e', 64)),
  'plaintext', 'bytes carrying a backup field name are refused');
select is(public.transfer_put(repeat('4', 64), tests.b64(extensions.gen_random_bytes(12)), tests.b64(convert_to('[1,2,3,4,5,6,7,8,9,10]', 'UTF8')), repeat('e', 64)),
  'plaintext', 'any valid JSON is refused');
select is(public.transfer_put(repeat('5', 64), '***', tests.b64(extensions.gen_random_bytes(64)), repeat('e', 64)), 'invalid', 'bad base64 is invalid');
select is(public.transfer_put(repeat('6', 64), tests.b64(extensions.gen_random_bytes(12)), repeat('AAAA', 1747627), repeat('f', 64)),
  'too_large', 'more than 5 MiB of ciphertext is refused');
select is(public.transfer_put(repeat('7', 64), tests.b64(extensions.gen_random_bytes(12)), tests.b64(extensions.gen_random_bytes(64)), repeat('e', 64)),
  'rate_limited', 'the sixth put from one IP in a day is refused');
reset role;

-- The stored blob is not JSON and holds no plaintext field name (owner decision 2).
select ok(not public.transfer_looks_plaintext((select ciphertext from public.transfer_blobs where lookup_hash = repeat('1', 64))),
  'the stored blob carries no backup field name');
select throws_ok($$ select convert_from((select ciphertext from public.transfer_blobs where lookup_hash = repeat('1', 64)), 'UTF8')::jsonb $$,
  null, null, 'and is not valid JSON');
select is((select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'transfer_blobs'
            and column_name not in ('lookup_hash', 'iv', 'ciphertext', 'ip_hash', 'created_at')), 0,
  'transfer_blobs has no column for a key, a code, a username or a plaintext field');

set local role service_role;
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'an unknown lookup is not found');
select is(public.transfer_take(repeat('1', 64), repeat('b', 64)) ->> 'ciphertext', tests.b64((select bytes from tests.ct)),
  'the take returns the exact ciphertext');
select is(public.transfer_take(repeat('1', 64), repeat('b', 64)) ->> 'status', 'not_found', 'a second take finds nothing: one download');
reset role;
insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash, created_at) values
  (repeat('8', 64), extensions.gen_random_bytes(12), extensions.gen_random_bytes(64), repeat('e', 64), now() - interval '25 hours');
set local role service_role;
select is(public.transfer_take(repeat('8', 64), repeat('b', 64)) ->> 'status', 'not_found', 'a blob older than 24 hours is not returned');
reset role;
select is((select count(*)::int from public.transfer_blobs where lookup_hash = repeat('8', 64)), 0, 'and is deleted by the attempt');
set local role service_role;
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 5 from one IP');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 6');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 7');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 8');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 9');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'not_found', 'take 10');
select is(public.transfer_take(repeat('9', 64), repeat('b', 64)) ->> 'status', 'rate_limited', 'the eleventh take from one IP in 15 minutes is refused');
reset role;

insert into public.transfer_blobs (lookup_hash, iv, ciphertext, ip_hash)
select encode(extensions.digest('cap' || i, 'sha256'), 'hex'), extensions.gen_random_bytes(12), extensions.gen_random_bytes(64), repeat('e', 64)
  from generate_series(1, 40) i;
set local role service_role;
select is(public.transfer_put(repeat('a', 64), tests.b64(extensions.gen_random_bytes(12)), tests.b64(extensions.gen_random_bytes(64)), repeat('c', 64)),
  'full', 'with 40 pending blobs a new put is refused');
reset role;
update public.transfer_blobs set created_at = now() - interval '25 hours';
select is(public.transfer_purge(), 40, 'transfer_purge deletes blobs older than 24 hours');
select ok(exists (select 1 from cron.job where jobname = 'transfer-purge'), 'the purge is scheduled');

-- =====================================================================================================
-- 12. Usage counting
-- =====================================================================================================
select set_config('request.headers', '{"origin": "https://haimuniya.github.io"}', true);
set local role anon;
select lives_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('e1000000-0000-4000-8000-000000000001', 'app_open', '') $$,
  'anon counts an app open');
select lives_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('e1000000-0000-4000-8000-000000000001', 'app_open', '') $$,
  'a repeat the same day is dropped, not an error');
select throws_ok($$ select count(*) from public.training_log_usage $$, '42501', null, 'anon cannot read a row');
select throws_ok($$ insert into public.training_log_usage (device_id, event, screen, app) values ('e1000000-0000-4000-8000-000000000002', 'app_open', '', 'club') $$,
  '42501', null, 'anon cannot choose the app');
reset role;
select set_config('request.headers', '{"origin": "https://haimunia.pages.dev"}', true);
set local role anon;
select lives_ok($$ insert into public.training_log_usage (device_id, event, screen) values ('e1000000-0000-4000-8000-000000000003', 'screen_open', 'circle') $$,
  'the new app counts a screen');
reset role;
select set_config('request.headers', '', true);
select is((select app from public.training_log_usage where device_id = 'e1000000-0000-4000-8000-000000000001'), 'old', 'the old app is recognised by its Origin');
select is((select app from public.training_log_usage where device_id = 'e1000000-0000-4000-8000-000000000003'), 'club', 'the new app too');
select is((select count(*)::int from public.training_log_usage where device_id = 'e1000000-0000-4000-8000-000000000001'), 1, 'one row per device, event and day');
select is((public.training_log_usage_report(4) -> 'apps_7d' ->> 'old')::int, 1, 'the report counts devices per app, totals only');
update public.training_log_usage set day = day - 401;
select ok(public.training_log_usage_purge() >= 2, 'counts older than 400 days are purged');
select ok(exists (select 1 from cron.job where jobname = 'training-log-usage-purge'), 'the purge is scheduled');

select * from finish();
rollback;
