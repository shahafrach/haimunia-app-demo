-- 202611150004: RLS policies call auth.uid() once per statement, not once per row (F-005).
--
-- Supabase's linter (splinter 0003_auth_rls_initplan, WARN) flagged every public policy that calls
-- auth.uid() bare: Postgres re-evaluates it for each row. Wrapped as (select auth.uid()), the planner
-- runs it once as an InitPlan and caches the value. Same rows match, same rows are refused: this is a
-- performance change, not an access change.
--
-- Each statement below is the policy's current definition (pg_policies on 2026-11-15) with every bare
-- auth.uid() replaced by (select auth.uid()). Nothing else in any expression changed. aal_satisfied()
-- is already wrapped in every aal2_required policy, and reminder_prefs already uses the wrapped form.
-- ALTER POLICY keeps each policy's name, command, roles and permissive/restrictive kind.
-- Forward only; no earlier migration is edited.

alter policy deletion_requests_self_select on public.account_deletion_requests
  using (user_id = (select auth.uid()));
alter policy analytics_events_insert_self on public.analytics_events
  with check ((user_id = (select auth.uid())) OR (user_id IS NULL));
alter policy benchmark_results_delete_self on public.benchmark_results
  using (user_id = (select auth.uid()));
alter policy benchmark_results_insert_self on public.benchmark_results
  with check ((user_id = (select auth.uid())) AND is_circle_member(club_id) AND (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = benchmark_results.club_id) AND c.benchmark_enabled AND (c.benchmark = benchmark_results.benchmark) AND (c.benchmark_month = benchmark_results.month) AND (c.benchmark_month = (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Jerusalem'::text)))::date)))));
alter policy benchmark_results_read on public.benchmark_results
  using (is_circle_member(club_id) AND ((user_id = (select auth.uid())) OR has_logged_benchmark(club_id, benchmark, month)));
alter policy benchmark_results_update_self on public.benchmark_results
  using ((user_id = (select auth.uid())) AND is_circle_member(club_id))
  with check ((user_id = (select auth.uid())) AND is_circle_member(club_id) AND (EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = benchmark_results.club_id) AND c.benchmark_enabled AND (c.benchmark = benchmark_results.benchmark) AND (c.benchmark_month = benchmark_results.month) AND (c.benchmark_month = (date_trunc('month'::text, (now() AT TIME ZONE 'Asia/Jerusalem'::text)))::date)))));
alter policy blocks_self_delete on public.blocks
  using (blocker_id = (select auth.uid()));
alter policy blocks_self_insert on public.blocks
  with check ((blocker_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM circle_members m
  WHERE (m.user_id = blocks.blocked_id))));
alter policy blocks_self_select on public.blocks
  using ((blocker_id = (select auth.uid())) OR (blocked_id = (select auth.uid())));
alter policy circle_targets_self_delete on public.circle_targets
  using (user_id = (select auth.uid()));
alter policy circle_targets_self_insert on public.circle_targets
  with check ((user_id = (select auth.uid())) AND is_circle_member(club_id));
alter policy circle_targets_self_select on public.circle_targets
  using (user_id = (select auth.uid()));
alter policy circle_targets_self_update on public.circle_targets
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy invite_redemptions_self_select on public.invite_redemptions
  using (user_id = (select auth.uid()));
alter policy member_achievements_read on public.member_achievements
  using (user_id = (select auth.uid()));
alter policy member_targets_self_delete on public.member_targets
  using (user_id = (select auth.uid()));
alter policy member_targets_self_insert on public.member_targets
  with check (user_id = (select auth.uid()));
alter policy member_targets_self_select on public.member_targets
  using (user_id = (select auth.uid()));
alter policy member_targets_self_update on public.member_targets
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy notification_batches_self_select on public.notification_batches
  using (user_id = (select auth.uid()));
alter policy notification_preferences_self_delete on public.notification_preferences
  using (user_id = (select auth.uid()));
alter policy notification_preferences_self_insert on public.notification_preferences
  with check (user_id = (select auth.uid()));
alter policy notification_preferences_self_select on public.notification_preferences
  using (user_id = (select auth.uid()));
alter policy notification_preferences_self_update on public.notification_preferences
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy notifications_self_select on public.notifications
  using (user_id = (select auth.uid()));
alter policy notifications_self_update on public.notifications
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy post_training_partners_read on public.post_training_partners
  using (is_circle_member(club_id) AND ((tagged_user_id = (select auth.uid())) OR (tagged_by = (select auth.uid())) OR ((confirmed_at IS NOT NULL) AND post_visible_to_viewer(post_id))));
alter policy private_records_self_delete on public.private_records
  using (user_id = (select auth.uid()));
alter policy private_records_self_insert on public.private_records
  with check (user_id = (select auth.uid()));
alter policy private_records_self_select on public.private_records
  using (user_id = (select auth.uid()));
alter policy private_records_self_update on public.private_records
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy profiles_insert_self on public.profiles
  with check ((id = (select auth.uid())) AND (recovery_verified_at IS NULL) AND (EXISTS ( SELECT 1
   FROM invite_redemptions ir
  WHERE (ir.user_id = (select auth.uid())))));
alter policy profiles_read_authenticated on public.profiles
  using ((id = (select auth.uid())) OR ((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM circle_members m
  WHERE (m.user_id = profiles.id))) AND (NOT (EXISTS ( SELECT 1
   FROM blocks b
  WHERE (((b.blocker_id = (select auth.uid())) AND (b.blocked_id = profiles.id)) OR ((b.blocker_id = profiles.id) AND (b.blocked_id = (select auth.uid())))))))));
alter policy profiles_update_self on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
alter policy push_subscriptions_self_delete on public.push_subscriptions
  using (user_id = (select auth.uid()));
alter policy push_subscriptions_self_insert on public.push_subscriptions
  with check (user_id = (select auth.uid()));
alter policy push_subscriptions_self_select on public.push_subscriptions
  using (user_id = (select auth.uid()));
alter policy push_subscriptions_self_update on public.push_subscriptions
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
alter policy reactions_delete_self on public.reactions
  using (user_id = (select auth.uid()));
alter policy reactions_insert_self on public.reactions
  with check ((user_id = (select auth.uid())) AND post_visible_to_viewer(post_id));
alter policy posts_feed_select on public.workout_posts
  using ((deleted_at IS NULL) AND is_circle_member(club_id) AND (NOT (EXISTS ( SELECT 1
   FROM blocks b
  WHERE (((b.blocker_id = (select auth.uid())) AND (b.blocked_id = workout_posts.author_id)) OR ((b.blocker_id = workout_posts.author_id) AND (b.blocked_id = (select auth.uid()))))))) AND ((author_id = (select auth.uid())) OR ((status = 'active'::post_status) AND (visibility = ANY (ARRAY['public'::post_visibility, 'club'::post_visibility])))));
alter policy posts_insert_self on public.workout_posts
  with check ((author_id = (select auth.uid())) AND is_community_member() AND is_circle_member(club_id));
alter policy posts_update_self on public.workout_posts
  using ((author_id = (select auth.uid())) AND is_circle_member(club_id))
  with check ((author_id = (select auth.uid())) AND is_circle_member(club_id));
