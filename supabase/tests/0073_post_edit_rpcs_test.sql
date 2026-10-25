-- Launch-readiness audit, finding 8 (202609060007). post_edit_caption() and
-- post_set_visibility() exist now.
--
-- WHAT WAS BROKEN. contracts.md has documented both since Phase 1, sitting
-- immediately above post_delete's "Shipped in 202608280025" entry, and
-- cloud.js has a complete wired UI for both - the own-post menu's
-- "עריכת כיתוב" and "שינוי נראוּת" items, calling client.rpc() by these exact
-- names with these exact argument names. Neither function had ever been
-- created, so both buttons answered PGRST202 and showed a failure toast.
--
-- ARGUMENT NAMES. post_id / body / visibility, unprefixed, because PostgREST
-- resolves an RPC by argument NAME - these are the names the shipped client
-- sends and the names contracts.md published. Asserted first, below, since a
-- correct function with the wrong parameter names is still an unreachable
-- one.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into public.workout_posts (id, author_id, post_type, visibility, body, status, published_at, occurred_on)
values
  ('40730000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_TEXT', 'club', 'original caption', 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000002', tests.uid('m1'), 'POST_PHOTO', 'club', null, 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000003', tests.uid('m2'), 'POST_TEXT', 'club', 'not yours', 'active', now(), current_date),
  ('40730000-0000-4000-8000-000000000004', tests.uid('m1'), 'POST_TEXT', 'club', 'already gone', 'removed', now(), current_date);
-- =====================================================================
-- 1. The signatures the client actually calls
-- =====================================================================
select is(
  (select pg_catalog.pg_get_function_identity_arguments(p.oid)
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_edit_caption'),
  'post_id uuid, body text',
  'post_edit_caption takes (post_id uuid, body text) - the names PostgREST resolves on, which is what makes the already-shipped button reach it');
select is(
  (select prosecdef from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_edit_caption'), true,
  'post_edit_caption is security definer...');
select is(
  (select has_function_privilege('anon', 'public.post_edit_caption(uuid, text)', 'execute')), false,
  '...and not executable by anon');
select is(
  (select has_function_privilege('authenticated', 'public.post_edit_caption(uuid, text)', 'execute')), true,
  'while authenticated can call it, which is the whole point');
select is(
  (select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_set_visibility'), 0,
  'and post_set_visibility is gone - visibility is no longer a per-post choice');

-- =====================================================================
-- 2. post_edit_caption: the happy path
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'edited caption') $$,
  'the author edits their own caption');
select is(
  (select body from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'),
  'edited caption',
  'and the body really changed');
select ok(
  (select updated_at from public.workout_posts where id = '40730000-0000-4000-8000-000000000001') >= now() - interval '1 minute',
  'and updated_at was stamped by the workout_posts_touch trigger, so an edit is never silent even without an edited_at column');

-- Normalisation is post_create's, character for character. Two functions
-- normalising one column differently is how a post that was legal to create
-- becomes illegal to edit.
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001',
       '  ' || chr(7) || 'bell stripped, ' || chr(9) || 'tab kept' || chr(10) || 'newline kept  ') $$,
  'control characters are stripped and the value trimmed...');
select is(
  (select body from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'),
  'bell stripped, ' || chr(9) || 'tab kept' || chr(10) || 'newline kept',
  '...with tab and newline deliberately kept, because the card renders the body white-space: pre-wrap - identical to post_create');
select lives_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', repeat('x', 1500)) $$,
  'an over-long caption is accepted...');
select is(
  (select char_length(body) from public.workout_posts where id = '40730000-0000-4000-8000-000000000001'), 1000,
  '...and capped at 1000, the same cap post_create applies');

-- =====================================================================
-- 3. post_edit_caption: every refusal
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'hijacked') $$,
  'P0001',
  'not authorized',
  'a member cannot edit somebody else''s post - author only, as contracts.md says, with no moderator branch (a moderator removes, they do not rewrite)');
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-00000000ffff', 'x') $$,
  'P0001',
  'post not found',
  'a post that does not exist raises rather than silently doing nothing');
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000004', 'x') $$,
  'P0001',
  'post is no longer editable',
  'and a removed post cannot be edited back into circulation');
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', '   ') $$,
  'P0001',
  'a post needs text or at least one photo',
  'a text-only post cannot be emptied - post_create''s rule, asked the other way round');
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000002', '') $$,
  'P0001',
  'a post needs text or at least one photo',
  'and there are no photos left to carry a post without text, so a caption cannot be dropped entirely either');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select public.post_edit_caption('40730000-0000-4000-8000-000000000001', 'x') $$,
  'P0001',
  'not authorized',
  'a member with no verified recovery method is refused - here as a non-author, since the author check comes first');

select * from finish();
rollback;
