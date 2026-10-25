-- Circles RPCs, part 3 (202610250004 and 202610250006): the weekly view, the
-- benchmark of the month, the circle feed.
--
--   Circle A = m1 (owner), m2, m3, norec        Circle B = owner (owner), bm

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

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'bm@members.haimuniya.invalid', now(), now());
insert into public.profiles (id, handle, display_name) values ('bbbbbbbb-0000-4000-8000-0000000000b1', 'member_bm', 'BM');

insert into public.clubs (id, name, type, created_by, benchmark_enabled) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1'), true),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('owner'), true);
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('norec'), 'member'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('owner'), 'owner'),
  ('b0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'member');

-- The week, computed independently of the function under test: the Monday-based
-- week of (d + 1 day) starts the day after the Sunday we want.
create temp table wk as
select ((now() at time zone 'Asia/Jerusalem')::date) as today,
       (date_trunc('week', ((now() at time zone 'Asia/Jerusalem')::date + 1)::timestamp)::date - 1) as ws;
grant select on wk to authenticated;
select is((select extract(dow from ws)::int from wk), 0, 'fixture: the week starts on a Sunday');

-- =====================================================================
-- 1. circle_week
-- =====================================================================
-- m1 target 3: 2 workouts this week (on Sunday itself and the day after), 3 last
-- week (one of them on the Saturday just before the boundary). A text post and a
-- soft-deleted workout do not count. m2 target 2, paused. m3 no target, hides
-- their count. norec has nothing.
insert into public.member_targets (user_id, weekly_target, paused_until) values
  (tests.uid('m1'), 3, null),
  (tests.uid('m2'), 2, (select today + 5 from wk));
update public.circle_members set share_defaults = '{"share_weekly_count": false}'
 where club_id = 'a0000000-0000-4000-8000-00000000000a' and user_id = tests.uid('m3');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, occurred_on, published_at)
select ('d1000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, u, 'a0000000-0000-4000-8000-00000000000a', t::public.post_type, 'w', 'active',
       (select ws from wk) + off, now()
  from (values
    (1, tests.uid('m1'), 'POST_WORKOUT', 0),
    (2, tests.uid('m1'), 'POST_WORKOUT', 1),
    (3, tests.uid('m1'), 'POST_WORKOUT', -7),
    (4, tests.uid('m1'), 'POST_WORKOUT', -6),
    (5, tests.uid('m1'), 'POST_WORKOUT', -1),   -- the Saturday before: last week
    (6, tests.uid('m1'), 'POST_TEXT',    0),    -- not a workout
    (7, tests.uid('m2'), 'POST_WORKOUT', 0),
    (8, tests.uid('m3'), 'POST_WORKOUT', 0),
    (9, tests.uid('m3'), 'POST_WORKOUT', 1)
  ) v(n, u, t, off);
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, occurred_on, published_at, deleted_at)
values ('d1000000-0000-4000-8000-000000000010', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'gone', 'active', (select ws from wk), now(), now());
-- B has workouts that must never show up in A's numbers
insert into public.workout_posts (author_id, club_id, post_type, title, status, occurred_on, published_at)
values (tests.uid('owner'), 'b0000000-0000-4000-8000-00000000000b', 'POST_WORKOUT', 'B', 'active', (select ws from wk), now());

select tests.set_auth(tests.uid('m1'));
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 2,
  'm1: two workouts this week (Sunday and Monday); the text post, the deleted one and last week''s do not count');
select is((select percent from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 67, '2 of a target of 3 is 67 percent');
select is((select target from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 3, 'and the caller sees their own target');
select is((select weeks_met from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 1,
  'weeks met: last week (3 of 3, counting the Saturday before the boundary) yes, this week (2 of 3) not yet');
select is((select paused from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), false, 'not paused');

select is((select paused from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m2')), true, 'm2 is paused');
select is((select percent from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m2')), null, 'and the circle sees no percent for them');
select is((select target from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m2')), null, 'nor their target: only the caller''s own row carries it');

select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m3')), null, 'm3 shares no weekly count: the circle sees no number');
select is((select percent from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m3')), null, 'and no percent');
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('norec')), 0, 'a member with nothing logged is listed with 0');
select is((select percent from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('norec')), null, 'and with no percent, since there is no target');
select is((select count(*)::int from public.circle_week('a0000000-0000-4000-8000-00000000000a')), 4, 'every member of the circle is listed, and nobody else');
select ok(not exists (select 1 from unnest((select p.proargnames from pg_proc p where p.proname = 'circle_week')) a where a ~* 'streak|rank'), 'there is no streak and no rank column');

select tests.set_auth(tests.uid('m3'));
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m3')), 2, 'm3 sees their own count (hiding is from the others, not from them)');

-- trained together counts only once confirmed
select tests.clear_auth();
insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
values ('d1000000-0000-4000-8000-000000000007', tests.uid('m1'), tests.uid('m2'));
select tests.set_auth(tests.uid('m1'));
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 2, 'a PENDING tag counts for nobody');
select lives_ok($$ select public.confirm_trained_together('d1000000-0000-4000-8000-000000000007') $$, 'm1 confirms');
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 3, 'a CONFIRMED tag counts for the tagged member');
select is((select percent from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 100, 'which moves the percent: 3 of 3');
select is((select weeks_met from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m1')), 2, 'and this week now counts as met');
select tests.set_auth(tests.uid('m2'));
select is((select workouts from public.circle_week('a0000000-0000-4000-8000-00000000000a') where user_id = tests.uid('m2')), 1, 'the tagger''s own count is unchanged by the tag');

-- CROSS-CIRCLE
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select * from public.circle_week('b0000000-0000-4000-8000-00000000000b') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot read B''s week');
select tests.set_auth('bbbbbbbb-0000-4000-8000-0000000000b1');
select is((select count(*)::int from public.circle_week('b0000000-0000-4000-8000-00000000000b')), 2, 'B''s own member reads B''s week');
select is((select workouts from public.circle_week('b0000000-0000-4000-8000-00000000000b') where user_id = tests.uid('owner')), 1, 'with B''s own numbers');
select throws_ok($$ select * from public.circle_week('a0000000-0000-4000-8000-00000000000a') $$, 'P0001', 'not authorized', 'and cannot read A''s');
select tests.clear_auth();
select throws_ok($$ select * from public.circle_week('a0000000-0000-4000-8000-00000000000a') $$, 'P0001', 'not authorized', 'nor can a caller with no identity');

-- =====================================================================
-- 2. Benchmark of the month
-- =====================================================================
select tests.clear_auth();
update public.clubs set benchmark = 'fran' where id in ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b');
select is((select benchmark_month from public.clubs where id = 'a0000000-0000-4000-8000-00000000000a'), (select date_trunc('month', today::timestamp)::date from wk), 'fixture: the owner picked Fran this month');

select tests.set_auth(tests.uid('m1'));
select lives_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '4:10', 'rx') $$, 'm1 logs their Fran');
select tests.set_auth(tests.uid('m2'));
select is((select count(*)::int from public.benchmark_results where club_id = 'a0000000-0000-4000-8000-00000000000a'), 0,
  'm2 has NOT logged: they see nobody''s result, not even m1''s');
select lives_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '6:30', 'scaled') $$, 'm2 logs theirs');
select is((select count(*)::int from public.benchmark_results where club_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'now m2 sees both results');
select is((select string_agg(rx_or_scaled, ',' order by rx_or_scaled) from public.benchmark_results where club_id = 'a0000000-0000-4000-8000-00000000000a'), 'rx,scaled', 'Rx and scaled are told apart');
select tests.set_auth(tests.uid('m3'));
select is((select count(*)::int from public.benchmark_results), 0, 'm3, who has not logged, still sees nothing');
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'grace', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '3:00', 'rx') $$,
  '42501', null, 'a result for a benchmark the owner did not pick is refused');
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'fran', (date_trunc('month', now() at time zone 'Asia/Jerusalem') - interval '1 month')::date, '3:00', 'rx') $$,
  '42501', null, 'and one for another month');
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '1:00', 'rx') $$,
  '42501', null, 'and one in someone else''s name');
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('b0000000-0000-4000-8000-00000000000b', tests.uid('m3'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '3:00', 'rx') $$,
  '42501', null, 'CROSS-CIRCLE: and one into a circle they are not in');
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '3:00', 'elite') $$,
  '23514', null, 'Rx or scaled, nothing else');
select is(public.has_logged_benchmark('b0000000-0000-4000-8000-00000000000b', 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date), false, 'has_logged_benchmark answers only about the caller''s own results');

-- editing, and taking a result back hides the others again
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ update public.benchmark_results set result = '6:00' where user_id = tests.uid('m2') $$, 'a member edits their result');
select is((select result from public.benchmark_results where user_id = tests.uid('m2')), '6:00', 'it is edited');
select is((select count(*)::int from public.benchmark_results where user_id = tests.uid('m1')), 1, 'and m2 still sees m1''s');
delete from public.benchmark_results where user_id = tests.uid('m2');
select is((select count(*)::int from public.benchmark_results), 0, 'taking their own result back hides everyone else''s from them again');

-- the owner turns the feature off: nobody can log
select tests.clear_auth();
update public.clubs set benchmark_enabled = false where id = 'a0000000-0000-4000-8000-00000000000a';
select tests.set_auth(tests.uid('m2'));
select throws_ok($$ insert into public.benchmark_results (club_id, user_id, benchmark, month, result, rx_or_scaled)
  values ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'fran', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, '6:30', 'scaled') $$,
  '42501', null, 'with benchmark_enabled off, a result is refused');
select tests.clear_auth();

-- =====================================================================
-- 3. circle_feed
-- =====================================================================
delete from public.workout_posts where club_id = 'a0000000-0000-4000-8000-00000000000a';
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('f1000000-0000-4000-8000-000000000001', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_PR',      'old PR, no reactions',      'active', now() - interval '30 hours'),
  ('f1000000-0000-4000-8000-000000000002', tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a', 'POST_PR',      'old PR, reacted',           'active', now() - interval '29 hours'),
  ('f1000000-0000-4000-8000-000000000003', tests.uid('m3'), 'a0000000-0000-4000-8000-00000000000a', 'POST_PR',      'new PR, no reactions',      'active', now() - interval '2 hours'),
  ('f1000000-0000-4000-8000-000000000004', tests.uid('m1'), 'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'old workout, no reactions', 'active', now() - interval '28 hours'),
  ('f1000000-0000-4000-8000-000000000005', tests.uid('m2'), 'a0000000-0000-4000-8000-00000000000a', 'POST_PR',      'old PR, only self-reacted', 'active', now() - interval '27 hours'),
  ('f1000000-0000-4000-8000-000000000006', tests.uid('m3'), 'a0000000-0000-4000-8000-00000000000a', 'POST_TEXT',    'newest',                    'active', now() - interval '1 hour');
insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at)
values ('f2000000-0000-4000-8000-000000000001', tests.uid('owner'), 'b0000000-0000-4000-8000-00000000000b', 'POST_PR', 'B old PR', 'active', now() - interval '40 hours');
insert into public.reactions (post_id, user_id, kind) values
  ('f1000000-0000-4000-8000-000000000002', tests.uid('m3'), 'cheer'),
  ('f1000000-0000-4000-8000-000000000002', tests.uid('m1'), 'fire'),
  ('f1000000-0000-4000-8000-000000000005', tests.uid('m2'), 'cheer');

select tests.set_auth(tests.uid('m1'));
select is((select array_agg(title order by published_at desc) from public.circle_feed('a0000000-0000-4000-8000-00000000000a')),
  array['newest', 'new PR, no reactions', 'old PR, only self-reacted', 'old workout, no reactions', 'old PR, reacted', 'old PR, no reactions'],
  'posts come newest first');
select is((select unreacted_pr from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old PR, no reactions'), true, 'a PR over a day old with no reaction is flagged');
select is((select unreacted_pr from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old PR, reacted'), false, 'a reacted PR is not');
select is((select unreacted_pr from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'new PR, no reactions'), false, 'a PR under a day old is not');
select is((select unreacted_pr from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old workout, no reactions'), false, 'a post that is not a PR is not');
select is((select unreacted_pr from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old PR, only self-reacted'), true, 'the author''s own reaction does not count as the circle''s');
select is((select reaction_counts from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old PR, reacted'), '{"cheer":1,"fire":1}'::jsonb, 'reaction counts by kind');
select is((select my_reactions from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title = 'old PR, reacted'), array['fire'], 'and which of them are mine');

select is((select count(*)::int from public.circle_feed('a0000000-0000-4000-8000-00000000000a', null, 3)), 3, 'the page size is honoured');
select is((select array_agg(title order by published_at desc) from public.circle_feed('a0000000-0000-4000-8000-00000000000a',
    (select min(published_at) from public.circle_feed('a0000000-0000-4000-8000-00000000000a', null, 3)), 3)),
  array['old workout, no reactions', 'old PR, reacted', 'old PR, no reactions'], 'the cursor continues exactly where the page ended');
select is((select count(*)::int from public.circle_feed('a0000000-0000-4000-8000-00000000000a', null, 1000)), 6, 'a huge page size is capped, not an error');

select throws_ok($$ select * from public.circle_feed('b0000000-0000-4000-8000-00000000000b') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot read B''s feed');
select is((select count(*)::int from public.circle_feed('a0000000-0000-4000-8000-00000000000a') where title like 'B %'), 0, 'and none of B''s posts appear in A''s');
select tests.set_auth('bbbbbbbb-0000-4000-8000-0000000000b1');
select throws_ok($$ select * from public.circle_feed('a0000000-0000-4000-8000-00000000000a') $$, 'P0001', 'not authorized', 'nor B''s members read A''s');
select is((select count(*)::int from public.circle_feed('b0000000-0000-4000-8000-00000000000b')), 2, 'B''s member reads B''s two posts');
select tests.clear_auth();
select throws_ok($$ select * from public.circle_feed('a0000000-0000-4000-8000-00000000000a') $$, 'P0001', 'not authorized', 'and a caller with no identity reads nothing');

select * from finish();
rollback;
