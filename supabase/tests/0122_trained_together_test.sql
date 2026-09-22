-- 202609220005 "התאמנו יחד" — real enforcement, in Postgres.
--
-- Boundaries this file pins:
--   * post_training_partners is SELECT-only for every client role. Nobody
--     inserts, updates or deletes a row directly — not the post author, not
--     the tagged member, not a coach.
--   * The read policy. The tagged member always reads their own tag, even on
--     a post they can no longer see, because a tag you cannot see is a tag
--     you cannot remove. Everyone else reads it only when they can read the
--     post AND can_view_profile_field(tagged, 'visible_to_club') — which is
--     false across a block edge in either direction, false for a hidden
--     member and false for a deleted one. With the module off, nobody reads
--     anything, the author included.
--   * post_tag_training_partners(): author-only, POST_WORKOUT-only, active
--     posts only; refuses while the module is off; caps at 10 and RAISES
--     rather than trimming; drops self silently; SKIPS rather than raises a
--     target with allow_mentions off, a target behind a block edge and a
--     target hidden from the club; and is a SET write, so a name dropped
--     from the list is deleted. A re-save of the same list writes nothing
--     and therefore notifies nobody twice.
--   * post_training_partner_remove(): the tagged member on their own tag,
--     the author on any tag on their post, nobody else — a coach included;
--     null p_user_id means the caller; idempotent; and it still works when
--     the module has since been switched off, which is the whole reason it
--     carries no module gate.
--   * The notification. One 'trained_together' row per accepted tag, to the
--     tagged member, deep-linked at the post.
--   * The generalisation. attendance_classmates_today() now delegates to
--     attendance_classmates_on(current_date, ...) and answers identically —
--     the assertion that keeps the two from becoming two algorithms.
--   * Neither new entry point is executable by anon.
--
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- The module ships OFF (202609220005 seeds it that way on purpose), so every
-- assertion about the feature working has to turn it on first. The last
-- section turns it back off and re-asserts, which is the other half.
update public.club_features set enabled = true
  where club_id = public.default_club_id() and module_key = 'trained_together';

-- --- fixtures ---------------------------------------------------------
-- m1 authors a workout post the whole club can read, and a second one only
-- they can. m1 also authors a TEXT post, which must never be taggable.
insert into public.workout_posts (id, author_id, post_type, visibility, title, occurred_on) values
  ('7a220000-0000-4000-8000-000000000001', tests.uid('m1'), 'POST_WORKOUT', 'club',    'Fran', current_date),
  ('7a220000-0000-4000-8000-000000000002', tests.uid('m1'), 'POST_WORKOUT', 'only_me', 'Grace', current_date),
  ('7a220000-0000-4000-8000-000000000003', tests.uid('m1'), 'POST_TEXT',    'club',    null, null);
-- m2 authors one of their own, so "the author and nobody else" has a second
-- author to be refused against.
insert into public.workout_posts (id, author_id, post_type, visibility, title, occurred_on) values
  ('7a220000-0000-4000-8000-000000000004', tests.uid('m2'), 'POST_WORKOUT', 'club', 'Helen', current_date);

-- 'norec' is this suite's allow_mentions-off member, the same role it plays
-- in 0021. m3 is the blocked one — the block edge is created later, so the
-- earlier assertions can use m3 as an ordinary accepted target first.
update public.profiles set allow_mentions = false where id = tests.uid('norec');

-- =====================================================================
-- The table is select-only, for everybody
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.post_training_partners (post_id, tagged_user_id, tagged_by)
     values ('7a220000-0000-4000-8000-000000000001', tests.uid('m2'), tests.uid('m1')) $$,
  '42501',
  null,
  'the post author cannot insert a post_training_partners row directly');
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ update public.post_training_partners set created_at = now() $$,
  '42501',
  null,
  'a coach cannot update post_training_partners directly');
select throws_ok(
  $$ delete from public.post_training_partners $$,
  '42501',
  null,
  'a coach cannot delete post_training_partners directly');

-- =====================================================================
-- post_tag_training_partners: who may call it, and on what
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m3')]) $$,
  'P0001', 'not authorized',
  'a member who is not the author cannot tag partners on somebody else''s post');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m3')]) $$,
  'P0001', 'not authorized',
  'a coach cannot tag partners on a member''s post either - this is the author speaking, not staff');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000003',
       array[tests.uid('m2')]) $$,
  'P0001', 'training partners are for workout posts',
  'a text post cannot carry training partners');
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-00000000000f',
       array[tests.uid('m2')]) $$,
  'P0001', 'post not found',
  'a post that does not exist is not taggable');
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3'), tests.uid('norec'), tests.uid('coach'),
             tests.uid('owner'), tests.uid('admin'), tests.uid('m2'), tests.uid('m3'),
             tests.uid('coach'), tests.uid('owner'), tests.uid('admin')]) $$,
  'P0001', 'at most 10 training partners per post',
  'eleven targets raises - a post naming a crowd is a fan-out, not a memory of a class');

-- =====================================================================
-- The accept / skip rules
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3'), tests.uid('norec'), tests.uid('m1')]) $$,
  'a call mixing accepted targets, an allow_mentions-off target and the author themselves is accepted');

select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m2') $$,
  'an ordinary target was tagged');
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a second ordinary target was tagged in the same call');
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('norec') $$,
  'a target with allow_mentions off was SKIPPED, and the rest of the call still landed');
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m1') $$,
  'the author is never tagged on their own post, even when named explicitly');
select is(
  (select count(*)::int from public.post_training_partners
    where post_id = '7a220000-0000-4000-8000-000000000001'),
  2,
  'exactly the two accepted targets are on the post');
select is(
  (select tagged_by from public.post_training_partners
    where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m2')),
  tests.uid('m1'),
  'tagged_by records who did the tagging');

-- The notification, one per accepted tag and none for the skipped one.
select is(
  (select count(*)::int from public.notifications
    where type = 'trained_together' and source_id = '7a220000-0000-4000-8000-000000000001'),
  2,
  'one trained_together notification per accepted tag, and none for the skipped target');
select isnt_empty(
  $$ select 1 from public.notifications
     where type = 'trained_together' and user_id = tests.uid('m2')
       and source_type = 'post'
       and deep_link = '/community/feed?post=7a220000-0000-4000-8000-000000000001' $$,
  'the tagged member''s notification deep-links at the post');
select is_empty(
  $$ select 1 from public.notifications
     where type = 'trained_together' and user_id = tests.uid('m1') $$,
  'the author is never notified about their own tagging');

-- =====================================================================
-- SET semantics: a name dropped from the list is removed, and re-saving
-- an unchanged list writes nothing (so it notifies nobody twice)
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3')]) $$,
  're-saving the same accepted list is accepted');
select tests.clear_auth();
select is(
  (select count(*)::int from public.notifications
    where type = 'trained_together' and source_id = '7a220000-0000-4000-8000-000000000001'),
  2,
  're-saving an unchanged list inserts no row and therefore notifies nobody a second time');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2')]) $$,
  'saving a shorter list is accepted');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a name dropped from the list is deleted - this is a set write, not an append');
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m2') $$,
  'a name kept in the list survives the same call');

-- Empty list clears the post, and is not an error.
select tests.set_auth(tests.uid('m1'));
select is(
  (select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000002', array[]::uuid[])),
  0,
  'an empty list on an untagged post is a no-op that returns zero');

-- =====================================================================
-- Blocks, on the write path
-- =====================================================================
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m1'), tests.uid('m3'));

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3')]) $$,
  'a call naming a blocked member is accepted rather than refused');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a member the author has blocked cannot be tagged - can_view_profile_field settles the edge');

-- The other direction of the same edge.
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m1') and blocked_id = tests.uid('m3');
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3')]) $$,
  'a call naming a member who has blocked the author is accepted');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a member who has blocked the author cannot be tagged either - the edge is settled in both directions');
delete from public.blocks where blocker_id = tests.uid('m3') and blocked_id = tests.uid('m1');

-- visible_to_club, on the write path.
select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m3');
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3')]) $$,
  'a call naming a member hidden from the club is accepted');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a member hidden from the club cannot be tagged - can_view_profile_field requires visible_to_club first');
update public.profiles set visible_to_club = true where id = tests.uid('m3');

-- =====================================================================
-- The read policy
-- =====================================================================
-- Back to a known state: m2 and m3 tagged on the club-visible post, and m2
-- tagged on the only_me post as well.
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2'), tests.uid('m3')]) $$,
  'both members are tagged on the club-visible post');
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000002',
       array[tests.uid('m2')]) $$,
  'one member is tagged on the author-only post');

select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.post_training_partners
    where post_id = '7a220000-0000-4000-8000-000000000001'),
  2,
  'the author reads both tags on their own post');

select tests.set_auth(tests.uid('coach'));
select is(
  (select count(*)::int from public.post_training_partners
    where post_id = '7a220000-0000-4000-8000-000000000001'),
  2,
  'a third member who can read the post reads the tags on it');
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000002' $$,
  'a third member reads no tags on a post they cannot read - the policy leans on workout_posts'' own RLS');

select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000002' and tagged_user_id = tests.uid('m2') $$,
  'the TAGGED member reads their own tag on a post they cannot otherwise read - a tag you cannot see is a tag you cannot remove');

-- A block between the viewer and a TAGGED member hides that member's tag
-- from them, without hiding the post or the other tag.
select tests.clear_auth();
insert into public.blocks (blocker_id, blocked_id) values (tests.uid('coach'), tests.uid('m3'));
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a viewer does not see a tag naming a member they have blocked');
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m2') $$,
  'the other tag on the same post is unaffected');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('coach') and blocked_id = tests.uid('m3');

-- visible_to_club, on the read path.
select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m3');
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'a member hidden from the club is not named on a post a third member is reading');
select tests.set_auth(tests.uid('m3'));
select isnt_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'that member still reads their own tag while hidden - hiding from the club is not hiding from yourself');
select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m3');

-- =====================================================================
-- Removal
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001', tests.uid('m2')) $$,
  'P0001', 'not authorized',
  'a third member - a coach included - cannot remove somebody else''s tag');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001') $$,
  'the tagged member removes their own tag, naming nobody');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m3') $$,
  'null p_user_id means the caller, and the row is gone');

select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001') $$,
  'removing a tag that is already gone is a silent no-op');

select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001', tests.uid('m2')) $$,
  'the post author removes a tag they placed');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' $$,
  'the post carries no tags afterwards');

-- The author of ANOTHER post cannot reach into this one.
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m2')]) $$,
  'the post is tagged again, for the cross-post check');
select tests.set_auth(tests.uid('m2'));
select throws_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001', tests.uid('m3')) $$,
  'P0001', 'not authorized',
  'being the author of a DIFFERENT post buys nothing here');

-- =====================================================================
-- The module switch
-- =====================================================================
select tests.clear_auth();
update public.club_features set enabled = false
  where club_id = public.default_club_id() and module_key = 'trained_together';

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.post_tag_training_partners('7a220000-0000-4000-8000-000000000001',
       array[tests.uid('m3')]) $$,
  'P0001', 'trained_together disabled',
  'the writer refuses outright while the module is off');
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' $$,
  'with the module off the AUTHOR reads no tags on their own post - off means unqueryable, not merely unrendered');
select tests.set_auth(tests.uid('m2'));
select is_empty(
  $$ select 1 from public.post_training_partners where tagged_user_id = tests.uid('m2') $$,
  'with the module off the tagged member reads nothing either');

-- ...and removal still works, which is the point of leaving it ungated.
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.post_training_partner_remove('7a220000-0000-4000-8000-000000000001') $$,
  'a tagged member can still take their name off after the club switched the module off');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.post_training_partners
     where post_id = '7a220000-0000-4000-8000-000000000001' and tagged_user_id = tests.uid('m2') $$,
  'and the row really is gone, module or no module');

update public.club_features set enabled = true
  where club_id = public.default_club_id() and module_key = 'trained_together';

-- =====================================================================
-- attendance_classmates_today() is attendance_classmates_on(current_date)
-- =====================================================================
-- The assertion that stops these becoming two algorithms. m1 and m2 both
-- trained today and both show attendance; m3 trained today and does not.
select tests.clear_auth();
update public.profiles set show_attendance = true where id in (tests.uid('m1'), tests.uid('m2'));
update public.profiles set show_attendance = false where id = tests.uid('m3');
insert into public.attendance_log (user_id, occurred_on, recorded_at) values
  (tests.uid('m1'), current_date, now()),
  (tests.uid('m2'), current_date, now()),
  (tests.uid('m3'), current_date, now()),
  (tests.uid('m1'), current_date - 1, now()),
  (tests.uid('m3'), current_date - 1, now());

select tests.set_auth(tests.uid('m1'));
select is(
  (select array_agg(x order by x) from (select public.attendance_classmates_today(6) as x) s),
  (select array_agg(x order by x) from (select public.attendance_classmates_on(current_date, 6) as x) s),
  'attendance_classmates_today() answers exactly what attendance_classmates_on(current_date) does');
select is(
  (select count(*)::int from (select public.attendance_classmates_on(current_date, 6)) s),
  1,
  'only the classmate who opted into showing attendance comes back for today');
select is_empty(
  $$ select 1 from (select public.attendance_classmates_on(current_date - 1, 6)) s $$,
  'yesterday: the only other member who trained had show_attendance off, so the day is empty rather than wrong');

-- The caller's own opt-out is still an empty set, never a raise, on the
-- generalised form too.
select tests.clear_auth();
update public.profiles set show_attendance = false where id = tests.uid('m1');
select tests.set_auth(tests.uid('m1'));
select is_empty(
  $$ select 1 from (select public.attendance_classmates_on(current_date, 6)) s $$,
  'a caller who has not opted into showing attendance gets an empty set from the generalised form as well');
select tests.clear_auth();
update public.profiles set show_attendance = true where id = tests.uid('m1');

-- =====================================================================
-- anon reaches none of it
-- =====================================================================
select is(
  (select count(*)::int from information_schema.role_routine_grants
    where grantee = 'anon' and specific_schema = 'public'
      and routine_name in (
        'post_tag_training_partners', 'post_training_partner_remove',
        'post_training_partners_for', 'attendance_classmates_on',
        'notif_on_training_partner_tag')),
  0,
  'none of 202609220005''s functions is executable by anon');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee in ('anon', 'PUBLIC') and table_schema = 'public'
      and table_name = 'post_training_partners'),
  0,
  'anon holds no grant of any kind on post_training_partners');
-- authenticated reads and does nothing else. Stated as the three write
-- privileges rather than as "SELECT and nothing else": Supabase's own
-- default privileges hand every new public table REFERENCES, TRIGGER and
-- TRUNCATE to authenticated as well, so an exact-set assertion here would
-- fail on comment_mentions and every other select-only table in this schema
-- too, which is a statement about the platform's defaults and not about
-- this migration.
select is(
  (select count(*)::int from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'post_training_partners'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  'authenticated may not insert, update or delete post_training_partners - the two functions are the only write paths');
-- ...and the positive half, plus the guard that keeps this table shaped like
-- the select-only table it was modelled on. A future migration that widens
-- one of them should have to widen the other deliberately.
select is(
  (select string_agg(privilege_type, ',' order by privilege_type)
     from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'post_training_partners'),
  (select string_agg(privilege_type, ',' order by privilege_type)
     from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public' and table_name = 'comment_mentions'),
  'post_training_partners carries exactly the grants comment_mentions does - the select-only table it is modelled on');

select * from finish();
rollback;
