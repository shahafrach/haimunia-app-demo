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
--   circle_scoped      acts on a circle (or on a post or tag, which has one) named
--                      by an argument, and checks that the caller is a member (or
--                      owner) of exactly that circle first. 0139 pins, per
--                      function, that a member of circle A cannot act on circle B.
--
-- There is no needs_circle_scope class any more: the Circles RPCs session
-- rewrote the twelve functions that held it, and the check constraint below no
-- longer allows the value, so one cannot be added back unnoticed.
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
  class text not null check (class in ('global_safe', 'caller_own_rows', 'circle_scoped')),
  anon_allowed boolean not null default false,
  reason text not null default '',
  primary key (name, args),
  check (not anon_allowed or reason <> '')
);

insert into tests.definer_reviewed (name, args, class, anon_allowed, reason) values
  ('is_club_staff', 'uuid', 'caller_own_rows', false, 'RLS helper: is the caller the owner or coach of this club-type circle; reads only the caller''s own membership row (202611120001)'),
  ('rotate_club_link', 'uuid', 'circle_scoped', false, 'owner or coach of ONE club replaces its join link; 5 a day (202611120001)'),
  ('club_announcement_post', 'uuid, text, boolean', 'circle_scoped', false, 'owner or coach of ONE club posts an announcement there; no notification; 10 a day (202611120001)'),
  ('club_announcement_set_pinned', 'uuid, boolean', 'circle_scoped', false, 'owner or coach of the announcement''s own club pins or unpins it (202611120001)'),
  ('club_announcement_delete', 'uuid', 'circle_scoped', false, 'owner or coach of the announcement''s own club deletes it (202611120001)'),
  ('transfer_put', 'text, text, text, text', 'global_safe', false, 'transfer-put Edge Function only (service_role): stores one opaque ciphertext under a lookup hash; refuses plaintext; per-IP and global caps (202611120001)'),
  ('transfer_take', 'text, text', 'global_safe', false, 'transfer-take Edge Function only (service_role): deletes and returns one ciphertext by lookup hash, at most once, within 24 hours; per-IP limit (202611120001)'),
  ('transfer_purge', '', 'global_safe', false, 'cron job: deletes transfer blobs older than 24 hours and old attempt windows (202611120001)'),
  ('training_log_usage_before_insert', '', 'global_safe', false, 'trigger: stamps day and app on an anonymous usage count, drops repeats and caps 2,000 a day; counts every row, so definer (202611120001)'),
  ('training_log_usage_report', 'integer', 'global_safe', false, 'owner-only: granted to no role and refuses any call with an auth.uid(); totals only, never a row (202611120001)'),
  ('training_log_usage_purge', '', 'global_safe', false, 'cron job: deletes usage counts older than 400 days (202611120001)'),
  ('owner_create_club', 'text, text, text', 'global_safe', false, 'owner-only: granted to no role and refuses any call with an auth.uid(); creates the one club with the named account as owner (202611120001)'),
  ('owner_set_coach', 'text', 'global_safe', false, 'owner-only: granted to no role and refuses any call with an auth.uid(); makes one club member the coach (202611120001)'),
  ('owner_set_club_owner', 'text', 'global_safe', false, 'owner-only: granted to no role and refuses any call with an auth.uid(); makes one club member the owner (202611120001)'),
  ('my_pending_reset', '', 'caller_own_rows', false, 'lost-code reset: the caller''s own open request, ready_at and created_at only (202611100001)'),
  ('cancel_my_reset', '', 'caller_own_rows', false, 'lost-code reset: cancels the caller''s own open request and blocks new ones for 24 hours; permanent accounts only (202611100001)'),
  ('reset_notify_requested', 'uuid, timestamp with time zone', 'global_safe', false, 'lost-code reset: one personal reset_requested notification for the account; service_role only (202611100001)'),
  ('aal_satisfied', '', 'caller_own_rows', false, 'RLS helper: does the caller''s session meet its second step; reads only the caller''s own verified factors (202611070002)'),
  ('ach_claim', 'text[]', 'caller_own_rows', false, ''),
  ('notif_on_pr_post', '', 'circle_scoped', false, 'trigger: tells the OTHER members of the post''s own circle that a member posted a personal record; notif_create re-checks membership and blocks; never in a club (202611120001)'),
  ('reminder_push_due', 'timestamp with time zone', 'global_safe', false, 'cron job: writes content-free personal reminder rows for members whose chosen day and time it is; service_role only'),
  ('ach_share', 'uuid, uuid, text, uuid', 'circle_scoped', false, 'publishes a post in ONE circle the caller is a member of'),
  ('analytics_events_guard_rate_limit', '', 'caller_own_rows', false, ''),
  ('bootstrap_owner_invite', '', 'global_safe', false, 'owner-only: granted to no role, so only the SQL editor (postgres) can call it; refuses any call that carries an auth.uid(); mints one one-hour, one-use invite_codes row (202610290001)'),
  ('bug_report_list_mine', '', 'caller_own_rows', false, ''),
  ('bug_report_submit', 'text, jsonb', 'caller_own_rows', false, ''),
  ('bug_reports_anonymize_on_user_delete', '', 'caller_own_rows', false, ''),
  ('bump_invite_attempt', 'text, uuid', 'caller_own_rows', false, ''),
  ('can_view_profile_field', 'uuid, text', 'caller_own_rows', false, 'true for me or someone who shares a circle with me; reads only the caller''s own memberships (circles schema)'),
  ('check_rate_limit', 'text, integer, integer', 'caller_own_rows', false, ''),
  ('circle_members_guard', '', 'global_safe', false, 'trigger: member and circle limits (2 couple, 20 friends, 250 club, 10 circles per person) and the club''s one owner; counts every row, so definer (202611120001)'),
  ('cron_invoke_edge_function', 'text', 'global_safe', false, ''),
  ('edge_functions_ready', '', 'global_safe', false, ''),
  ('is_circle_member', 'uuid', 'caller_own_rows', false, 'RLS helper: is the caller in this circle; reads only the caller''s own membership rows'),
  ('is_circle_owner', 'uuid', 'caller_own_rows', false, 'RLS helper: is the caller an owner of this circle'),
  ('idem_begin', 'text, uuid, text', 'caller_own_rows', false, ''),
  ('idem_complete', 'text, uuid, jsonb', 'caller_own_rows', false, ''),
  ('idem_purge', 'interval', 'global_safe', false, ''),
  ('is_community_member', '', 'caller_own_rows', false, 'member of at least one circle; reads only the caller''s own membership rows'),
  ('job_health_check', '', 'global_safe', false, ''),
  ('job_health_status', '', 'global_safe', true, 'monitoring workflow asks yes/no health with the publishable key; no args, returns ok, failing_count, last_checked_at (0113, 0116)'),
  ('mark_recovery_verified', '', 'caller_own_rows', false, ''),
  ('member_achievements_compute_verified', '', 'global_safe', false, ''),
  ('my_circles', '', 'caller_own_rows', false, 'RLS helper: the circle ids the caller belongs to'),
  ('my_recovery_code_created_at', '', 'caller_own_rows', false, 'reads only the caller''s own recovery_codes row and returns when it was made, never the code or its HMAC (202610300001)'),
  ('owner_issue_reset_code', 'text', 'global_safe', false, 'owner-only: granted to no role, so only the SQL editor (postgres) can call it; refuses any call that carries an auth.uid(); writes one one-hour, one-use reset code as a salted HMAC (202610300001)'),
  ('recovery_consume_reset_code', 'uuid, text', 'global_safe', false, 'recover-password helper: service_role only; spends the named member''s reset code once (202610300001)'),
  ('recovery_lookup_user', 'text', 'global_safe', false, 'recover-password helper: service_role only; username to auth user id (202610300001)'),
  ('recovery_revoke_sessions', 'uuid', 'global_safe', false, 'recover-password helper: service_role only; deletes the named member''s sessions and refresh tokens (202610300001)'),
  ('notif_batch_flush_due', 'integer', 'global_safe', false, ''),
  ('notif_batch_flushed', 'uuid, text', 'global_safe', false, ''),
  ('notif_blocked_between', 'uuid, uuid', 'caller_own_rows', false, 'answers only for a pair that includes the caller, or for a trigger/job with no caller'),
  ('notif_create', 'uuid, text, text, text, text, text, uuid, text, uuid, uuid', 'circle_scoped', false, 'writes one notification, and only if the recipient (and the actor) are in the named circle, no block separates them, and the recipient turned the type on (202610260001)'),
  ('notif_mark_read', 'uuid[]', 'caller_own_rows', false, ''),
  ('circle_members_forget_notifications', '', 'circle_scoped', false, 'trigger: a member is gone, so their notifications about that circle, and those they caused, go'),
  ('notif_on_circle_join', '', 'circle_scoped', false, 'trigger: tells the owners of the circle that someone joined it; never for a club (202611120001)'),
  ('notif_week_card_due', 'timestamp with time zone', 'global_safe', false, 'hourly job: Saturday night, tells each unpaused member of each active couple or friends circle that its week card is ready; never a club; service_role only (202611120001)'),
  ('notif_on_reaction', '', 'circle_scoped', false, 'trigger: notifies a post author only when author and reactor are both in the post''s circle'),
  ('notif_on_training_partner_tag', '', 'circle_scoped', false, 'trigger: asks the tagged member to confirm, only if they are in the post''s circle'),
  ('notif_pref_allows', 'uuid, text', 'global_safe', false, ''),
  ('notif_push_mark_sent', 'uuid[]', 'global_safe', false, ''),
  ('notif_push_pending', 'integer', 'global_safe', false, ''),
  ('notif_push_revoke', 'uuid[]', 'global_safe', false, ''),
  ('notif_queue_batched', 'uuid, text, text, uuid', 'global_safe', false, ''),
  ('post_create', 'uuid, text, uuid', 'circle_scoped', false, 'creates a post in ONE circle the caller is a member of'),
  ('post_delete', 'uuid', 'circle_scoped', false, 'the author deletes their own post; in a club, the club''s owner or coach may delete any post of THAT club (202611120001)'),
  ('post_edit_caption', 'uuid, text', 'caller_own_rows', false, ''),
  ('post_tag_training_partners', 'uuid, uuid[]', 'circle_scoped', false, 'the post author tags members of the post''s own circle; tags are pending'),
  ('post_training_partner_remove', 'uuid, uuid', 'circle_scoped', false, 'author or tagged member removes a tag; caller must be in the post''s circle'),
  ('pr_share', 'uuid, text, text, numeric, uuid', 'circle_scoped', false, 'publishes a PR post in ONE circle the caller is a member of'),
  ('post_training_partners_set_circle', '', 'global_safe', false, 'trigger: a tag takes its circle from its post and the tagged user must be in it'),
  ('private_records_guard_rate_limit', '', 'caller_own_rows', false, ''),
  ('purge_abandoned_profiles', 'integer', 'global_safe', false, ''),
  ('purge_due_accounts', '', 'global_safe', false, ''),
  ('push_subscriptions_guard_count', '', 'caller_own_rows', false, ''),
  ('redeem_invite_code', 'text, text', 'caller_own_rows', false, 'bootstrap only: writes the caller''s own redemption row and grants no circle access'),
  ('request_account_deletion', '', 'caller_own_rows', false, ''),
  ('retention_purge_telemetry', 'integer', 'global_safe', false, ''),
  ('scheduled_job_health', '', 'global_safe', false, ''),
  ('toggle_reaction', 'uuid, uuid, text', 'circle_scoped', false, 'reacts only on posts in a circle the caller is in'),
  ('workout_posts_guard_insert_rate_limit', '', 'caller_own_rows', false, ''),
  ('workout_posts_guard_moderated_fields', '', 'caller_own_rows', false, ''),
  ('workout_posts_guard_privileged_type', '', 'global_safe', false, ''),
  ('circle_members_after_delete', '', 'global_safe', false, 'trigger: a member is gone, so their posts, reactions, tags, results and club announcements in that circle go, ownership passes on (in a club: to the coach only), an empty couple or friends circle is deleted (202611120001)'),
  ('circle_week', 'uuid', 'circle_scoped', false, 'weekly counts and percents for the members of ONE circle the caller is in'),
  ('confirm_trained_together', 'uuid', 'circle_scoped', false, 'the tagged member confirms their own pending tag'),
  ('create_circle', 'text, text, text', 'caller_own_rows', false, 'creates a circle the caller then owns'),
  ('create_circle_invite', 'uuid, integer', 'circle_scoped', false, 'mints an invite for ONE circle, per its invite_policy'),
  ('create_founder_invite', '', 'caller_own_rows', false, 'a signed-up member mints a one-use, 7-day invite_codes row that lets a friend create their own circle; joins no circle, reads nothing, 3 per member per day (202610290002)'),
  ('has_logged_benchmark', 'uuid, text, date', 'caller_own_rows', false, 'RLS helper: has the caller logged this benchmark result; reads only the caller''s own row'),
  ('join_circle', 'text', 'circle_scoped', false, 'joins the one circle an invite token names'),
  ('leave_circle', 'uuid', 'circle_scoped', false, 'the caller leaves ONE circle they are in'),
  ('remove_member', 'uuid, uuid', 'circle_scoped', false, 'owner removes a member of the owner''s own circle; in a club the coach may too, never the owner, and only the owner removes the coach (202611120001)'),
  ('set_pause', 'date', 'caller_own_rows', false, ''),
  ('set_share_defaults', 'uuid, jsonb', 'circle_scoped', false, 'the caller''s own sharing defaults in ONE circle they are in'),
  ('set_weekly_target', 'uuid, integer', 'circle_scoped', false, 'the caller''s own weekly target in ONE circle they are in'),
  ('update_circle', 'uuid, jsonb', 'circle_scoped', false, 'owner changes settings of the owner''s own circle');

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

-- No function is left as needs_circle_scope (the constraint forbids it; this
-- states it where a reader looks).
select is_empty(
  $$ select name from tests.definer_reviewed where class not in ('global_safe', 'caller_own_rows', 'circle_scoped') $$,
  'no SECURITY DEFINER function is left as needs_circle_scope');

select * from finish();
rollback;
