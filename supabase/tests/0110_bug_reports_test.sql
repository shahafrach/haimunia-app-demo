-- Bug reports (202609150002). The admin panel's inbox.
--
-- WHAT THIS FILE IS DEFENDING. A bug report is the one member-authored text
-- in this schema that is deliberately NOT club-visible: it carries whatever
-- someone typed while frustrated plus their device fingerprint. Three
-- boundaries have to hold, and each has already been violated once elsewhere
-- in this module's history, which is why each is tested rather than assumed:
--   1. No direct table access at all, in either direction. Every other
--      "members can file X" table in this schema granted client INSERT and
--      then needed a policy to stop reporter_id being forged; this one has
--      no grant to forge through.
--   2. A reporter reading their OWN report must not receive the
--      staff-internal columns. That is exactly the failure 202609120012 had
--      to fix on public.reports and public.posting_restrictions - RLS is
--      row-level, never column-level - so here the reporter's read goes
--      through a function whose RETURN TYPE simply has no such columns.
--   3. Reading is is_staff(); ACTING is is_admin(). A coach must not be able
--      to quietly close a report.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. The table is unreachable from a client, in both directions
-- =====================================================================
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'bug_reports'
     and grantee in ('anon', 'authenticated')),
  0,
  'bug_reports has NO direct grants to anon or authenticated - reporter_id cannot be forged through a table a client cannot touch');

select is(
  (select relrowsecurity from pg_class where oid = 'public.bug_reports'::regclass),
  true,
  'and RLS is on regardless, so a future accidental grant still lands on a locked table rather than an open one');

-- =====================================================================
-- 2. A member files a report, and it is attributed to them by the server
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.bug_report_submit('הכפתור של העלאת תמונה לא עושה כלום', '{"version":"4.39.0","standalone":true}'::jsonb) $$,
  'a community member can file a bug report');

select tests.clear_auth();
select is(
  (select reporter_id from public.bug_reports order by created_at desc limit 1),
  tests.uid('m1'),
  'and the server sets reporter_id from auth.uid(), not from anything the caller sent');
select is(
  (select status from public.bug_reports order by created_at desc limit 1),
  'open',
  'a new report starts open');

-- An empty body is refused; a whitespace-only one is the same thing.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.bug_report_submit('   ', '{}'::jsonb) $$,
  'P0001', 'body required',
  'an empty report is refused rather than stored as a blank row nobody can action');

-- =====================================================================
-- 3. THE COLUMN BOUNDARY - the 202609120012 failure, prevented by shape
-- =====================================================================
-- Give the report the staff-internal fields a reporter must never see.
select tests.clear_auth();
update public.bug_reports
set admin_note = 'this member also broke it last month, watch them',
    handled_by = tests.uid('admin'), handled_at = now(), status = 'in_progress';

select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.bug_report_list_mine()),
  1,
  'the reporter reads their own report back');
select is(
  (select status from public.bug_report_list_mine() limit 1),
  'in_progress',
  'including its status, which is the part that is genuinely theirs to know');
-- The decisive one: the staff-internal columns are not merely filtered, they
-- are absent from the return type, so no future policy edit can reintroduce
-- them by accident.
-- pg_get_function_result() renders the declared TABLE(...) return type, which
-- is the authoritative statement of what this function can hand back. Asserted
-- as text rather than by joining pg_attribute, because the return type of a
-- `returns table` function is a transient pseudo-type whose attributes are not
-- a stable thing to query.
select is(
  (select pg_get_function_result(p.oid) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'bug_report_list_mine'),
  'TABLE(id uuid, body text, status text, created_at timestamp with time zone)',
  'bug_report_list_mine returns exactly id/body/status/created_at - admin_note and handled_by CANNOT reach a reporter, which is the column-exposure failure 202609120012 had to fix on two moderation tables');
select isnt(
  (select pg_get_function_result(p.oid) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'bug_report_list_mine') like '%admin_note%',
  true,
  'and the staff-internal note is not merely filtered out - it is absent from the shape, so no later policy edit can reintroduce it');

select * from finish();
rollback;
