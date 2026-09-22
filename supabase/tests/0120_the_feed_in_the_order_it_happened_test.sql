-- The chronological feed and its switch (202609220003).
--
-- Four questions, and the last two are the ones that matter most:
--
--   1. Is the order actually an order? Newest first, with pinned posts,
--      coach posts and announcements, and TODAY'S club WOD above the stream
--      and in that sequence - and yesterday's WOD back in the stream, where
--      a member hunting for today's workout needs it not to be.
--   1b. Is the lifted block bounded? A coach post drops into the stream
--      after the club's `coach_top_hours` (72 shipped); an announcement
--      holds its place until its own expires_at and falls back to those
--      same hours when it has none. Both bounds, both directions, plus the
--      hours really being the club's number rather than a constant that
--      happens to equal it: moving it to 1 moves a post, a word instead of
--      a number reads as the default, and 100000 clamps to 336.
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
  -- The coach tier, in every combination that decides it. Inside the 72
  -- hours or outside it; carrying an announcement with a live expiry, one
  -- with an expiry that has passed, or no announcement at all.
  ('c1200000-0000-4000-8000-000000000005', tests.uid('coach'), 'POST_ANNOUNCEMENT', 'club', 'announcement fresh',   now() - interval '2 hours'),
  ('c1200000-0000-4000-8000-00000000000c', tests.uid('coach'), 'POST_COACH',        'club', 'coach fresh',          now() - interval '30 minutes'),
  ('c1200000-0000-4000-8000-00000000000d', tests.uid('coach'), 'POST_COACH',        'club', 'coach stale',          now() - interval '4 days'),
  ('c1200000-0000-4000-8000-00000000000e', tests.uid('coach'), 'POST_ANNOUNCEMENT', 'club', 'announcement live',    now() - interval '5 days'),
  ('c1200000-0000-4000-8000-00000000000f', tests.uid('coach'), 'POST_ANNOUNCEMENT', 'club', 'announcement stale',   now() - interval '6 days'),
  ('c1200000-0000-4000-8000-000000000010', tests.uid('coach'), 'POST_ANNOUNCEMENT', 'club', 'announcement expired', now() - interval '7 days'),
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

-- Two real announcements behind two of the cards, one live and one already
-- expired, linked the way every other linked card in this schema links:
-- through the metadata key, never through source_id (member_of_week_publish
-- writes source_type 'announcement' with a MEMBER_OF_WEEK id in source_id,
-- so source_id is the wrong thing to join announcements on).
insert into public.announcements (id, author_id, title, body, expires_at, created_at) values
  ('a1200000-0000-4000-8000-000000000001', tests.uid('coach'), 'live',    'still on', now() + interval '2 days', now() - interval '5 days'),
  ('a1200000-0000-4000-8000-000000000002', tests.uid('coach'), 'expired', 'over',     now() - interval '1 hour', now() - interval '7 days');
-- Since 202609220007 an announcement mints its own card on insert (the live
-- one does; the expired one is skipped). This file builds its cards by hand
-- so it controls every published_at, so the minted one is removed before the
-- hand-made card takes its announcement_id - one card per announcement is a
-- unique index now. 0124 tests the minted card itself.
delete from public.workout_posts
 where post_type = 'POST_ANNOUNCEMENT'
   and metadata ->> 'announcement_id' in ('a1200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000002');
update public.workout_posts
   set metadata = metadata || '{"announcement_id": "a1200000-0000-4000-8000-000000000001"}'::jsonb
 where id = 'c1200000-0000-4000-8000-00000000000e';
update public.workout_posts
   set metadata = metadata || '{"announcement_id": "a1200000-0000-4000-8000-000000000002"}'::jsonb
 where id = 'c1200000-0000-4000-8000-000000000010';

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
  $$ values ('pinned but old'),
            ('coach fresh'), ('announcement fresh'), ('announcement live'),
            ('wod today'),
            ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday'),
            ('coach stale'), ('announcement stale'), ('announcement expired') $$,
  'pinned, then the coach voice that is still current, then today''s WOD, then every other post newest first');

-- Said again as its own assertion, because it is the whole promise and a
-- reader should not have to derive it from the list above.
select results_eq(
  $$ select body from public.feed_page(null, 20, 'for_you') offset 5 $$,
  $$ values ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday'),
            ('coach stale'), ('announcement stale'), ('announcement expired') $$,
  'below the lifted tiers it is published_at descending and nothing else - yesterday''s WOD, and the coach voice that has aged out, are ordinary posts again');

-- The page boundary, which is where an order that sorts on two things at
-- once goes wrong: page one ends INSIDE the coach tier, so the cursor
-- carries a tier rather than a score and page two has to pick up at the
-- next post down - across two tier boundaries - without repeating or
-- dropping one.
select results_eq(
  $$ select body from public.feed_page(null, 3, 'for_you') $$,
  $$ values ('pinned but old'), ('coach fresh'), ('announcement fresh') $$,
  'a three-post page stops in the middle of the coach tier');
select results_eq(
  $$ select body from public.feed_page(
       (select next_cursor from public.feed_page(null, 3, 'for_you') limit 1), 3, 'for_you') $$,
  $$ values ('announcement live'), ('wod today'), ('stream newest') $$,
  'and the cursor picks up at the next post down, with nothing repeated and nothing skipped');

-- =====================================================================
-- 1b. the coach tier is bounded, and the bound is the club's own number
-- =====================================================================
-- Both halves of it, as their own assertions rather than left to be read
-- out of the long list above. Without a bound the top of the feed fills
-- with coach cards until the 90-day window drops them, and the order stops
-- meaning what it says. feed_score carries the TIER on a chronological
-- page, so it is the honest thing to assert on: 2 is the coach tier, 0 the
-- stream.
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'coach fresh' $$,
  $$ values (2::numeric) $$,
  'a coach post thirty minutes old is in the coach tier');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'coach stale' $$,
  $$ values (0::numeric) $$,
  'one four days old has fallen to the stream - dropped out of the lifted block, not off the page');

select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement live' $$,
  $$ values (2::numeric) $$,
  'an announcement five days old whose expires_at is still ahead stays lifted - the club said when it stops mattering');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement expired' $$,
  $$ values (0::numeric) $$,
  'one whose expires_at has passed is in the stream, and no number of hours brings it back');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement stale' $$,
  $$ values (0::numeric) $$,
  'and one with no announcement behind it falls back to the same hours a coach post gets');

-- THE NUMBER IS A CLUB SETTING, and this is what proves the tier reads it
-- rather than a constant that happens to be 72: move it to one hour and the
-- two-hour-old announcement leaves the lifted block while the
-- thirty-minute-old coach post stays.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"coach_top_hours": 1}'::jsonb) $$,
  'an admin shortens the coach tier to one hour');
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement fresh' $$,
  $$ values (0::numeric) $$,
  'the two-hour-old announcement is in the stream now');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'coach fresh' $$,
  $$ values (2::numeric) $$,
  'and the thirty-minute-old coach post is still lifted - the hours moved, nothing else did');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement live' $$,
  $$ values (2::numeric) $$,
  'the announcement with an expiry of its own does not consult the hours at all');

-- A rubbish value is not an outage here either: club_feature_number() falls
-- back to the shipped default, the same discipline club_feature_choice()
-- carries for the order.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"coach_top_hours": "soon"}'::jsonb) $$,
  'somebody writes a word where the hours belong');
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement fresh' $$,
  $$ values (2::numeric) $$,
  'and the feed is back on the shipped 72 hours rather than raising');

-- And the clamp is the server's: 100000 hours is not eleven years of lifted
-- coach posts, it is 336.
select tests.set_auth(tests.uid('owner'));
select lives_ok(
  $$ select public.admin_set_club_feature('feed', true, '{"coach_top_hours": 100000}'::jsonb) $$,
  'an admin types a number far outside the range');
select tests.set_auth(tests.uid('m2'));
select is(
  public.club_feature_number('feed', 'coach_top_hours', 72, 1, 336), 336::numeric,
  'the server clamps it to the top of the range rather than honouring it');
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement stale' $$,
  $$ values (2::numeric) $$,
  'so a six-day-old announcement IS lifted at the clamped 336 hours - the clamp is a real number, not a refusal');

select tests.set_auth(tests.uid('owner'));
select lives_ok( $$ select public.admin_set_club_feature('feed', true, '{}'::jsonb) $$,
  'the club clears the setting, which is how the panel says "use the shipped default"');
select tests.set_auth(tests.uid('m2'));
select results_eq(
  $$ select feed_score from public.feed_page(null, 20, 'for_you') where body = 'announcement stale' $$,
  $$ values (0::numeric) $$,
  'and 72 hours applies again');

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
  $$ values ('pinned but old'),
            ('coach fresh'), ('announcement fresh'), ('announcement live'),
            ('wod today'),
            ('stream newest'), ('stream middle'), ('stream oldest'), ('wod yesterday'),
            ('coach stale'), ('announcement stale'), ('announcement expired') $$,
  'the ranked page holds exactly the same posts - hidden, blocked, removed and deleted are out of both orders, and an aged-out coach post was never removed from either');

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
