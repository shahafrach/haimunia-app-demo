# Circles: audit

Written 2026-10-02 on branch `claude/kind-bardeen-9nhh36`; sections 5 and 6
updated 2026-10-25. Read-only: no code, migration or test was changed.

**The decisions were replaced on 2026-10-25** ([decisions.md](decisions.md)):
the app is now a free private-circles app for friends, with no email and no
SMTP. Sections 1 to 4 are the 2026-10-02 inventory and still hold as a map of
what exists, but any line in them that assumes real-email sign-up, `post-photos`,
events, `training_log_usage` as "keep", or a public app is superseded by
decisions.md. Read decisions.md first.

## 0. Method and limits

- Read: `CLAUDE.md`, `docs/community/backlog.md` (greps plus the resolved-questions block), README, PRIVACY, COMMUNITY_SETUP, `docs/deploy/PER_CLUB_SETUP.md`, `docs/audit/AUTHORIZATION_MATRIX.md` section 4.
- Ran: `node --test test/public-surface.test.mjs` only, `10 pass, 0 fail`. Nothing else was run.
- Function inventory: a script over `supabase/migrations/*.sql` in filename order. It keeps the last `create [or replace] function` per name and argument list and drops anything a later `drop function` removed. **It reads the repository, not the live catalog.** Where an old overload may still be live, the row says so. The guard in session 3 must enumerate `pg_proc`, not migrations.
- Not read: `docs/audit/*` other than the matrix section above, `TERMS.md` (a grep for the patterns used below found nothing), the full body of every function. A class below is a judgement from the function's name, the tables it touches and its migration comment.

Class vocabulary:

| Class | Meaning |
|---|---|
| DROP | Goes with the gym. |
| GLOBAL | Safe as global: touches no member data. |
| GLOBAL-SELF | Safe as global, but reads or writes the caller's own rows only. I split this out of GLOBAL because the guard must assert the `auth.uid()` scoping, which it does not for pure GLOBAL. |
| SCOPE | Needs circle scope. |

## 1. SECURITY DEFINER functions

**226 by latest definition** (of 285 functions found): 121 DROP, 23 GLOBAL, 23 GLOBAL-SELF, 59 SCOPE. No unclassified rows.

Notes that change the plan:

1. **`clubs_guard_single_row()`** (`202609060012:287`) is a BEFORE INSERT trigger that refuses a second `clubs` row for the owner and for service role. Circles cannot exist while it does. First thing the schema session removes.
2. **`is_community_member()`** (`202609060001:88`) and **`can_view_profile_field()`** (`202608280003`) are the two predicates every member-data read policy resolves through. Neither takes a circle. Rewriting these two changes most of the SCOPE list.
3. **`training_log_usage_report()`** (`202609230013`) is gated on `is_staff()`. It is the only reader of a kept table. With staff gone it needs a non-staff gate, for example service-role only. If left alone it becomes callable by nobody, or by whoever `is_staff()` is stubbed to.
4. **`job_health_check()`** notifies `admin_alert_recipients()`, which is staff. After the strip it alerts nobody. Rewire to an operator channel or accept silence knowingly.
5. **Old overloads, verify live:** `add_post_comment(uuid,text)`, `admin_grant_coach(uuid)`, `redeem_invite_code(text)`, `submit_report(uuid,text)`. A later migration redefined each with another argument list and I found no `drop function` for the old one. If they are live they are extra attack surface that the guard must catch.
6. **Invoker helpers also carry scope** and are not in the table because they are not DEFINER: `post_visible_to_viewer` (`202608280005:19`), `are_friends` (`202608280003:135`), `relationship_score` (`202608310002:70`), `is_staff`, `is_admin`. `post_visible_to_viewer` is the predicate behind comment, media and storage reads.
7. **Existing coverage to build on:** `supabase/tests/0075_definer_read_gate_test.sql` already pins a subset of definer read gates. No test enumerates `prosecdef`.

| Function | Migration | Class | Note |
|---|---|---|---|
| `ach_claim(text[])` | 202609230001 | GLOBAL-SELF | caller own rows |
| `ach_share(uuid,text,jsonb,uuid)` | 202609230003 | SCOPE | post/comment/reaction path: one circle per post |
| `add_post_comment(uuid,text)` | 202608280016 | SCOPE | post/comment/reaction path: one circle per post |
| `add_post_comment(uuid,text,uuid)` | 202609230003 | SCOPE | post/comment/reaction path: one circle per post |
| `add_post_comment(uuid,text,uuid,uuid[],uuid)` | 202609230003 | SCOPE | post/comment/reaction path: one circle per post |
| `admin_actions_redact_on_user_delete()` | 202609230002 | DROP | admin audit log |
| `admin_alert_recipients()` | 202609190001 | DROP | staff/admin tooling |
| `admin_check_password_reset_rate_limit()` | 202609060012 | DROP | staff/admin tooling |
| `admin_grant_coach(uuid)` | 202608280025 | DROP | staff/admin tooling |
| `admin_grant_coach(uuid,text)` | 202609060022 | DROP | staff/admin tooling |
| `admin_incomplete_signups(timestamptz,integer,uuid)` | 202609160002 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_code_create(text,timestamptz,integer)` | 202609030002 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_code_list()` | 202609030002 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_code_set_active(uuid,boolean)` | 202609030002 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_create(text,text,timestamptz)` | 202609030008 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_list(text,timestamptz,integer,uuid)` | 202609160002 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_invite_revoke(uuid)` | 202609030001 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_log_password_reset(uuid)` | 202609050001 | DROP | staff/admin tooling |
| `admin_member_roster(timestamptz,integer,uuid)` | 202609180001 | DROP | staff/admin tooling |
| `admin_reclaim_invite(uuid,text,integer)` | 202609060023 | DROP | staff invite tooling; replaced by owner-issued circle invites |
| `admin_remove_member(uuid)` | 202609160005 | DROP | staff/admin tooling |
| `admin_revoke_coach(uuid)` | 202609060022 | DROP | staff/admin tooling |
| `admin_search_members(text)` | 202609030007 | DROP | staff/admin tooling |
| `admin_set_club_feature(text,boolean,jsonb)` | 202609220002 | DROP | staff/admin tooling |
| `analytics_breakdown(text,text,timestamptz,timestamptz)` | 202609010006 | DROP | owner/staff analytics and reports |
| `analytics_dashboard(date,date)` | 202609010006 | DROP | owner/staff analytics and reports |
| `analytics_events_guard_rate_limit()` | 202609060012 | GLOBAL | rate-limit trigger, no member data read |
| `announcement_feed_card_insert()` | 202609220008 | DROP | staff announcements |
| `announcement_feed_card_sync()` | 202609220008 | DROP | staff announcements |
| `announcements_audit_cross_author_edit()` | 202609060013 | DROP | staff announcements |
| `announcements_module_gate()` | 202609230001 | DROP | staff announcements |
| `attendance_classmates_on(date,integer)` | 202609220005 | DROP | Arbox attendance |
| `attendance_classmates_today(integer)` | 202609220005 | DROP | Arbox attendance |
| `attendance_log_from_record()` | 202608310001 | DROP | Arbox attendance |
| `attendance_milestones_on_log()` | 202608310007 | DROP | Arbox attendance |
| `audit_identity_label(uuid)` | 202609060022 | DROP | admin audit log |
| `blocks_clear_follows()` | 202609150012 | DROP | follows dropped (decision 3) |
| `bug_report_alert_recipients()` | 202609190001 | DROP | staff-addressed bug triage |
| `bug_report_list_all(text,integer)` | 202609150002 | DROP | staff-addressed bug triage |
| `bug_report_list_mine()` | 202609150002 | GLOBAL-SELF | caller own rows |
| `bug_report_set_status(uuid,text,text)` | 202609150002 | DROP | staff-addressed bug triage |
| `bug_report_submit(text,jsonb)` | 202609150002 | GLOBAL-SELF | caller own rows |
| `bug_reports_anonymize_on_user_delete()` | 202609150002 | GLOBAL-SELF | erasure trigger |
| `bump_invite_attempt(text,uuid)` | 202608280013 | GLOBAL-SELF | account/own-row; purge job rewrite for email confirmation |
| `can_upload_post_photo(text)` | 202608270006 | SCOPE | storage path must be circle-scoped |
| `can_view_profile_field(uuid,text)` | 202608280003 | SCOPE | CORE predicates: rewrite as circle-membership checks |
| `can_write_own_avatar(text)` | 202609060012 | GLOBAL-SELF | account/own-row; purge job rewrite for email confirmation |
| `chal_notify_ending_soon()` | 202609230003 | SCOPE | per-circle challenges |
| `chal_progress(uuid)` | 202609230001 | SCOPE | per-circle challenges |
| `chal_reassign_team(uuid,uuid,uuid)` | 202609230003 | SCOPE | per-circle challenges |
| `chal_record_progress(uuid,uuid,numeric,text,uuid)` | 202609230003 | SCOPE | per-circle challenges |
| `chal_set_captain(uuid,uuid)` | 202609230003 | SCOPE | per-circle challenges |
| `challenge_participants_guard_progress()` | 202609060005 | SCOPE | per-circle challenges |
| `challenge_participants_guard_team()` | 202609010005 | SCOPE | per-circle challenges |
| `challenge_progress_apply()` | 202609060005 | SCOPE | per-circle challenges |
| `challenge_progress_stamp_team()` | 202608290003 | SCOPE | per-circle challenges |
| `challenge_teams_block_delete()` | 202609010005 | SCOPE | per-circle challenges |
| `challenge_teams_guard_captain()` | 202609010005 | SCOPE | per-circle challenges |
| `challenge_teams_release_captain()` | 202609010005 | SCOPE | per-circle challenges |
| `check_rate_limit(text,integer,integer)` | 202608270010 | GLOBAL | keyed by caller; no member data |
| `club_feature_choice(text,text,text,text[])` | 202609220003 | DROP | staff feature flags; RLS callers must be rewritten first |
| `club_feature_enabled(text,text)` | 202609010012 | DROP | staff feature flags; RLS callers must be rewritten first |
| `club_feature_enabled_at(text)` | 202609220002 | DROP | staff feature flags; RLS callers must be rewritten first |
| `club_feature_number(text,text,numeric,numeric,numeric)` | 202609220002 | DROP | staff feature flags; RLS callers must be rewritten first |
| `club_features_for_caller()` | 202609230007 | DROP | staff feature flags; RLS callers must be rewritten first |
| `club_summary()` | 202609230003 | SCOPE | becomes circle_summary(circle_id) |
| `club_wod_attach_result(uuid,text,jsonb,uuid)` | 202609080002 | DROP | gym WOD / display |
| `club_wod_board(uuid)` | 202609080002 | DROP | gym WOD / display |
| `club_wod_board_json(uuid)` | 202609080004 | DROP | gym WOD / display |
| `club_wod_boards(date,date)` | 202609080002 | DROP | gym WOD / display |
| `club_wod_challenge_conflict(text,boolean)` | 202609060028 | DROP | gym WOD / display |
| `club_wod_detach_result(uuid)` | 202609080002 | DROP | gym WOD / display |
| `club_wod_edit(text,text,text)` | 202609060028 | DROP | gym WOD / display |
| `club_wod_publish(text,text,text,text,jsonb,jsonb,integer,integer)` | 202609060028 | DROP | gym WOD / display |
| `club_wod_restore(text)` | 202609060028 | DROP | gym WOD / display |
| `club_wod_retire(text,text)` | 202609060028 | DROP | gym WOD / display |
| `club_wod_session_cancel(uuid,text)` | 202609080002 | DROP | gym WOD / display |
| `club_wod_session_publish(text,date,text,uuid)` | 202609230003 | DROP | gym WOD / display |
| `clubs_guard_single_row()` | 202609060012 | DROP | BLOCKS a 2nd clubs row (SEC-008 trigger); remove or replace in schema session |
| `coach_activity_signal_status()` | 202609060020 | DROP | coach role / coach tools |
| `coach_assign_coach(uuid,uuid)` | 202608290013 | DROP | coach role / coach tools |
| `coach_celebrate_feed(integer)` | 202609230003 | DROP | coach role / coach tools |
| `coach_congratulate(text,uuid,timestamptz,uuid,uuid,text)` | 202609230003 | DROP | coach role / coach tools |
| `coach_detect_engagement_decline()` | 202608310008 | DROP | coach role / coach tools |
| `coach_inactive_members(date)` | 202609060020 | DROP | coach role / coach tools |
| `coach_new_members(integer)` | 202609160003 | DROP | coach role / coach tools |
| `coach_notify_engagement_flags()` | 202609100004 | DROP | coach role / coach tools |
| `coach_task_members()` | 202609220002 | DROP | coach role / coach tools |
| `coach_tasks_close_on_contact()` | 202609220002 | DROP | coach role / coach tools |
| `coach_tasks_guard_update()` | 202609220002 | DROP | coach role / coach tools |
| `coach_tasks_refresh(boolean,integer)` | 202609220002 | DROP | coach role / coach tools |
| `coach_tasks_sync()` | 202609220002 | DROP | coach role / coach tools |
| `comment_delete(uuid)` | 202608280021 | SCOPE | post/comment/reaction path: one circle per post |
| `comment_edit(uuid,text)` | 202608280016 | SCOPE | post/comment/reaction path: one circle per post |
| `comment_moderate(uuid,text)` | 202609110005 | SCOPE | moderation moves to circle owner; restriction per circle |
| `community_health_generate(date)` | 202609010009 | DROP | owner/staff analytics and reports |
| `community_health_history(integer)` | 202609010009 | DROP | owner/staff analytics and reports |
| `community_profile(uuid)` | 202609230003 | SCOPE | reads other members: scope to shared circles |
| `community_search(text,integer)` | 202609230004 | SCOPE | reads other members: scope to shared circles |
| `community_streaks(integer)` | 202609230001 | SCOPE | reads other members: scope to shared circles |
| `create_member_invite(timestamptz,integer)` | 202608270006 | SCOPE | becomes token+expiry circle invite (decision 5) |
| `cron_invoke_edge_function(text)` | 202609230008 | GLOBAL | infra; job_health_check notifies admin_alert_recipients: rewire |
| `edge_functions_ready()` | 202609230008 | GLOBAL | infra; job_health_check notifies admin_alert_recipients: rewire |
| `enforce_comment_depth()` | 202608280016 | SCOPE | post/comment/reaction path: one circle per post |
| `enforce_event_capacity()` | 202609120003 | DROP | events (not in the circle brief; open question O2) |
| `enforce_pin_target()` | 202608280017 | DROP | staff pins |
| `event_rsvp(uuid,text,uuid)` | 202609230001 | DROP | events (not in the circle brief; open question O2) |
| `feed_leaderboard(text,uuid,text,integer)` | 202609010012 | SCOPE | reads other members: scope to shared circles |
| `feed_page(text,integer,text)` | 202609230001 | SCOPE | reads other members: scope to shared circles |
| `feed_record_impressions(jsonb)` | 202609120006 | GLOBAL-SELF | writes caller telemetry; post id must be circle-checked |
| `feed_record_interaction(uuid,text,uuid)` | 202609060010 | GLOBAL-SELF | writes caller telemetry; post id must be circle-checked |
| `grant_coach_role(uuid)` | 202608270006 | DROP | coach role / coach tools |
| `grant_coach_role_by_handle(text)` | 202608270007 | DROP | coach role / coach tools |
| `gym_display_board()` | 202609230005 | DROP | gym WOD / display |
| `has_perm(text)` | 202608280001 | DROP | RBAC; replaced by circle_members.role |
| `hide_management_from_member(uuid)` | 202609220006 | DROP | staff/management identity |
| `idem_begin(text,uuid,text)` | 202609120011 | GLOBAL | keyed by caller; no member data |
| `idem_complete(text,uuid,jsonb)` | 202609060014 | GLOBAL | keyed by caller; no member data |
| `idem_purge(interval)` | 202609060014 | GLOBAL | keyed by caller; no member data |
| `intro_carousel_content_audit()` | 202609050007 | DROP | gym onboarding |
| `is_community_member()` | 202609060001 | SCOPE | CORE predicates: rewrite as circle-membership checks |
| `is_gym_display()` | 202609230005 | DROP | gym WOD / display |
| `is_management_account(uuid)` | 202609230005 | DROP | staff/management identity |
| `is_posting_restricted(uuid)` | 202608280015 | SCOPE | moderation moves to circle owner; restriction per circle |
| `job_health_check()` | 202609230008 | GLOBAL | infra; job_health_check notifies admin_alert_recipients: rewire |
| `job_health_status()` | 202609190001 | GLOBAL | infra; job_health_check notifies admin_alert_recipients: rewire |
| `list_orphaned_avatar_photos(interval)` | 202609060012 | GLOBAL | service-role storage janitor; object names only |
| `list_orphaned_post_photos(interval)` | 202608270006 | GLOBAL | service-role storage janitor; object names only |
| `log_admin_action(text,text,uuid,jsonb,jsonb,text,text,uuid)` | 202609060022 | DROP | admin audit log |
| `management_user_ids()` | 202609220006 | DROP | staff/management identity |
| `mark_recovery_verified()` | 202608280003 | DROP | recovery_verified_at replaced by Supabase email confirmation (decision 4) |
| `member_achievements_compute_verified()` | 202609220002 | GLOBAL-SELF | caller own rows |
| `member_of_week_candidates(date)` | 202609010001 | DROP | owner/staff analytics and reports |
| `member_of_week_publish(date,uuid,text)` | 202609230010 | DROP | owner/staff analytics and reports |
| `member_role_rank(uuid)` | 202609160005 | DROP | RBAC; replaced by circle_members.role |
| `member_roles(uuid[])` | 202609060009 | DROP | RBAC; replaced by circle_members.role |
| `member_segments(date)` | 202609010007 | DROP | owner/staff analytics and reports |
| `mod_alert_recipients(uuid)` | 202609050003 | SCOPE | moderation moves to circle owner; restriction per circle |
| `mod_lift_restriction(uuid,text)` | 202609060022 | SCOPE | moderation moves to circle owner; restriction per circle |
| `mod_queue(text,timestamptz,integer)` | 202609050002 | SCOPE | moderation moves to circle owner; restriction per circle |
| `mod_restrict_member(uuid,text,timestamptz,text,uuid)` | 202609150013 | SCOPE | moderation moves to circle owner; restriction per circle |
| `mod_review(uuid,text,text,timestamptz)` | 202609060022 | SCOPE | moderation moves to circle owner; restriction per circle |
| `my_permissions()` | 202608280001 | DROP | RBAC; replaced by circle_members.role |
| `my_posting_restrictions()` | 202609120012 | GLOBAL-SELF | caller own rows |
| `my_role_code()` | 202608280001 | DROP | RBAC; replaced by circle_members.role |
| `notif_announcement_fanout(uuid,boolean)` | 202609230001 | DROP | staff announcements |
| `notif_batch_flush_due(integer)` | 202608280028 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_batch_flushed(uuid,text)` | 202608280018 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_blocked_between(uuid,uuid)` | 202608280026 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_create(uuid,text,text,text,text,text,uuid,text)` | 202608280026 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_is_operational(text,uuid)` | 202608290010 | DROP | staff announcements |
| `notif_mark_read(uuid[])` | 202608280008 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_on_achievement()` | 202609230003 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_announcement()` | 202608290010 | DROP | staff announcements |
| `notif_on_bug_report()` | 202609150005 | DROP | staff-addressed bug triage |
| `notif_on_challenge_complete()` | 202608290006 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_challenge_join()` | 202608290006 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_comment()` | 202608280027 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_event_cancelled()` | 202609230003 | DROP | events (not in the circle brief; open question O2) |
| `notif_on_mention()` | 202608280027 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_reaction()` | 202608280027 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_on_report()` | 202609050003 | SCOPE | moderation moves to circle owner; restriction per circle |
| `notif_on_training_partner_tag()` | 202609220005 | SCOPE | recipient derivation must stay inside the post/challenge circle |
| `notif_pref_allows(uuid,text)` | 202608280026 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_push_mark_sent(uuid[])` | 202609170002 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_push_pending(integer)` | 202609170003 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_push_revoke(uuid[])` | 202609170002 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_queue_batched(uuid,text,text,uuid)` | 202608280018 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `notif_streak_at_risk()` | 202609100002 | GLOBAL-SELF | notification plumbing, caller/recipient only |
| `onboarding_challenge_progress_on_attendance()` | 202609220002 | DROP | gym onboarding |
| `onboarding_challenge_respond(boolean)` | 202609220002 | DROP | gym onboarding |
| `onboarding_challenge_state()` | 202609220002 | DROP | gym onboarding |
| `onboarding_step_content_audit()` | 202609030004 | DROP | gym onboarding |
| `owner_report_generate(date)` | 202609220004 | DROP | owner/staff analytics and reports |
| `owner_report_list(date,text,integer)` | 202609220004 | DROP | owner/staff analytics and reports |
| `owner_report_members(date,text)` | 202609220004 | DROP | owner/staff analytics and reports |
| `owner_report_on_recap()` | 202609220004 | DROP | owner/staff analytics and reports |
| `owner_report_recipients()` | 202609220004 | DROP | owner/staff analytics and reports |
| `owner_report_subject(uuid)` | 202609220004 | DROP | owner/staff analytics and reports |
| `people_suggestions(integer)` | 202609230004 | DROP | follows dropped (decision 3) |
| `pin_clear(text,uuid)` | 202609060022 | DROP | staff pins |
| `pin_set(text,uuid,text)` | 202609060022 | DROP | staff pins |
| `post_create(text,post_visibility,jsonb,jsonb,uuid)` | 202609230001 | SCOPE | post/comment/reaction path: one circle per post |
| `post_delete(uuid)` | 202609110005 | SCOPE | post/comment/reaction path: one circle per post |
| `post_edit_caption(uuid,text)` | 202609230003 | SCOPE | post/comment/reaction path: one circle per post |
| `post_new_member_on_join()` | 202609160004 | DROP | gym onboarding post |
| `post_set_visibility(uuid,post_visibility)` | 202609230003 | DROP | visibility column goes (decision 3) |
| `post_tag_training_partners(uuid,uuid[])` | 202609220005 | SCOPE | post/comment/reaction path: one circle per post |
| `post_training_partner_remove(uuid,uuid)` | 202609220005 | SCOPE | post/comment/reaction path: one circle per post |
| `pr_share(text,text,jsonb,uuid)` | 202609230009 | SCOPE | post/comment/reaction path: one circle per post |
| `private_records_guard_rate_limit()` | 202609060012 | GLOBAL | rate-limit trigger, no member data read |
| `profiles_guard_staff_impersonation()` | 202609120007 | DROP | staff/management identity |
| `purge_abandoned_profiles(integer)` | 202609070001 | GLOBAL-SELF | account/own-row; purge job rewrite for email confirmation |
| `purge_due_accounts()` | 202608260001 | GLOBAL-SELF | account/own-row; purge job rewrite for email confirmation |
| `push_subscriptions_guard_count()` | 202609120005 | GLOBAL | rate-limit trigger, no member data read |
| `recap_monthly_generate(date)` | 202609010002 | DROP | owner/staff analytics and reports |
| `recap_monthly_publish(uuid)` | 202609010002 | DROP | owner/staff analytics and reports |
| `recap_weekly_classmates(uuid,date,integer)` | 202609010003 | DROP | classmates = attendance |
| `recompute_feed_weights(integer)` | 202608310006 | DROP | no-op stub (202609060015) |
| `redeem_invite_code(text)` | 202608280013 | SCOPE | becomes token+expiry circle invite (decision 5) |
| `redeem_invite_code(text,text)` | 202609030003 | SCOPE | becomes token+expiry circle invite (decision 5) |
| `registration_funnel(date,date)` | 202609030006 | DROP | owner/staff analytics and reports |
| `report(text,uuid,text,text)` | 202609110001 | SCOPE | moderation moves to circle owner; restriction per circle |
| `request_account_deletion()` | 202609060011 | GLOBAL-SELF | account/own-row; purge job rewrite for email confirmation |
| `retention_cohorts(integer)` | 202609010008 | DROP | owner/staff analytics and reports |
| `retention_member_weeks(integer)` | 202609010008 | DROP | owner/staff analytics and reports |
| `retention_onboarding_correlation()` | 202609010008 | DROP | owner/staff analytics and reports |
| `retention_purge_telemetry(integer)` | 202609230012 | GLOBAL | retention job over four telemetry tables, no cross-user read |
| `retention_welcome_correlation()` | 202609010008 | DROP | owner/staff analytics and reports |
| `review_report(uuid,report_status,text)` | 202609060022 | SCOPE | moderation moves to circle owner; restriction per circle |
| `role_rank(text)` | 202608280001 | DROP | RBAC; replaced by circle_members.role |
| `scheduled_job_health()` | 202609190001 | GLOBAL | infra; job_health_check notifies admin_alert_recipients: rewire |
| `seed_onboarding_progress()` | 202608290011 | DROP | gym onboarding |
| `storage_erasure_done(text,text[])` | 202609230002 | GLOBAL | service-role storage janitor; object names only |
| `storage_erasure_pending(integer)` | 202609230002 | GLOBAL | service-role storage janitor; object names only |
| `storage_invoke_sanitize()` | 202609110003 | GLOBAL | service-role storage janitor; object names only |
| `storage_queue_erasure_on_user_delete()` | 202609230002 | GLOBAL | service-role storage janitor; object names only |
| `submit_report(uuid,text)` | 202608280025 | SCOPE | moderation moves to circle owner; restriction per circle |
| `toggle_reaction(uuid,uuid)` | 202609230003 | SCOPE | post/comment/reaction path: one circle per post |
| `training_log_usage_before_insert()` | 202609230013 | GLOBAL | standalone app, keep as is |
| `training_log_usage_purge()` | 202609230013 | GLOBAL | standalone app, keep as is |
| `training_log_usage_report(integer)` | 202609230013 | GLOBAL | keep, BUT gate is is_staff(); needs a non-staff gate (see audit §1 notes) |
| `unpin_target()` | 202608280017 | DROP | staff pins |
| `workout_posts_guard_insert_rate_limit()` | 202609060012 | GLOBAL | rate-limit trigger, no member data read |
| `workout_posts_guard_moderated_fields()` | 202609060011 | SCOPE | post/comment/reaction path: one circle per post |
| `workout_posts_guard_privileged_type()` | 202609110004 | SCOPE | post/comment/reaction path: one circle per post |
## 2. Storage buckets and policies

Two buckets, both private. A third kind of object, the standalone app's data, is not in storage at all.

| Bucket / policy | Defined | Class | Note |
|---|---|---|---|
| `post-photos` (private, 5 MB, jpeg/png/webp) | `202608270004:30` | SCOPE | Object path starts with the author uid. Needs a circle in the access rule. |
| `post_photos_insert_own` | `202608270006:204` | SCOPE | Gated by `can_upload_post_photo(name)`: uid prefix only. Must also require the target circle membership. |
| `post_photos_delete_own` | `202608270004:36` | GLOBAL-SELF | Own prefix only. Keep. |
| `post_photos_select_if_post_visible` | `202608270006:207` | SCOPE | Joins `workout_posts.photo_path` through `post_visible_to_viewer`. |
| `post_photos_select_if_media_visible` | `202608280005:204` | SCOPE | Same through `post_media`. With decision 2, one stored object can back one post per circle: allow the read when the viewer is in the circle of any post that references the path. No object copies needed. |
| `avatar-photos` (private since `202609060003`, 2 MB) | `202609010010:32` | SCOPE | Avatars are read by other members. |
| `avatar_photos_insert_own`, `_update_own`, `_delete_own` | `202609010010:60-69` | GLOBAL-SELF | Own prefix. Keep. |
| `avatar_photos_select_own_or_visible` | `202609060003:70` | SCOPE | Uses `is_community_member()` and `visible_to_club`. "Visible to the club" becomes "shares a circle with the owner". |
| `storage_invoke_sanitize()` trigger fn | `202609110003` | GLOBAL | Calls the `sanitize_upload` edge function. Keep. |
| `list_orphaned_*_photos`, `storage_erasure_*` | see section 1 | GLOBAL | Service-role janitors, object names only. |

`scripts/backup-storage.mjs` exists and was not read.

## 3. Edge functions and pg_cron jobs

The jobs come from `cron.schedule` calls in migrations. **The live `cron.job` table was not queried.**

### Edge functions (`supabase/functions/`)

| Function | Class | Note |
|---|---|---|
| `admin_reset_password` | DROP | Staff resets a member's password. With real email, Supabase's own reset replaces it. |
| `recap_weekly` | DROP | Built on attendance classmates. A per-circle recap can be rebuilt later. |
| `purge_abandoned_profiles` | GLOBAL-SELF | Deletes unfinished signups. Its criteria (invite redeemed, recovery verified) change with decision 4. Rewrite, keep. |
| `notif_push_send` | GLOBAL-SELF | Delivers already-created notifications to the recipient's own subscriptions. Keep. |
| `sanitize_upload` | GLOBAL | Image re-encode on upload. Keep. |
| `_shared/imageSanitize.mjs`, `_shared/webPush.mjs` | GLOBAL | Libraries. Keep. |
| `workers/keepalive` (Cloudflare) | GLOBAL | Pings `rpc/job_health_status`. Keep. |
| `functions/_middleware.js` (Pages) | GLOBAL | Disclosure control. Already blocks `/docs/`, so `docs/circles/` stays private. Keep. |

### pg_cron jobs

| Job | Schedule | Calls | Class |
|---|---|---|---|
| `notif-batch-flush` | */15 min | `notif_batch_flush_due()` | GLOBAL-SELF |
| `notif-push-send` | */3 min | edge `notif_push_send` | GLOBAL-SELF |
| `streak-at-risk-notify` | daily 16:11 | `notif_streak_at_risk()` | GLOBAL-SELF |
| `chal-notify-ending-soon` | hourly :23 | `chal_notify_ending_soon()` | SCOPE |
| `telemetry-retention-purge` | daily 03:47 | `retention_purge_telemetry()` | GLOBAL (table list changes after the strip) |
| `purge-due-accounts` | daily 03:29 | `purge_due_accounts()` | GLOBAL-SELF |
| `idempotency-purge` | daily 03:19 | `idem_purge()` | GLOBAL |
| `training-log-usage-purge` | daily 03:47 | `training_log_usage_purge()` | GLOBAL (kept, standalone app) |
| `job-health-check` | hourly :53 | `job_health_check()` | GLOBAL (rewire alerts, section 1 note 4) |
| `purge-abandoned-profiles` | daily 03:31 | edge function | GLOBAL-SELF (rewrite) |
| `recap_monthly` | monthly | `recap_monthly_generate()` | DROP |
| `recap-weekly` | Mon 05:11 | edge function | DROP |
| `community-health` | Mon 04:43 | `community_health_generate()` | DROP |
| `coach-engagement-decline` | daily 06:17 | `coach_detect_engagement_decline()` | DROP |
| `coach-engagement-decline-notify` | daily 06:29 | `coach_notify_engagement_flags()` | DROP |
| `feed-weights-recompute` | unscheduled in `202609060015` | `recompute_feed_weights()` (no-op stub) | DROP the function |

The strip migration must `cron.unschedule` every DROP job before dropping the function it calls, or `job-health-check` flags a failing job.

## 4. Rules in CLAUDE.md and the docs that conflict with the decisions

The first list is CLAUDE.md. Each line is what has to change, not an argument.

| Where | Rule | Conflicts with | What has to change |
|---|---|---|---|
| CLAUDE.md, intro | "ships to real members… production project holding real profiles, posts and training logs" | Correction A | Real data is `training_log_usage` only. Community tables hold test accounts. Rewrite. |
| CLAUDE.md, Rules | "Never store health, payment, phone or email data… username mapped to a synthetic `@members.haimuniya.invalid` address… no real address exists to leak" | Decision 4 | Email exists, in `auth.users` only. New rule: never copy an email into a public table or column, never return it from an RPC. Phone, payment and health stay banned. |
| CLAUDE.md, Rules | "Arbox owns bookings and payments; this app is what happens after training" | Brief | Arbox is gone. |
| CLAUDE.md, Desktop | Staff desktop shell gated on `is_staff()`, `data-staff="1"`, "member layouts on desktop must not change" | No staff | Whole section goes with `src/desktop-layout.js`, `desktop-staff-shell.mjs`, `desktop-layout.mjs`. Decide whether the 560 px logging column rule survives for the standalone-derived screens. |
| CLAUDE.md, Rules | "Migrations reach production through `npm run push:prod`" and "never edit an applied migration" | none, but constrains | Stay in force. Strip and schema work are forward migrations. Do not rewrite history because there are no real users. |
| CLAUDE.md, Parallel work | "Only one open branch adds a migration at a time" | none, but constrains | Sessions 2, 3 (if it adds one), 4, 5, 6 must run strictly one after another. |
| CLAUDE.md, Parallel work | Branches do not edit `CHANGES.md`, `PROJECT_STATUS.md`, `SHARED_CONTEXT.md`, `APP_VERSION` | none | This docs PR does not touch them. Changelog entry for it is below. |
| CLAUDE.md, Rules | "Any new file the app loads goes into the `sw.js` precache list" | none, but constrains | Deleted `src/*.js` files must also leave `sw.js` and `index.html`, or `test/sw-precache.test.mjs` fails. |
| CLAUDE.md, Automated review | Reviewer checklist names staff-surface and "member health, payment, phone or email data" | Decisions 4 and no staff | Reword to the new email rule and add cross-circle reads. |
| CLAUDE.md, Verification | Names `npm run check:drift`, `supabase test db` | none | Unchanged. |

| Where | Rule | Conflicts with | What has to change |
|---|---|---|---|
| `docs/community/backlog.md:2992`, `:3057-3059` | "Club model: approved. Keep `club_id`, one club row, no multi-tenant" | Decision 1 | Superseded. Also cited in a code comment at `cloud.js:4193-4200`. |
| `backlog.md:3061`, `:1562`, `:1969-1979` | "Friends means mutual follows" and `only_me` / `friends` visibility, `are_friends()` / `relationship_score()` drift pin | Decision 3 | Follows, friends and visibility all go. |
| `backlog.md:2985-2987`, COMM-016 | Identity "recoverable and required. Verified email plus password" | CLAUDE.md, not the decisions | The backlog already says verified email while CLAUDE.md and COMMUNITY_SETUP say synthetic. The two disagree today. Decision 4 settles it for the backlog's side. |
| `COMMUNITY_SETUP.md:75-79` | "Confirm email OFF… The app never configures SMTP and never will… every account's email field is a synthetic, never-delivered address" | Decision 4 | Confirm email ON, a real mail provider, redirect URLs. |
| `COMMUNITY_SETUP.md:85-97` | Anonymous session, redeem invite, then `updateUser({email, password})` links the same uid | Decisions 4, 5 | The upgrade path with a real address triggers the email-change confirmation flow. The sign-up flow needs a redesign, not a patch. See open question O1. |
| `README.md:38-46` | "no email, no magic link", "gated by a box invite code", following/blocking, coach announcements, box-wide challenge | Decisions 3, 4, 5, no staff | Rewrite. |
| `PRIVACY.md:499`, `:541`, `:591` | "no email address", "no username, no password and no email" | Decision 4 | Mixed: the standalone app still keeps that promise, the community app no longer can. Split the policy. |
| `PRIVACY.md:742`, `:790-803` | Coach follow-up task, "Allow members to follow me" toggle | No staff, decision 3 | Remove. |
| `docs/deploy/PER_CLUB_SETUP.md:5-12` | "single-club… should not be made multi-tenant lightly… a second club is a separate deploy" | Decision 1 | Superseded. |
| `docs/audit/AUTHORIZATION_MATRIX.md` section 4 | "Cross-club isolation (answer: there is none)", SEC-008 | Decision 1 | This is the work list for sessions 4 to 6, not a conflict to patch. |
| `docs/ops/INCIDENT_RESPONSE.md:6` | "a single club's app, run by its coaching staff" | No staff | Who responds is the repository owner. |
| `cloud-config.js:120-130` (code comment) | "THE CLUB'S OWN NAME IS NOT HERE… a second box gets BoxLog" | Decision 1 | Per-box branding is moot. The circle name comes from the database already, which still fits. |

No conflict found in `functions/_middleware.js` or `test/public-surface.test.mjs`. Not read for conflicts: `TERMS.md` beyond a grep, `docs/audit/*` apart from the matrix, `docs/owner-guide`.

## 5. Session order

A closing session (reconcile docs, version bump, full suites, merge-result
check) follows each wave. Only one open branch adds a migration at a time, so
the schema-touching sessions run strictly in sequence.

| # | Session | Scope |
|---|---|---|
| 1 | Secret scan | Scan the full git history for secrets, emails, phone numbers and the gym name. Report only; no rewrite. |
| 2 | CI for pgTAP | `test.yml` runs `supabase test db` on every PR that touches `supabase/`. |
| 3 | Strip gym | Remove all DROP features (client, edge functions including `sanitize_upload`, tables, functions, cron jobs, `post-photos`, `avatar-photos`, `training_log_usage`, Realtime code), their tests and precache entries; stub staff-style helpers until the schema session. |
| 4 | Definer guard | pgTAP guard over `pg_proc` plus the reviewed-functions table: empty `search_path`, execute revoked from public and anon, no unreviewed definer. |
| 5 | Circles schema | `circle_members`, types and limits, `share_defaults`, hash-only invite table, `clubs` single-row guard removed, anonymous sign-ins off, profile reduced to display name and emoji, cross-circle leak tests per table. |
| 6 | Circles RPCs | `join_circle` and invite creation with rate limits, create/leave/remove/ownership handoff, last-member delete, per-circle post sharing, targets and weekly counts, benchmark-of-month visibility rule. |
| 7a | Circles client (parallel with 7b) | Circle switcher, create/settings screens, first-run and empty-circle screens, logging prefill, percent-of-target views, privacy-first sharing on device. |
| 7b | Share cards (parallel with 7a) | Canvas cards on device, Hebrew RTL, PR card and weekly circle card, Web Share file with download fallback. |
| 8 | Sharing pipeline | Logging as sharing by circle defaults, one-tap skip, reactions, "trained together" confirmation, unreacted-PR surfacing. |
| 9 | Repo split | New Supabase and Cloudflare Pages projects, repoint config, re-enable scheduled workflows (keepalive, encrypted backup, job alert). |
| 10 | Notifications | Two opt-in notifications, quiet hours, weekly card readiness Saturday night Asia/Jerusalem. |
| 11 | Rebrand | Name, icons, copy, README, remove gym language everywhere. |
| 12 | Pilot readiness | Invite page (in-app browser detection, Add to Home Screen step), security procedure, database definition, Hebrew privacy page, account deletion and export checks. |

Sessions 7a and 7b touch different files and add no migration, so they can run in parallel.

## 6. Open questions

Resolved by the 2026-10-25 decisions:

| # | Question | Answer |
|---|---|---|
| O1 | Anonymous sign-ins | **On** (revised 2026-10-25). Sign-up starts anonymous, joins a circle with `join_circle`, upgrades to username and password. Turnstile is enforced server-side; a user in no circle sees nothing. |
| O2 | Events | Drop. |
| O3 | Achievements, PR shares, challenges | Achievements are per user. PR shares are posts, one per circle. Challenges are not kept (not in the keep list). |
| O5 | Abuse handling without staff | No reports or posting restrictions. A circle is invite-only among friends: the owner removes members, anyone can leave, account deletion exists. |
| O6 | Search | Dropped. People are added by invite link only. |
| O7 | Limits | 10 circles per user, 2 members (Couple) or 20 (Friends) per circle, invites 7-day expiry with a use limit. Rate limits: see O9. |
| O4 | Profile fields | Profile is display name and emoji only, the same in every circle. No other profile fields; `visible_to_club` is dropped. |
| O8 | Recovery method | Keep the existing recovery mechanism. No passkeys for now. |
| O9 | Rate limits | `join_circle`: 10 attempts per user per hour. Invite creation: 20 per circle per day. |
| O10 | Avatars | Drop avatars and the `avatar-photos` bucket. Emoji instead. |
| O11 | Edge functions | Keep `purge_abandoned_profiles` and `notif_push_send`. Drop `sanitize_upload`. |
| O12 | Realtime code | Remove the Realtime code; do not gate it. |
| O13 | Benchmark of the month | The circle owner picks the benchmark from the fixed list of eight named benchmarks the app already has. |

Opened by the Circles RPCs session (2026-10-25), for the Circles client session or the owner:

| # | Question |
|---|---|
| O14 | Turnstile is enforced by Supabase Auth only once the secret is set in the new project's dashboard (`COMMUNITY_SETUP.md`, the dashboard step), and `captchaSiteKey` in `cloud-config.js` is still `""`. Both belong to the repo-split session; until then sign-up is not CAPTCHA-protected. |
| O15 | The five reaction kinds are `cheer` (fist bump), `fire`, `strong`, `clap`, `heart`. Change the extras? |
| O16 | `member_targets` is one row per person, so a weekly target is the same in every circle although `decisions.md` lists it under per-circle member settings. Make it per circle? |
| O17 | `purge_abandoned_profiles` still deletes anonymous accounts older than 30 days with no recovery stamp, circle members included. Exclude circle members? |

Everything else from the original questions is settled.
