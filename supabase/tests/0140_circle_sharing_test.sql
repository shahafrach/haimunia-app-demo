-- Circles RPCs, part 2 (202610250005): posts, PR and achievement shares,
-- reactions, "trained together".
--
--   Circle A = m1 (owner), m2, m3        Circle C = m1 (owner), m2
--   Circle B = owner (owner), bm
-- For every function: a member of A (and not of B) cannot act on B.

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

insert into public.clubs (id, name, type, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'Circle A', 'friends', tests.uid('m1')),
  ('b0000000-0000-4000-8000-00000000000b', 'Circle B', 'friends', tests.uid('owner')),
  ('c0000000-0000-4000-8000-00000000000c', 'Circle C', 'friends', tests.uid('m1'));
insert into public.circle_members (club_id, user_id, role) values
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m1'), 'owner'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m2'), 'member'),
  ('a0000000-0000-4000-8000-00000000000a', tests.uid('m3'), 'member'),
  ('b0000000-0000-4000-8000-00000000000b', tests.uid('owner'), 'owner'),
  ('b0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'member'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('m1'), 'owner'),
  ('c0000000-0000-4000-8000-00000000000c', tests.uid('m2'), 'member');

insert into public.workout_posts (id, author_id, club_id, post_type, title, status, published_at) values
  ('a1000000-0000-4000-8000-000000000001', tests.uid('m1'),    'a0000000-0000-4000-8000-00000000000a', 'POST_WORKOUT', 'A workout', 'active', now()),
  ('a1000000-0000-4000-8000-000000000002', tests.uid('m2'),    'a0000000-0000-4000-8000-00000000000a', 'POST_TEXT',    'A text',    'active', now()),
  ('b1000000-0000-4000-8000-000000000001', tests.uid('owner'), 'b0000000-0000-4000-8000-00000000000b', 'POST_WORKOUT', 'B workout', 'active', now()),
  ('b1000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-00000000000b', 'POST_WORKOUT', 'BM workout', 'active', now());

insert into public.private_records (user_id, record_type, record_id, payload) values
  (tests.uid('m1'), 'movement', 'mv-140', '{"name":"סקוואט"}'),
  (tests.uid('m1'), 'strength_entry', 'set-140-new',
   '{"exerciseId":"mv-140","type":"reps","weight":100,"reps":5,"date":"2026-09-01","ts":2000,"est1RM":112.5}'),
  (tests.uid('m1'), 'strength_entry', 'set-140-old',
   '{"exerciseId":"mv-140","type":"reps","weight":90,"reps":5,"date":"2026-08-01","ts":1000,"est1RM":101.25}'),
  (tests.uid('m1'), 'strength_entry', 'set-140-b',
   '{"exerciseId":"mv-140","type":"reps","weight":105,"reps":5,"date":"2026-09-10","ts":3000,"est1RM":118}');

insert into public.achievement_definitions
  (id, code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values ('a1400000-0000-4000-8000-000000000001', 'test_share_140', 'עשרה שיאים', 'עשרה שיאים אישיים',
        'performance', 'PR_CREATED', 10, false, 'club', '⭐', true, '{"client_claimable": true, "metric": "tenure_days"}');
insert into public.member_achievements (id, user_id, achievement_id, visibility, unlocked_at) values
  ('b1400000-0000-4000-8000-000000000001', tests.uid('m1'), 'a1400000-0000-4000-8000-000000000001', 'club', '2026-09-02T08:00:00Z'),
  ('b1400000-0000-4000-8000-000000000002', tests.uid('m2'), 'a1400000-0000-4000-8000-000000000001', 'club', '2026-09-02T08:00:00Z');

-- =====================================================================
-- 1. post_create
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.post_create('a0000000-0000-4000-8000-00000000000a', 'hello A') $$, 'a member posts to their circle');
select lives_ok($$ select public.post_create('c0000000-0000-4000-8000-00000000000c', 'hello A') $$, 'sharing the same words to a second circle is a second call...');
select tests.clear_auth();
select is((select count(*)::int from public.workout_posts where body = 'hello A'), 2, '...and a second post');
select is((select count(distinct club_id)::int from public.workout_posts where body = 'hello A'), 2, 'each in its own circle');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.post_create('b0000000-0000-4000-8000-00000000000b', 'into B') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot post to B');
select throws_ok($$ select public.post_create('a0000000-0000-4000-8000-00000000000a', '   ') $$, 'P0001', 'a post needs text', 'a blank post is refused');
select throws_ok($$ select public.post_create(null, 'x') $$, 'P0001', 'not authorized', 'a post with no circle is refused');
select lives_ok($$ select public.post_create('a0000000-0000-4000-8000-00000000000a', 'keyed', 'e1400000-0000-4000-8000-000000000001') $$, 'a keyed post');
select is(public.post_create('a0000000-0000-4000-8000-00000000000a', 'keyed', 'e1400000-0000-4000-8000-000000000001'),
  (select id from public.workout_posts where body = 'keyed'), 'replaying the key returns the original post');
select tests.clear_auth();
select is((select count(*)::int from public.workout_posts where club_id = 'b0000000-0000-4000-8000-00000000000b'), 2, 'B has only its own two posts');

-- =====================================================================
-- 2. pr_share
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.pr_share('a0000000-0000-4000-8000-00000000000a', 'set-140-new', 'שיא') $$, 'a PR is shared to circle A with NO weight sent');
select lives_ok($$ select public.pr_share('c0000000-0000-4000-8000-00000000000c', 'set-140-new', 'שיא', 100) $$, 'and the same PR to circle C, this time with the weight sent');
select tests.clear_auth();
select is((select count(*)::int from public.workout_posts where source_record_id = 'set-140-new'), 2, 'one record, two circles, two posts');
select is((select result_text from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'a0000000-0000-4000-8000-00000000000a'),
  '+11.1%', 'WITHOUT the weight: the post says the percent improvement over the previous best');
select is((select metadata ? 'improvement_pct' and not (metadata ? 'new_result') and not (metadata ? 'previous_result') and not (metadata ? 'improvement')
             from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'a0000000-0000-4000-8000-00000000000a'),
  true, '... and carries no absolute figure in its metadata');
select is((select score_value is null from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'a0000000-0000-4000-8000-00000000000a'),
  true, '... and no score_value (an absolute number)');
select is((select (result_text || coalesce(title, '') || coalesce(body, '') || metadata::text) !~ '(100|90|112)'
             from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'a0000000-0000-4000-8000-00000000000a'),
  true, '... and 100, 90 and 112.5 appear nowhere in the stored row');
select is((select result_text from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'c0000000-0000-4000-8000-00000000000c'),
  '100 ק"ג × 5', 'WITH the weight: the weight is stored');
select is((select metadata ->> 'improvement' from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'c0000000-0000-4000-8000-00000000000c'),
  '+10 ק"ג', 'and the previous-best arithmetic');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.pr_share('b0000000-0000-4000-8000-00000000000b', 'set-140-b', 'x') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot share a PR into B');
select throws_ok($$ select public.pr_share('a0000000-0000-4000-8000-00000000000a', 'set-140-b', 'x', 0) $$, 'P0001', 'weight is out of range', 'a zero weight is refused');
select throws_ok($$ select public.pr_share('a0000000-0000-4000-8000-00000000000a', 'set-140-b', 'x', 5000) $$, 'P0001', 'weight is out of range', 'and an absurd one');
select is(public.pr_share('a0000000-0000-4000-8000-00000000000a', 'set-140-new', 'again'),
  (select id from public.workout_posts where source_record_id = 'set-140-new' and club_id = 'a0000000-0000-4000-8000-00000000000a'),
  'sharing the same record to the same circle again returns the first post');
select tests.clear_auth();
select is((select count(*)::int from public.workout_posts where source_record_id = 'set-140-b'), 0, 'and the refused shares wrote nothing');

-- =====================================================================
-- 3. ach_share
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.ach_share('a0000000-0000-4000-8000-00000000000a', 'b1400000-0000-4000-8000-000000000001', 'כן') $$, 'an achievement is shared to circle A');
select lives_ok($$ select public.ach_share('c0000000-0000-4000-8000-00000000000c', 'b1400000-0000-4000-8000-000000000001', 'כן') $$, 'and to circle C: one post per circle');
select throws_ok($$ select public.ach_share('b0000000-0000-4000-8000-00000000000b', 'b1400000-0000-4000-8000-000000000001', 'x') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: not into B');
select throws_ok($$ select public.ach_share('a0000000-0000-4000-8000-00000000000a', 'b1400000-0000-4000-8000-000000000002', 'x') $$, 'P0001', 'not authorized', 'and not someone else''s achievement');
select tests.clear_auth();
select is((select count(*)::int from public.workout_posts where source_type = 'achievement' and author_id = tests.uid('m1')), 2, 'two achievement posts, one per circle');
select is((select count(*)::int from public.workout_posts where source_type = 'achievement' and club_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'none in B');

-- =====================================================================
-- 4. toggle_reaction
-- =====================================================================
select tests.set_auth(tests.uid('m3'));
select is(public.toggle_reaction('a1000000-0000-4000-8000-000000000001'), true, 'the fist bump (default kind)');
select is(public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'fire'), true, 'a second kind');
select is(public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'strong'), true, 'a third kind: the fist bump plus two others');
select throws_ok($$ select public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'clap') $$, 'P0001', 'reaction_limit', 'a fourth is refused: at most two others');
select throws_ok($$ select public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'poo') $$, 'P0001', 'unknown reaction', 'a kind outside the fixed set is refused');
select is(has_table_privilege('authenticated', 'public.reactions', 'insert'), false, 'a client has no direct INSERT on reactions: toggle_reaction is the only way in');
select is(public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'fire'), false, 'toggling again takes it back');
select is(public.toggle_reaction('a1000000-0000-4000-8000-000000000001', null, 'clap'), true, 'which frees a slot');
select throws_ok($$ select public.toggle_reaction('b1000000-0000-4000-8000-000000000001') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot react to a post in B');
select throws_ok($$ select public.toggle_reaction('00000000-0000-4000-8000-0000000000ff') $$, 'P0001', 'not authorized', 'and a post that does not exist is the same answer');
select tests.clear_auth();
select throws_ok($$ insert into public.reactions (post_id, user_id, kind) values ('a1000000-0000-4000-8000-000000000001', tests.uid('m3'), 'heart') $$, 'P0001', 'reaction_limit', 'and the cap is also a property of the row, so any other writer meets it too');
select is((select count(*)::int from public.reactions where post_id = 'b1000000-0000-4000-8000-000000000001'), 0, 'B''s post has no reactions');
select is((select count(*)::int from public.reactions where user_id = tests.uid('m3')), 3, 'm3 holds three reactions: cheer, strong, clap');

-- =====================================================================
-- 5. Trained together
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(public.post_tag_training_partners('a1000000-0000-4000-8000-000000000001',
  array[tests.uid('m2'), tests.uid('m3'), 'bbbbbbbb-0000-4000-8000-0000000000b1', tests.uid('m1')]), 2,
  'tagging m2, m3, bm (not in A) and myself leaves two tags: strangers and self are dropped');
select tests.clear_auth();
select is((select count(*)::int from public.post_training_partners where post_id = 'a1000000-0000-4000-8000-000000000001' and confirmed_at is null), 2, 'both tags are PENDING');
select is((select club_id from public.post_training_partners where tagged_user_id = tests.uid('m2')), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'a tag takes the circle of its post');

select tests.set_auth(tests.uid('m2'));
select is((select count(*)::int from public.post_training_partners), 1, 'the tagged member sees their own pending tag');
select is((select count(*)::int from public.notifications where type = 'trained_together'), 1, 'and was told, in their own notifications');
select tests.set_auth(tests.uid('m3'));
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('m2')), 0, 'a third member does NOT see someone else''s pending tag');
select is((select count(*) from public.post_training_partners_for(array['a1000000-0000-4000-8000-000000000001'::uuid])), 0::bigint, 'and a card shows no partners while all are pending');
select tests.set_auth(tests.uid('m1'));
select is((select count(*)::int from public.post_training_partners), 2, 'the tagger sees both pending tags');

select throws_ok($$ select public.confirm_trained_together('a1000000-0000-4000-8000-000000000001') $$, 'P0001', 'not authorized', 'only the TAGGED member can confirm: the tagger cannot confirm for them');
select tests.set_auth('bbbbbbbb-0000-4000-8000-0000000000b1');
select throws_ok($$ select public.confirm_trained_together('a1000000-0000-4000-8000-000000000001') $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of B cannot confirm in A');
select tests.set_auth(tests.uid('m2'));
select lives_ok($$ select public.confirm_trained_together('a1000000-0000-4000-8000-000000000001') $$, 'the tagged member confirms');
select lives_ok($$ select public.confirm_trained_together('a1000000-0000-4000-8000-000000000001') $$, 'and confirming twice is harmless');
select tests.set_auth(tests.uid('m3'));
select is((select count(*) from public.post_training_partners_for(array['a1000000-0000-4000-8000-000000000001'::uuid])), 1::bigint, 'now the card shows exactly the one confirmed partner');
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('m2')), 1, 'and the circle can see that confirmed tag');
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('m3') and confirmed_at is null), 1, 'm3''s own tag is still pending');

select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.post_tag_training_partners('a1000000-0000-4000-8000-000000000002', array[tests.uid('m3')]) $$, 'P0001', 'not authorized', 'tagging on someone else''s post is refused');
select tests.set_auth(tests.uid('m2'));
select throws_ok($$ select public.post_tag_training_partners('a1000000-0000-4000-8000-000000000002', array[tests.uid('m3')]) $$, 'P0001', 'training partners are for workout posts', 'only workout posts take partners');
select tests.set_auth(tests.uid('m1'));
select throws_ok($$ select public.post_tag_training_partners('b1000000-0000-4000-8000-000000000001', array[tests.uid('owner')]) $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot tag on a post in B');
select throws_ok($$ select public.post_tag_training_partners('a1000000-0000-4000-8000-000000000001', array(select gen_random_uuid() from generate_series(1, 11))) $$, 'P0001', 'at most 10 training partners per post', 'at most ten tags');
select throws_ok(format($$ select public.post_training_partner_remove('b1000000-0000-4000-8000-000000000001', %L) $$, tests.uid('owner')), 'P0001', 'not authorized', 'CROSS-CIRCLE: a member of A cannot remove a tag in B');
select tests.set_auth('bbbbbbbb-0000-4000-8000-0000000000b1');
select throws_ok($$ select public.post_training_partner_remove('a1000000-0000-4000-8000-000000000001', null) $$, 'P0001', 'not authorized', 'CROSS-CIRCLE: and a member of B cannot touch A''s tags either');
select tests.set_auth(tests.uid('m3'));
select throws_ok(format($$ select public.post_training_partner_remove('a1000000-0000-4000-8000-000000000001', %L) $$, tests.uid('m2')), 'P0001', 'not authorized', 'a third member cannot remove someone else''s tag');
select lives_ok($$ select public.post_training_partner_remove('a1000000-0000-4000-8000-000000000001') $$, 'a tagged member declines their own tag');
select tests.clear_auth();
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('m3')), 0, 'it is gone');
select is((select count(*)::int from public.post_training_partners where tagged_user_id = tests.uid('m2')), 1, 'and m2''s confirmed tag is not');
select tests.set_auth(tests.uid('m1'));
select lives_ok($$ select public.post_training_partner_remove('a1000000-0000-4000-8000-000000000001', tests.uid('m2')) $$, 'the author clears a name they put there');
select tests.clear_auth();
select is((select count(*)::int from public.post_training_partners), 0, 'no tags remain');

-- =====================================================================
-- 6. notif_blocked_between is internal and caller-scoped
-- =====================================================================
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('owner'), 'bbbbbbbb-0000-4000-8000-0000000000b1');
select is(has_function_privilege('authenticated', 'public.notif_blocked_between(uuid, uuid)', 'execute'), false, 'no client role can call it');
select is(public.notif_blocked_between(tests.uid('owner'), 'bbbbbbbb-0000-4000-8000-0000000000b1'), true, 'a trigger or job with no caller gets the answer');
-- Run as the owner role (so the grant is not in the way) with m1 as the caller.
select ok(set_config('request.jwt.claim.sub', tests.uid('m1')::text, true) is not null, 'the caller is m1');
select is(public.notif_blocked_between(tests.uid('owner'), 'bbbbbbbb-0000-4000-8000-0000000000b1'), false,
  'a caller outside the pair is told nothing about two OTHER people');
select ok(set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-0000000000b1', true) is not null, 'the caller is bm');
select is(public.notif_blocked_between(tests.uid('owner'), 'bbbbbbbb-0000-4000-8000-0000000000b1'), true, 'a party to the block is told');
select tests.clear_auth();

select * from finish();
rollback;
