-- The chronological feed and its switch (202609220003).
--
-- Four questions, and the last two are the ones that matter most:
--
--   1. Is the order actually an order? Newest first, with pinned posts,
--      coach posts and announcements, and TODAY'S club WOD above the stream
--      and in that sequence - and yesterday's WOD back in the stream, where
--      a member hunting for today's workout needs it not to be.
--   2. Does the switch switch? 'ranked' really is the old order (the pin
--      stops leading, because a pin has never carried weight there),
--      'chronological' is the default when nobody has chosen, and a value
--      nobody implemented reads as the default rather than as an error.
--   3. DOES THE NEW SORT STILL HIDE WHAT THE OLD ONE HID? A hidden post, a
--      blocked author in either direction, a removed post and a soft-deleted
--      one are all absent from the CHRONOLOGICAL page. 0019 and 0042 already
--      pin these against the ranked order; the risk this file exists for is
--      a new ordering path that quietly reaches the rows the old one filtered.
--   4. Does saving the order cost the club anything else in the config? The
--      module going off and on again, twice, must leave `order` exactly
--      where it was, and must not take enabled_at with it.
--
-- Run locally against Postgres 16 + pgTAP before merge (the Actions
-- allowance is out until 2026-10-01, see docs/PROJECT_STATUS.md).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- fixture
-- =====================================================================
-- Every timestamp is relative to now() and inside the 90-day window, and
-- every body string is unique, because the assertions below read the page
-- as a list of bodies: an order test that compares uuids is unreadable the
-- day it fails.
select tests.clear_auth();

insert into public.workout_posts (id, author_id, post_type, visibility, body, published_at) values
  ('c1200000-0000-4000-8000-000000000001', tests.uid('m1'),    'POST_TEXT',         'club', 'stream oldest',  now() - interval '5 hours'),
  ('c1200000-0000-4000-8000-000000000002', tests.uid('m1'),    'POST_TEXT',         'club', 'stream middle',  now() - interval '3 hours'),
  ('c1200000-0000-4000-8000-000000000003', tests.uid('m1'),    'POST_TEXT',         'club', 'stream newest',  now() - interval '1 hour'),
  -- Older than everything in the stream, so only the pin can explain it
  -- leading the page.
  ('c1200000-0000-4000-8000-000000000004', tests.uid('m1'),    'POST_TEXT',         'club', 'pinned but old', now() - interval '2 days'),
  -- Older still: a coach announcement is lifted for what it is, not for when.
  ('c1200000-0000-4000-8000-000000000005', tests.uid('coach'), 'POST_ANNOUNCEMENT', 'club', 'announcement',   now() - interval '4 days'),
  ('c1200000-0000-4000-8000-000000000006', tests.uid('coach'), 'POST_CLUB_WOD',     'club', 'wod today',      now() - interval '6 hours'),
  ('c1200000-0000-4000-8000-000000000007', tests.uid('coach'), 'POST_CLUB_WOD',     'club', 'wod yesterday',  now() - interval '30 hours'),
  -- The three that must never reach a page, whatever the order.
  ('c1200000-0000-4000-8000-000000000008', tests.uid('m1'),    'POST_TEXT',         'club', 'hidden by m2',   now() - interval '2 hours'),
  ('c1200000-0000-4000-8000-000000000009', tests.uid('m3'),    'POST_TEXT',         'club', 'from m3',        now() - interval '2 hours'),
  ('c1200000-0000-4000-8000-00000000000a', tests.uid('m1'),    'POST_TEXT',         'club', 'removed post',   now() - interval '2 hours'),
  ('c1200000-0000-4000-8000-00000000000b', tests.uid('m1'),    'POST_TEXT',         'club', 'deleted post',   now() - interval '2 hours');

update public.workout_posts set status = 'removed' where id = 'c1200000-0000-4000-8000-00000000000a';
update public.workout_posts set deleted_at = now() where id = 'c1200000-0000-4000-8000-00000000000b';

-- The two WOD cards need their session rows: the tier is read off
-- club_wod_sessions, not off the card's own metadata copy.
insert into public.club_wods (wod_id, name, description, score_type, published_by)
values ('customwod-0120', 'Fixture WOD', '', 'time', tests.uid('coach'));
insert into public.club_wod_sessions (wod_id, session_date, post_id, published_by) values
  ('customwod-0120', current_date,     'c1200000-0000-4000-8000-000000000006', tests.uid('coach')),
  ('customwod-0120', current_date - 1, 'c1200000-0000-4000-8000-000000000007', tests.uid('coach'));

insert into public.pins (target_type, target_id, slot, pinned_by, note)
values ('post', 'c1200000-0000-4000-8000-000000000004', 0, tests.uid('admin'), 'read this');

insert into public.hidden_posts (user_id, post_id)
values (tests.uid('m2'), 'c1200000-0000-4000-8000-000000000008');

-- m2 blocked m3. The reverse direction is tested further down by moving the
-- row, because "the feed excludes blocked authors" has to hold whichever way
-- round the block was made.
insert into public.blocks (blocker_id, blocked_id)
values (tests.uid('m2'), tests.uid('m3'));

-- =====================================================================
-- 1. chronological is the default, and it is an order
-- =====================================================================
select tests.set_auth(tests.uid('m2'));

select is(
  public.club_feature_choice('feed', 'order', 'chronological', array['chronological', 'ranked']),
  'chronological',
  'no club has chosen anything, so the feed is chronological - the default lives in the reader, not in a row');

select results_eq(
  $$ select body from public.feed_page(null, 20, 'for_you') $$,
  $$ values ('pinned but old'), ('announcement'), ('wod today'),
            ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday') $$,
  'pinned, then the coach announcement, then today''s WOD, then every other post newest first');

-- Said again as its own assertion, because it is the whole promise and a
-- reader should not have to derive it from the list above.
select results_eq(
  $$ select body from public.feed_page(null, 20, 'for_you') offset 3 $$,
  $$ values ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday') $$,
  'below the lifted tiers it is published_at descending and nothing else - yesterday''s WOD is an ordinary post again');

-- The page boundary, which is where an order that sorts on two things at
-- once goes wrong: page one ends INSIDE the lifted tiers, so the cursor
-- carries a tier rather than a score and page two has to pick up in the
-- stream below it without repeating or dropping a post.
select results_eq(
  $$ select body from public.feed_page(null, 3, 'for_you') $$,
  $$ values ('pinned but old'), ('announcement'), ('wod today') $$,
  'a three-post page is the three lifted posts');
select results_eq(
  $$ select body from public.feed_page(
       (select next_cursor from public.feed_page(null, 3, 'for_you') limit 1), 3, 'for_you') $$,
  $$ values ('stream newest'), ('stream middle'), ('stream oldest') $$,
  'and the cursor picks up in the stream, newest first, with nothing repeated and nothing skipped');

-- =====================================================================
-- 2. hidden, blocked and removed stay out - of the CHRONOLOGICAL page
-- =====================================================================
select is_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'hidden by m2' $$,
  'a post m2 hid is not on m2''s chronological page');
select is_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'from m3' $$,
  'a post by a member m2 has blocked is not on it either');
select is_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'removed post' $$,
  'a post moderation removed is not on it');
select is_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'deleted post' $$,
  'and neither is a deleted one');

-- The hide is m2's, not the club's.
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'hidden by m2' $$,
  'the post m2 hid is still on everybody else''s page - a hide is one member''s, not a removal');

-- The block, the other way round: m3 blocked m2 this time.
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m2') and blocked_id = tests.uid('m3');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m2'));
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.feed_page(null, 20, 'for_you') where body = 'from m3' $$,
  'a block hides the author''s posts in the other direction too');

-- =====================================================================
-- 3. the switch: ranked is still there, and still ranked
-- =====================================================================
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"order": "ranked"}'::jsonb) $$,
  'an admin switches the club''s feed back to the ranked order');
select tests.set_auth(tests.uid('m2'));

select is(
  public.club_feature_choice('feed', 'order', 'chronological', array['chronological', 'ranked']),
  'ranked',
  'and the reader reads it back');

-- The structural difference, and the one that cannot be a coincidence: the
-- ranked order has never known what a pin is, so a two-day-old post stops
-- leading the moment the club switches.
select isnt(
  (select body from public.feed_page(null, 20, 'for_you') limit 1),
  'pinned but old',
  'on the ranked page the pin carries no weight, so the old post no longer leads');

-- Same page, same rules about who may see what: switching the order must not
-- change the SET of posts, only their sequence.
select set_eq(
  $$ select body from public.feed_page(null, 20, 'for_you') $$,
  $$ values ('pinned but old'), ('announcement'), ('wod today'),
            ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday') $$,
  'the ranked page holds exactly the same posts - hidden, blocked, removed and deleted are out of both orders');

-- =====================================================================
-- 4. a word nobody implemented is not an outage
-- =====================================================================
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"order": "by_vibes"}'::jsonb) $$,
  'the config will take any string - it is jsonb, and the panel is not the only way in');
select tests.set_auth(tests.uid('m2'));
select is(
  public.club_feature_choice('feed', 'order', 'chronological', array['chronological', 'ranked']),
  'chronological',
  'an unimplemented order reads as the default rather than raising');
select results_eq(
  $$ select body from public.feed_page(null, 20, 'for_you') limit 1 $$,
  $$ values ('pinned but old') $$,
  'and the feed really does fall back - it is the chronological page again, not an error');

select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"order": 3}'::jsonb) $$,
  'a number where a word belongs is also something jsonb allows');
select tests.set_auth(tests.uid('m2'));
select is(
  public.club_feature_choice('feed', 'order', 'chronological', array['chronological', 'ranked']),
  'chronological',
  'and it too reads as the default - every rejection falls back, none of them raises');

-- =====================================================================
-- 5. switching the module off and on does not cost the club its settings
-- =====================================================================
-- The reason this is a test and not an assumption: admin_set_club_feature()
-- wrote coalesce(p_config, '{}') until 202609220002, so the two-argument call
-- the panel's switch makes would have erased the config on every toggle. The
-- order now lives in that same object, so that regression would silently put
-- the club back on a feed they had switched away from.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"order": "ranked", "kept_by_nobody": "x"}'::jsonb) $$,
  'the club is on the ranked order, alongside another key in the same object');
select lives_ok( $$ select public.admin_set_club_feature('feed', false) $$, 'an admin switches the feed module off');
select lives_ok( $$ select public.admin_set_club_feature('feed', true) $$,  'and straight back on');
select lives_ok( $$ select public.admin_set_club_feature('feed', false) $$, 'off again');
select lives_ok( $$ select public.admin_set_club_feature('feed', true) $$,  'and on again');
select tests.clear_auth();

select results_eq(
  $$ select config ->> 'order', config ->> 'kept_by_nobody'
       from public.club_features where module_key = 'feed' $$,
  $$ values ('ranked', 'x') $$,
  'two round trips through the switch and both keys are exactly where they were');
select isnt_empty(
  $$ select 1 from public.club_features
      where module_key = 'feed' and config ? 'enabled_at' $$,
  'and the server-owned enable stamp is in the same object, untouched by any of it');

select * from finish();
rollback;
