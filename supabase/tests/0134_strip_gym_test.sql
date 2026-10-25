-- 202610250001 (strip gym): what is gone stays gone, what was kept is still
-- there, and the three permission stubs are inert.
--
-- The file asserts the END STATE rather than replaying the migration, so a
-- later migration that re-creates a dropped table (or drops a kept one) fails
-- here whatever it was trying to do.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. Dropped tables are gone
-- =====================================================================
select is_empty(
  $$ select tablename from pg_tables
      where schemaname = 'public'
        and tablename in (
          'activity_pings', 'admin_actions', 'announcements', 'attendance_log',
          'challenge_participants', 'challenge_progress', 'challenge_teams', 'challenges',
          'club_features', 'club_wod_results', 'club_wod_sessions', 'club_wods',
          'coach_congratulations', 'coach_engagement_flags', 'coach_tasks',
          'comment_mentions', 'community_health_scores', 'event_attendees', 'events',
          'feed_impressions', 'feed_interactions', 'follows', 'hidden_posts',
          'intro_carousel_content', 'member_contact_log', 'member_feed_weights',
          'member_of_week', 'monthly_club_recaps', 'onboarding_challenge_offers',
          'onboarding_progress', 'onboarding_step_content', 'owner_reports',
          'permissions', 'pins', 'post_comments', 'post_media', 'posting_restrictions',
          'reports', 'role_permissions', 'roles', 'saved_posts', 'storage_erasure_queue',
          'training_log_usage', 'weekly_challenges', 'weekly_challenges_archive',
          'weekly_recaps') $$,
  'no gym, staff, coach, feed, challenge, event, recap or moderation table survives');

-- =====================================================================
-- 2. Kept tables are still there
-- =====================================================================
select has_table('public', t, t || ' is kept')
  from unnest(array[
    'profiles', 'private_records', 'blocks', 'workout_posts', 'reactions',
    'member_achievements', 'achievement_definitions', 'notifications',
    'notification_batches', 'notification_preferences', 'push_subscriptions',
    'account_deletion_requests', 'rate_limits', 'request_idempotency',
    'invite_codes', 'invite_redemptions', 'invite_attempts', 'analytics_events',
    'bug_reports', 'edge_function_invocations', 'job_health_state']) as t;

-- =====================================================================
-- 3. The photo buckets and their policies are gone
-- =====================================================================
select is_empty(
  $$ select id from storage.buckets where id in ('post-photos', 'avatar-photos') $$,
  'neither photo bucket exists');
select is_empty(
  $$ select policyname from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and (qual ~ '(post-photos|avatar-photos)' or with_check ~ '(post-photos|avatar-photos)') $$,
  'and no storage policy still names one');

-- =====================================================================
-- 4. The three permission stubs are inert and closed to anon
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(public.is_staff(), false, 'is_staff() is false for a member');
select is(public.is_admin(), false, 'is_admin() is false for a member');
select is(public.has_perm('anything'), false, 'has_perm() is false for a member');
select tests.set_auth(tests.uid('admin'));
select is(public.is_admin(), false, 'and is_admin() is false even for a profile still carrying is_admin');
select is(public.is_staff(), false, 'and is_staff() is false even for a profile redeemed at a staff rank');
select tests.clear_auth();
select ok(
  not has_function_privilege('anon', 'public.is_staff()', 'execute')
  and not has_function_privilege('anon', 'public.is_admin()', 'execute')
  and not has_function_privilege('anon', 'public.has_perm(text)', 'execute'),
  'none of the three is executable by anon');

-- =====================================================================
-- 5. The scheduled jobs that served dropped features are unscheduled
-- =====================================================================
select is_empty(
  $$ select jobname from cron.job
      where jobname ~ '(recap|member-of-week|announcement|challenge|event|feed|coach|health-score|onboarding|streak|weekly|monthly|wod)' $$,
  'no cron job names a dropped feature');
select isnt_empty(
  $$ select 1 from cron.job where jobname = 'purge-due-accounts' $$,
  'and the account-deletion reaper is still scheduled');

-- =====================================================================
-- 6. The kept telemetry purge still runs without the tables it used to touch
-- =====================================================================
select lives_ok($$ select public.retention_purge_telemetry(90) $$,
  'retention_purge_telemetry() runs');

-- =====================================================================
-- 7. Dropped functions are gone, including old overloads
-- =====================================================================
select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('feed_page', 'community_search', 'community_profile',
          'post_set_visibility', 'add_post_comment', 'admin_invite_create',
          'admin_reset_password', 'recap_weekly', 'sanitize_upload',
          'member_roles', 'club_feature_enabled', 'log_admin_action',
          'chal_record_progress', 'event_rsvp', 'coach_congratulate') $$,
  'no overload of a dropped RPC remains, so an old client call fails with PGRST202 rather than half-working');

select * from finish();
rollback;
