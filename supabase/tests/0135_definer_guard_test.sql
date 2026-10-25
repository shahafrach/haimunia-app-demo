-- Definer guard. Every SECURITY DEFINER function in schema public must be
-- pinned, closed to PUBLIC and anon, and reviewed by name and argument types.
--
-- A definer function runs with its owner's rights, so each one is a door past
-- RLS. docs/circles/decisions.md (Security) requires, for every one: an empty
-- search_path, EXECUTE revoked from PUBLIC and anon, and an entry in the
-- reviewed-functions table below. This file reads pg_proc, so a function added
-- later without all three fails the build.
--
-- MATCHING. By name AND argument types (oidvectortypes), not by name: a
-- `revoke` names a signature, so an old overload is a different function with
-- default privileges (the admin_actions_page lesson in 0113). It cannot hide
-- behind a reviewed sibling here.
--
-- CLASSES, assigned by reading each body (2026-10-25, after strip gym):
--   global_safe        touches no member's data on a caller's behalf: jobs,
--                      retention, plumbing, notification delivery.
--   caller_own_rows    reads or writes only rows keyed by auth.uid() (or the
--                      row a trigger is firing on).
--   needs_circle_scope reads or writes member data across members. Must be
--                      rewritten in the Circles RPCs session. Listed in the PR.
--
-- anon_allowed needs a reason. 0113 pins the anon-callable set itself; this
-- file pins that the review table agrees with it.
--
-- Adding a definer function: add a row here in the same change.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

create table tests.definer_reviewed (
  name text not null,
  args text not null,
  class text not null check (class in ('global_safe', 'caller_own_rows', 'needs_circle_scope')),
  anon_allowed boolean not null default false,
  reason text not null default '',
  primary key (name, args),
  check (not anon_allowed or reason <> '')
);

insert into tests.definer_reviewed (name, args, class, anon_allowed, reason) values
  ('ach_claim', 'text[]', 'caller_own_rows', false, ''),
  ('ach_share', 'uuid, text, jsonb, uuid', 'needs_circle_scope', false, 'publishes a post from the caller''s achievement; the post needs a circle'),
  ('analytics_events_guard_rate_limit', '', 'caller_own_rows', false, ''),
  ('bug_report_list_mine', '', 'caller_own_rows', false, ''),
  ('bug_report_submit', 'text, jsonb', 'caller_own_rows', false, ''),
  ('bug_reports_anonymize_on_user_delete', '', 'caller_own_rows', false, ''),
  ('bump_invite_attempt', 'text, uuid', 'caller_own_rows', false, ''),
  ('can_view_profile_field', 'uuid, text', 'needs_circle_scope', false, 'cross-member profile visibility predicate; becomes circle membership'),
  ('check_rate_limit', 'text, integer, integer', 'caller_own_rows', false, ''),
  ('clubs_guard_single_row', '', 'needs_circle_scope', false, 'single-club invariant; blocks circles until removed'),
  ('create_member_invite', 'timestamp with time zone, integer', 'needs_circle_scope', false, 'community-wide invite; becomes a per-circle invite'),
  ('cron_invoke_edge_function', 'text', 'global_safe', false, ''),
  ('edge_functions_ready', '', 'global_safe', false, ''),
  ('idem_begin', 'text, uuid, text', 'caller_own_rows', false, ''),
  ('idem_complete', 'text, uuid, jsonb', 'caller_own_rows', false, ''),
  ('idem_purge', 'interval', 'global_safe', false, ''),
  ('is_community_member', '', 'needs_circle_scope', false, 'membership predicate every member-data policy resolves through'),
  ('job_health_check', '', 'global_safe', false, ''),
  ('job_health_status', '', 'global_safe', true, 'monitoring workflow asks yes/no health with the publishable key; no args, returns ok, failing_count, last_checked_at (0113, 0116)'),
  ('mark_recovery_verified', '', 'caller_own_rows', false, ''),
  ('member_achievements_compute_verified', '', 'global_safe', false, ''),
  ('notif_batch_flush_due', 'integer', 'global_safe', false, ''),
  ('notif_batch_flushed', 'uuid, text', 'global_safe', false, ''),
  ('notif_blocked_between', 'uuid, uuid', 'needs_circle_scope', false, 'reads blocks between two members'),
  ('notif_create', 'uuid, text, text, text, text, text, uuid, text', 'global_safe', false, ''),
  ('notif_mark_read', 'uuid[]', 'caller_own_rows', false, ''),
  ('notif_on_achievement', '', 'caller_own_rows', false, ''),
  ('notif_on_reaction', '', 'needs_circle_scope', false, 'notifies a post author about another member''s reaction'),
  ('notif_on_training_partner_tag', '', 'needs_circle_scope', false, 'notifies a tagged member of another member''s post'),
  ('notif_pref_allows', 'uuid, text', 'global_safe', false, ''),
  ('notif_push_mark_sent', 'uuid[]', 'global_safe', false, ''),
  ('notif_push_pending', 'integer', 'global_safe', false, ''),
  ('notif_push_revoke', 'uuid[]', 'global_safe', false, ''),
  ('notif_queue_batched', 'uuid, text, text, uuid', 'global_safe', false, ''),
  ('post_create', 'text, post_visibility, jsonb, jsonb, uuid', 'needs_circle_scope', false, 'creates a post visible to other members; one circle per post'),
  ('post_delete', 'uuid', 'caller_own_rows', false, ''),
  ('post_edit_caption', 'uuid, text', 'caller_own_rows', false, ''),
  ('post_tag_training_partners', 'uuid, uuid[]', 'needs_circle_scope', false, 'tags other members on a post'),
  ('post_training_partner_remove', 'uuid, uuid', 'needs_circle_scope', false, 'edits another member''s tag on a post'),
  ('pr_share', 'text, text, jsonb, uuid', 'needs_circle_scope', false, 'publishes a PR post; the post needs a circle'),
  ('private_records_guard_rate_limit', '', 'caller_own_rows', false, ''),
  ('purge_abandoned_profiles', 'integer', 'global_safe', false, ''),
  ('purge_due_accounts', '', 'global_safe', false, ''),
  ('push_subscriptions_guard_count', '', 'caller_own_rows', false, ''),
  ('redeem_invite_code', 'text, text', 'needs_circle_scope', false, 'joins the community by invite; becomes join_circle'),
  ('request_account_deletion', '', 'caller_own_rows', false, ''),
  ('retention_purge_telemetry', 'integer', 'global_safe', false, ''),
  ('scheduled_job_health', '', 'global_safe', false, ''),
  ('toggle_reaction', 'uuid, uuid', 'needs_circle_scope', false, 'reacts to other members'' posts; gated by post_visible_to_viewer'),
  ('workout_posts_guard_insert_rate_limit', '', 'caller_own_rows', false, ''),
  ('workout_posts_guard_moderated_fields', '', 'caller_own_rows', false, ''),
  ('workout_posts_guard_privileged_type', '', 'global_safe', false, '');

-- The set under test: one row per definer function, keyed like the table.
create temp table definers on commit drop as
select p.oid, p.proname::text as name, pg_catalog.oidvectortypes(p.proargtypes)::text as args,
       p.proconfig, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef;

select ok((select count(*) from definers) > 0, 'the guard sees SECURITY DEFINER functions in public (it is not passing on an empty set)');

-- a. search_path pinned to the empty string.
select is_empty(
  $$ select name || '(' || args || ')' from definers
      where not coalesce(proconfig, '{}') @> array['search_path=""'] $$,
  'every SECURITY DEFINER function pins search_path to the empty string');

-- b. EXECUTE not held by PUBLIC. A null ACL is the default: PUBLIC may execute.
select is_empty(
  $$ select name || '(' || args || ')' from definers
      where proacl is null
         or exists (select 1 from aclexplode(proacl) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') $$,
  'every SECURITY DEFINER function has EXECUTE revoked from PUBLIC');

-- c. anon cannot execute, unless the review table says so with a reason.
select is_empty(
  $$ select d.name || '(' || d.args || ')' from definers d
      where has_function_privilege('anon', d.oid, 'execute')
        and not exists (select 1 from tests.definer_reviewed r
                         where r.name = d.name and r.args = d.args and r.anon_allowed) $$,
  'no SECURITY DEFINER function is executable by anon unless reviewed as anon_allowed');

-- The table cannot claim anon access that the database does not grant, so an
-- anon_allowed row cannot linger after its grant is gone.
select is_empty(
  $$ select r.name || '(' || r.args || ')' from tests.definer_reviewed r
       join definers d on d.name = r.name and d.args = r.args
      where r.anon_allowed and not has_function_privilege('anon', d.oid, 'execute') $$,
  'every anon_allowed row is a function anon can actually execute');

-- d. reviewed, both directions.
select is_empty(
  $$ select d.name || '(' || d.args || ')' from definers d
      where not exists (select 1 from tests.definer_reviewed r
                         where r.name = d.name and r.args = d.args) $$,
  'every SECURITY DEFINER function in public appears in tests.definer_reviewed by name and arguments');

select is_empty(
  $$ select r.name || '(' || r.args || ')' from tests.definer_reviewed r
      where not exists (select 1 from definers d
                         where d.name = r.name and d.args = r.args) $$,
  'every tests.definer_reviewed row is a live SECURITY DEFINER function (no stale rows)');

select * from finish();
rollback;
