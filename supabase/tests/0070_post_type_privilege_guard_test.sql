-- Launch-readiness audit, finding 4 (202609060004). A member cannot award
-- themselves a staff post_type.
--
-- THE TWO VECTORS THIS FILE REPRODUCES, both verified live against a plain
-- member with no role and no permissions, and both refused now:
--
--   insert into public.workout_posts (author_id, post_type)
--     values (me, 'POST_COACH');
--   update public.workout_posts set post_type = 'POST_COACH'
--     where id = <a post I already own>;
--
-- posts_insert_self and posts_update_self gate the author of a row and say
-- nothing about post_type; default_post_type() only fills the column when it
-- arrives NULL. The label carries the "מאמן/ת" badge, 10 of feed_page's 110
-- ranking points, and membership of the `coach` feed scope.
--
-- The privileged set is four labels, not one, because the other three are
-- worth at least as much: POST_ANNOUNCEMENT shares the coach ranking weight
-- and the coach scope, POST_SYSTEM and POST_NEW_MEMBER are scored as
-- 'system' by feed_page's own diversity bucketing.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. The trigger exists, on both events, on the right column
-- =====================================================================
select is(
  (select count(*)::int from pg_catalog.pg_trigger
   where tgrelid = 'public.workout_posts'::regclass
     and tgname::text = 'workout_posts_guard_privileged_type'), 1,
  'the guard trigger is installed on workout_posts');
select is(
  (select prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'workout_posts_guard_privileged_type'), true,
  'and is security definer - it reads invite_redemptions and profiles for an author who is not the caller');
select is(
  (select has_function_privilege('authenticated', 'public.workout_posts_guard_privileged_type()', 'execute')), false,
  'and is callable by no client role');

-- =====================================================================
-- 2. THE INSERT VECTOR
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.workout_posts (id, author_id, post_type, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_COACH', 'club', 'Fake coach note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'THE FIX, vector 1: a plain member can no longer INSERT a POST_COACH row under their own name');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_ANNOUNCEMENT', 'club', 'Fake announcement', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_ANNOUNCEMENT, which carries the same +10 coach weight and the same coach feed scope');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_SYSTEM', 'club', 'Fake system note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_SYSTEM');
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('m1'), 'POST_NEW_MEMBER', 'club', 'Fake welcome', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'nor POST_NEW_MEMBER');

-- Putting somebody else's uid in author_id is not a way round it either.
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('coach'), 'POST_COACH', 'club', 'Ghost-written', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'and attributing it to somebody else is refused too - the trigger runs before posts_insert_self, and either boundary alone would stop it');

-- =====================================================================
-- 3. THE UPDATE VECTOR - the one a WITH CHECK could not have closed
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000002', tests.uid('m1'), 'club', 'An ordinary post', 'x', current_date) $$,
  'a member creates an ordinary post, which default_post_type() files as POST_TEXT');
select throws_ok(
  $$ update public.workout_posts set post_type = 'POST_COACH'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'P0001',
  'post type is staff only',
  'THE FIX, vector 2: and cannot promote it afterwards - this is the half an UPDATE policy''s WITH CHECK structurally cannot express, since it sees only the new row');
select is(
  (select post_type::text from public.workout_posts where id = '40700000-0000-4000-8000-000000000002'),
  'POST_TEXT',
  'and the row still carries the type it was filed under');

-- =====================================================================
-- 4. What a member CAN still do
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ update public.workout_posts set post_type = 'POST_PHOTO'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'an unprivileged post_type is untouched by the guard - this closes four labels, it does not freeze the column');
select lives_ok(
  $$ update public.workout_posts set body = 'edited'
     where id = '40700000-0000-4000-8000-000000000002' $$,
  'and an edit that does not name post_type at all never fires the trigger');

-- =====================================================================
-- 5. Nobody holds staff status any more
-- =====================================================================
-- The staff exemption (a coach redemption, profiles.is_admin) went with the
-- staff features in 202610250001: is_staff()/is_admin() are stubs returning
-- false, and the guard no longer consults the is_admin column either.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ insert into public.workout_posts (id, author_id, post_type, visibility, title, result_text, occurred_on)
     values ('40700000-0000-4000-8000-000000000003', tests.uid('coach'), 'POST_COACH', 'club', 'Real coach note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'a member redeemed with the old coach role is refused too');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, title, result_text, occurred_on)
     values (tests.uid('admin'), 'POST_ANNOUNCEMENT', 'club', 'Admin note', 'x', current_date) $$,
  'P0001',
  'post type is staff only',
  'and so is a profile still carrying is_admin - the column is not a way past the guard');

-- =====================================================================
-- 6. The author_id IS NULL exemption - the load-bearing one
-- =====================================================================
-- A server-authored label is an authorless row; the guard lets those through
-- because a migration or the service role is the only thing that can write one.
select tests.clear_auth();
select lives_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, body, status, published_at)
     values (null, 'POST_NEW_MEMBER', 'club', 'server authored', 'active', now()) $$,
  'an authorless POST_NEW_MEMBER still inserts - this is the shape a server-side producer writes');
select lives_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, body, status, published_at)
     values (null, 'POST_ANNOUNCEMENT', 'club', 'server authored', 'active', now()) $$,
  'and an authorless POST_ANNOUNCEMENT');

select * from finish();
rollback;
