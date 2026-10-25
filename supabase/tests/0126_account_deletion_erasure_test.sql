-- Account deletion for an account that has no profile (202609230002, B5).
--
-- A delete button on the backup panel calls the existing
-- request_account_deletion(); 0064 covers that function for an account with a
-- profile, and this file covers it for one without.
--
-- The storage erasure queue, the activity_pings / feed_interactions purge and
-- the moderation-reason redaction that used to be tested here went with their
-- tables in 202610250001 (strip gym).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 4. A backup-only account (no profile) can request deletion
-- =====================================================================
insert into auth.users (instance_id, id, aud, role, is_anonymous, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0125-4000-8000-000000000001',
        'authenticated', 'authenticated', true, now(), now());
select tests.set_auth('bbbbbbbb-0125-4000-8000-000000000001');
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'an anonymous backup account with no profile can call request_account_deletion()');
select tests.clear_auth();
select is(
  (select count(*)::int from public.account_deletion_requests
    where user_id = 'bbbbbbbb-0125-4000-8000-000000000001'
      and purge_after > now() + interval '29 days'),
  1,
  'and it is scheduled for the same 30-day purge as everyone else');

select * from finish();
rollback;
