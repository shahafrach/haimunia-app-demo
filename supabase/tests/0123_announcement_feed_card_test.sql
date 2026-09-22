-- An announcement becomes its own feed card (202609220006).
--
-- Four questions:
--
--   1. Does a coach publishing an announcement produce exactly one
--      POST_ANNOUNCEMENT card, through the real insert policy, carrying
--      metadata.announcement_id - the key the chronological feed's expiry
--      rule resolves through?
--   2. Does THE EXPIRY RULE apply to it? A card whose announcement is still
--      current is in the coach tier past the club's coach_top_hours; once
--      announcements.expires_at passes it falls to the stream. Both halves,
--      on the same card, by moving the announcement and nothing else.
--   3. Is nothing widened? A member still cannot publish an announcement, so
--      cannot mint a card; the announcements module off mints nothing; an
--      already-expired announcement mints nothing; the card is authorless,
--      so a member who blocked the coach sees it exactly as the archive
--      already shows them the announcement.
--   4. Does the card follow its announcement? An edit is copied, a withdraw
--      soft-deletes the card and takes it off the feed, and one announcement
--      is never two cards.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. a coach publishes, and the card exists
-- =====================================================================
select tests.set_auth(tests.uid('coach'));

select lives_ok(
  $$ insert into public.announcements (id, author_id, title, body, priority, expires_at)
     values ('a1230000-0000-4000-8000-000000000001', tests.uid('coach'),
             'Box closed Friday', 'card 0123 live', 'important', now() + interval '10 days') $$,
  'a coach publishes an announcement through the real insert policy');

select tests.clear_auth();

select results_eq(
  $$ select post_type::text, author_id, visibility::text, status::text, title, source_type::text, source_id
       from public.workout_posts where body = 'card 0123 live' $$,
  $$ values ('POST_ANNOUNCEMENT', null::uuid, 'club', 'active', 'Box closed Friday',
             'announcement', 'a1230000-0000-4000-8000-000000000001'::uuid) $$,
  'exactly one card: POST_ANNOUNCEMENT, authorless, club-visible, active, sourced from the announcement');

select results_eq(
  $$ select metadata ->> 'announcement_id', metadata ->> 'title', metadata ->> 'priority'
       from public.workout_posts where body = 'card 0123 live' $$,
  $$ values ('a1230000-0000-4000-8000-000000000001', 'Box closed Friday', 'important') $$,
  'the card names its announcement in metadata.announcement_id - the key the feed''s expiry rule reads');

select is(
  (select published_at from public.workout_posts where body = 'card 0123 live'),
  (select created_at from public.announcements where id = 'a1230000-0000-4000-8000-000000000001'),
  'the card is dated when the announcement was');

-- A 2000-character body is legal on the announcement; the card renders at
-- most 1000, so it is written at most 1000.
select tests.set_auth(tests.uid('coach'));
insert into public.announcements (id, author_id, title, body)
values ('a1230000-0000-4000-8000-000000000002', tests.uid('coach'), 'long', repeat('x', 2000));
select tests.clear_auth();
select is(
  (select char_length(body) from public.workout_posts
    where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002'),
  1000,
  'a long announcement''s card is capped at the 1000 characters a card renders');

-- The coach's post_create budget is not charged for it: the announcement is
-- the action, the card is its consequence.
select is_empty(
  $$ select 1 from public.rate_limits
      where user_id = tests.uid('coach') and action = 'post_create' $$,
  'publishing two announcements spent none of the coach''s post_create tokens');

-- =====================================================================
-- 2. the chronological feed's expiry rule applies to it
-- =====================================================================
-- Move the card to 5 days old, past the shipped 72-hour coach tier, so that
-- only the announcement's own expires_at can be holding it up.
update public.workout_posts
   set published_at = now() - interval '5 days'
 where body = 'card 0123 live';

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select feed_score from public.feed_page(null, 50, 'for_you') where body = 'card 0123 live' $$,
  $$ values (2::numeric) $$,
  'five days old, past coach_top_hours, and still in the coach tier: its announcement has not expired');

select tests.clear_auth();
update public.announcements
   set expires_at = now() - interval '1 minute'
 where id = 'a1230000-0000-4000-8000-000000000001';

select tests.set_auth(tests.uid('m1'));
select results_eq(
  $$ select feed_score from public.feed_page(null, 50, 'for_you') where body = 'card 0123 live' $$,
  $$ values (0::numeric) $$,
  'the announcement expires and the same card falls to the stream - no copy of expires_at had to be kept in step');

-- And the other direction: an announcement with no expiry takes the hours
-- fallback, like a coach post.
select results_eq(
  $$ select feed_score from public.feed_page(null, 50, 'for_you')
      where id = (select id from public.workout_posts
                   where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002') $$,
  $$ values (2::numeric) $$,
  'a fresh announcement with no expiry is in the coach tier on the hours fallback');

-- =====================================================================
-- 3. nothing is widened
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.announcements (author_id, title, body)
     values (tests.uid('m1'), 'not staff', 'card 0123 member') $$,
  '42501', null,
  'a member still cannot publish an announcement');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.workout_posts where body = 'card 0123 member' $$,
  'so a member cannot mint an announcement card either');

select tests.set_auth(tests.uid('coach'));
insert into public.announcements (author_id, title, body, expires_at, created_at)
values (tests.uid('coach'), 'late', 'card 0123 already over', now() - interval '1 hour', now() - interval '2 days');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.workout_posts where body = 'card 0123 already over' $$,
  'an announcement that is already expired when written gets no card - a member cannot read it, so the feed must not be the way to');

-- The module off: announcements_read serves nothing, so nothing is minted.
update public.club_features set enabled = false where module_key = 'announcements';
insert into public.announcements (author_id, title, body)
values (tests.uid('coach'), 'module off', 'card 0123 module off');
update public.club_features set enabled = true where module_key = 'announcements';
select is_empty(
  $$ select 1 from public.workout_posts where body = 'card 0123 module off' $$,
  'with the announcements module off, publishing mints no card');

-- A block does not hide the club's notice. m2 blocks the coach; the archive
-- (announcements_read, no block clause) still serves m2 the announcement, and
-- the feed serves m2 the card - the authorless card follows the archive's
-- rule rather than inventing a new one.
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('coach'));
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.announcements where id = 'a1230000-0000-4000-8000-000000000002' $$,
  'm2 blocked the coach and still reads the announcement in the archive');
select isnt_empty(
  $$ select 1 from public.feed_page(null, 50, 'for_you')
      where id = (select id from public.workout_posts
                   where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002') $$,
  'and still gets its card in the feed - the same answer, not a new visibility rule');

-- A member without a recovery method is not a community member: the card is
-- as unreadable to them as the announcement is.
select tests.set_auth(tests.uid('norec'));
select is_empty(
  $$ select 1 from public.workout_posts where post_type = 'POST_ANNOUNCEMENT'
       and metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002' $$,
  'a non-community session cannot read the card, exactly as it cannot read the announcement');
select tests.clear_auth();

-- =====================================================================
-- 4. the card follows its announcement
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
update public.announcements
   set title = 'Box closed Saturday', body = 'card 0123 edited', priority = 'urgent'
 where id = 'a1230000-0000-4000-8000-000000000002';
select tests.clear_auth();
select results_eq(
  $$ select title, body, metadata ->> 'title', metadata ->> 'priority'
       from public.workout_posts
      where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002' $$,
  $$ values ('Box closed Saturday', 'card 0123 edited', 'Box closed Saturday', 'urgent') $$,
  'an edit to the announcement is copied onto its card');

-- Withdrawn. No member session can soft-delete an announcement - the read
-- policy's deleted_at clause is applied to an UPDATE's new row, which 0079
-- pins - so the withdraw that exists is a staff one from outside the app.
-- The card must follow it whichever path makes it.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ update public.announcements set deleted_at = now()
      where id = 'a1230000-0000-4000-8000-000000000002' $$,
  '42501', null,
  'an app session still cannot soft-delete an announcement - this migration adds no withdraw path');
select tests.clear_auth();
select is(
  (select deleted_at from public.workout_posts
    where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002'),
  null,
  'so that refused attempt left the card where it was');

update public.announcements set deleted_at = now()
 where id = 'a1230000-0000-4000-8000-000000000002';
select isnt(
  (select deleted_at from public.workout_posts
    where metadata ->> 'announcement_id' = 'a1230000-0000-4000-8000-000000000002'),
  null,
  'the announcement is withdrawn and its card is soft-deleted with it');
select is(
  coalesce(current_setting('app.allow_moderation_write', true), ''), '',
  'the moderation pin the withdraw took is released, not left on for the rest of the transaction');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from public.feed_page(null, 50, 'for_you') where body = 'card 0123 edited' $$,
  'a withdrawn announcement is no longer on anybody''s feed');
select tests.clear_auth();

-- Deleted outright (the dashboard, a reset): the card goes too, rather than
-- staying behind with an announcement_id that names nothing.
select tests.set_auth(tests.uid('coach'));
insert into public.announcements (id, author_id, title, body)
values ('a1230000-0000-4000-8000-000000000003', tests.uid('coach'), 'gone', 'card 0123 hard deleted');
select tests.clear_auth();
delete from public.announcements where id = 'a1230000-0000-4000-8000-000000000003';
select isnt(
  (select deleted_at from public.workout_posts where body = 'card 0123 hard deleted'),
  null,
  'a hard-deleted announcement soft-deletes its card');

-- One announcement, one card: the unique index refuses a second.
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, body, metadata)
     values (null, 'POST_ANNOUNCEMENT', 'club', 'card 0123 duplicate',
             '{"announcement_id": "a1230000-0000-4000-8000-000000000001"}'::jsonb) $$,
  '23505', null,
  'a second card for the same announcement is refused');

select * from finish();
rollback;
