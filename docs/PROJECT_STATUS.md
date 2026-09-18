# Project status report — האימוניה / haimunia-app-demo

Written 2026-09-18 against `claude/project-status-report-6269k2` (identical to
`origin/main`, HEAD `1366769`, working tree clean). Everything below was read
out of the repository at that commit; where a repo document disagrees with the
code, the code is reported and the stale document is named.

## Snapshot

- App version 4.74.0 (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js by a git hook).
- One club, live, with real members. Despite the `-demo` name, `cloud-config.js` points at the production Supabase project `jajmlyrjlkhclgphbfbb` (free tier).
- Hosted on Cloudflare Pages at https://haimunia-app.pages.dev. GitHub Pages was torn down on 2026-09-17 and the repo went private the same day. README.md still describes GitHub Pages hosting and is stale on that point.
- 173 migrations, 115 pgTAP files, 208 Node test files, 47 browser-check scenarios, 5 Edge Functions, 4 GitHub workflows.
- Last reported verification (commit 1366769, not re-run in this session): 1921 JS tests, 46 browser scenarios green; 3515 pgTAP assertions and 173 migrations in agreement as of 63ccafe.

## Tech stack

- No build step, no framework, no bundler. Cloudflare Pages serves the repo root verbatim, so every committed file is a URL; `functions/_middleware.js` is a Pages Function that 404s `docs/`, `supabase/`, `test/`, `scripts/` and the audit markdown. It is disclosure control, not a secret store, and says so in its own header.
- Vanilla ES5-ish JS in three big files plus small ES modules under `src/`. Hebrew/RTL throughout, installable PWA with a service worker and IndexedDB.
- Supabase: Postgres + RLS + ~230 SQL functions (RPCs) + 4 views, Deno Edge Functions, pg_cron for scheduled jobs, Supabase Storage for post photos and avatars, Realtime for the feed.
- `@supabase/supabase-js` 2.115.0, vendored into `vendor/` for the buildless runtime; npm is used only for tests (`node --test`, jsdom, fake-indexeddb) and the check scripts. Node 22+.
- Cloudflare Turnstile on anonymous sign-in (site key live as of 2026-09-17).

## File structure

- `index.html` (2,862 lines) — the shell plus all design tokens and ~225 component classes in one inline `<style>`.
- `app.js` (8,069) — the offline-first training log: tabs, IndexedDB store, achievements, calendar, charts, WOD builder, nav registry.
- `cloud.js` (22,204) — the entire community half: Supabase client, sign-in, feed, boards, directory, account, coach tools, the two management panels.
- `src/` — shared ES modules: `db.js`, `outbox.js`, `analytics.js`, `sanitize.js`, `eventbus.js`, `realtime.js`, `image.js`, `dormancy.js`, `format.js`, `constants.js`, and `src/shared/safe-helpers.js` (escaping plus the brand accessors).
- `cloud-config.js` — Supabase URL, publishable key, VAPID public key, brand block, captcha site key. Public by design.
- `supabase/` — `migrations/` (173), `tests/` (115 pgTAP), `functions/` (5 Deno functions plus `_shared/webPush.mjs` and `_shared/imageSanitize.mjs`), `config.toml`.
- `scripts/` — `browser-check/` (47 real-Chromium scenarios), `visual-qa/`, `owner-guide/`, plus check scripts: migration drift, migration immutability, deploy readiness, edge-function deployment, scheduled-job health, anon-key smoke test, version sync.
- `test/` — 208 Node test files (jsdom).
- `docs/` — `audit/` (43 audit and protocol documents), `community/` (backlog, tickets, contracts, metrics), `handover/` (the current, freshest state: `SHARED_CONTEXT.md`, `OWNER_ACTIONS.md`, two session files).
- Root also carries `CHANGES.md` (346 KB narrative changelog), `PRIVACY.md`/`TERMS.md` and their rendered HTML, `sw.js`, `theme-init.js`, `frame-guard.js`, `manifest.json`, icons.
- `.github/workflows/` — `test.yml` (node tests, version checks, npm audit, Deno lockfile freeze, edge-function-deployed check, browser checks), `deploy-edge-functions.yml`, `backup-database.yml` (nightly encrypted dump, weekly restore drill), `scheduled-job-alert.yml`.

## Branding as it stands

Name: האימוניה. The product name is configurable through `cloud-config.js` `brand` (`appName`, `wordmark`, `championTitle` — currently "האימוניה", "האימוניה", "אלוף האימוניה") and read at call time via `brandName()` / `brandWordmark()` / `brandChampionTitle()` in `src/shared/safe-helpers.js`. The club's own name is deliberately not configurable — it lives in the `clubs` table. `manifest.json`, `index.html`, `sw.js`, `terms.html` and `privacy.html` still carry the literal name, because a buildless app cannot template them.

Colors — light theme (bare `:root`): `--bg` #F2F5FA, `--surface` #FFFFFF, `--surface2` #E9EFF8, `--border` #D6DFEC, `--chalk` #1C2536, `--steel` #57627A, `--energy` #E85D3D (the one primary accent), `--brass` #8a5d25, `--blue` #2E5AA8, `--green` #2E7A48, `--red` #C2392C, `--teal` #1E7D76, `--purple` #7A4FC2, `--yellow` #B07E12, plus text-only variants `--energy-text` #AD4023, `--red-text` #C0382C, `--green-text` #256B3D and `--avatar-ink` #ffffff.

Dark theme (declared twice — once under `prefers-color-scheme`, once under `:root[data-theme="dark"]`, so the in-app toggle always beats the OS): `--bg` #152342, `--surface` #1F3057, `--surface2` #2A3D6B, `--border` #425481, `--chalk` #F2ECE1, `--steel` #A8B3C9, `--energy` #E85D3D, `--brass` #E8B98A, `--blue` #3E6FD9, `--green` #4B9B5F, `--red` #D2433A, `--teal` #3FA7A0, `--purple` #9B6FD9, `--yellow` #E0B23C, `--energy-text` #FF7F53, `--red-text` #FF7869, `--green-text` #5CBB74, `--avatar-ink` #1a0d08. `theme-init.js` stamps dark by default. PWA `theme_color` and `background_color` are #152342.

A second, newer layer of `--club-*` tokens drives the immersive photo scenes: `--club-coral` (an alias for `--energy`, deliberately, rather than the spec's own #f0443e), `--club-coral-strong` #d92f2b, `--club-navy` #081523, `--club-navy-2` #10243a, `--club-cream` #f7f2e9, `--club-paper` #fffdf8 (#0b1726 in dark), `--club-ink` #111b2b, `--club-muted` #697386, `--club-success` #278553, plus the `--scene-*` geometry tokens.

Fonts, all self-hosted woff2 under `assets/fonts/` and precached by the service worker — `font-src 'self'`, no Google Fonts, no CDN: Rubik 400/600/700/800/900 (body, Latin + Hebrew cuts), Anton 400 (display, Latin only), Secular One 400 (display, Hebrew only), JetBrains Mono 500/700 (numbers and workout notation, Latin only). The display stack is `'Anton','Secular One','Rubik',sans-serif` and the order is load-bearing — `unicode-range` routes Latin to Anton and Hebrew to Secular One, with Rubik as the catch-all. Display faces must stay at weight 400; each ships one cut.

`docs/DESIGN_HANDOFF.md` is stale on two tokens: it documents `--energy` as #C94B29 and `--brass` as #956529. Both have since moved (`--energy` to the shared coral, `--brass` darkened again after an axe pass on `.chip-btn.selected`).

## Implemented features

Training log (app.js, works fully offline with no backend configured; five bottom tabs — רישום, התקדמות, לוח שנה, אימונים, קהילה):

- Strength logging with sets, supersets, RX/scaled, per-movement history and 1RM/PR detection; an absurd-weight confirmation guard at ≥3× the heaviest ever logged.
- WOD logging and a WOD builder (AMRAP, for-time, EMOM with movement/rep/minute fields and a time cap), custom WODs, a workout library.
- Bodyweight, custom measurement types and measurements; progress charts; a month-grid calendar with day detail and status flags; current-streak computation.
- Achievements and athlete levels built at module evaluation, including the capstone champion title.
- Install prompts (including an iOS home-screen hint), light/dark/auto theme toggle, a large-text scale (1.2×), full RTL, and an offline-first IndexedDB store with an outbox that syncs to `private_records` when a community session exists.

Community (cloud.js, sub-tabs פיד / לוחות / חברים / חשבון, plus a staff-only tab):

- Invisible sign-in: username-only accounts mapped to a non-routable `@members.haimuniya.invalid` domain, gated by an invite. Anonymous session first, upgraded to a permanent account; Turnstile on the anonymous call.
- Feed with server-side ranking and cursor pagination, diversity rules, impression and interaction telemetry, coalesced re-render, realtime updates, hide/save a post, report a post or a profile.
- 13 structured post types: POST_TEXT, POST_WORKOUT, POST_PR, POST_ACHIEVEMENT, POST_PHOTO, POST_CHALLENGE, POST_EVENT, POST_ANNOUNCEMENT, POST_COACH, POST_SYSTEM, POST_NEW_MEMBER, POST_ATTENDANCE_MILESTONE, POST_CLUB_WOD. Multi-photo with alt text and a decorative flag, visibility control, author edit and delete, per-type cards.
- Reactions (one per member per post), threaded comments to 2 levels with mentions, edit and delete own, coach comment priority, and block effects throughout.
- Follows and blocks (blocking unfollows both ways), a member directory, profile pages with 12 individual privacy toggles.
- Achievements: definitions, member unlocks, claim with tenure and forgery verification, six categories, share-to-feed prompts, PR sharing that upgrades an existing workout post rather than duplicating it.
- Challenges: six types including cooperative and team challenges, teams with captains, join/leave, progress entry and a progress view, ending-soon notifications and a boards badge, plus a weekly club-wide challenge leaderboard.
- Events: list and detail, RSVP with a capacity lock, event types, map links, cancellation notifications, event comments.
- Club WOD: a catalogue, a coach publishing a session for a day with a publish day cap, one feed card and one board per session, members attaching their own logged results.
- Notifications: a notification centre with per-type preferences, immediate vs batched delivery (15-minute flusher), deep links, redaction of moderated content, and web push (VAPID, encryption verified byte-for-byte against the spec's published example, delivered by the `notif_push_send` Edge Function every 3 minutes).
- Recaps and onboarding: weekly member recaps, a monthly club recap with admin preview and publish, a new-member onboarding sequence with editable step content and an intro carousel.
- Attendance-derived signals: attendance log, classmate signal, relationship score, consistency, attendance achievements, member-of-the-week.
- Coach tools: celebrate / welcome / challenges sections with one-tap congratulate (once per target), engagement-decline flags and alerts, member contact log, inactive-member views.
- Bug reporting from inside the app, into an admin inbox with status and notification.
- Two separate management screens, both hamburger-only: ניהול המועדון (head coach — invites, roster, club health, moderation and restrictions, the club's numbers, onboarding content) and ניהול מערכת (admin — bug inbox, audit log, module toggles, roles and passwords). The admin panel asks for the password a second time and re-locks after 15 minutes, held in memory only.
- 20 club feature toggles (`club_features`): announcements, events, challenges, achievements, feed, leaderboards, directory, weekly_recap, comments, post_photos, mentions, outward_share, push_notifications, club_wod, streak_risk_nudges, coach_tools, member_of_week, welcome_flow, new_member_posts, monthly_recap, engagement_alerts. Some are server-enforced, some are marked `clientOnly` in the panel because they hide a control rather than being enforced by RLS — the panel says which is which.
- Moderation: report queue, post removal, posting restrictions (one active per member) with lift, an audit log the audited cannot read, and admin password reset through an Edge Function with a rate limit.
- Privacy and lifecycle: account deletion requests with a 30-day purge, an abandoned-profile purge that excludes any account holding training data, telemetry retention purge, idempotency-record purge.
- Analytics: an events pipeline, an admin dashboard, member segments, retention cohorts, a community health score, a registration funnel.

Infrastructure: nightly encrypted database backups with a weekly restore drill (proven restorable 2026-09-17), migration drift and immutability checks, an Edge-Function-deployed check in CI, a scheduled-job health checker, write idempotency on the outbox actions, and 13 pg_cron jobs (notification batch flush every 15 min, push send every 3 min, challenge ending-soon hourly, streak-at-risk and engagement-decline daily, purges daily, weekly recap/feed-weights/community-health on Mondays).

## Supabase schema

62 tables in `public`, all with RLS enabled, plus policies on `storage.objects`. 148 policies across 56 relations; ~230 SQL functions, most of them SECURITY DEFINER RPCs that carry the real authorization; 4 views (`community_feed`, `community_streaks`, `weekly_challenge_leaderboard`, `admin_user_directory`). Baseline grants revoke everything in `public` from `anon` and `authenticated`, and default privileges are locked, so table access exists only where a grant plus a policy was added deliberately.

Tables and columns, in migration order:

```
  profiles(id, handle, display_name, bio, avatar_url, is_admin, deleted_at, created_at, updated_at, club_id, visible_to_club, show_workout_results, show_attendance, show_upcoming_booking, show_prs, show_achievements, in_leaderboards, allow_follows, allow_mentions, allow_messages, show_in_attendee_lists, recovery_verified_at, assigned_coach_id)
  private_records(user_id, record_type, record_id, payload, deleted_at, created_at, updated_at)
  follows(follower_id, followed_id, created_at)
  blocks(blocker_id, blocked_id, created_at)
  workout_posts(id, author_id, source_type, source_record_id, visibility, title, result_text, comparison_key, score_value, score_direction, rx, occurred_on, published_at, deleted_at, photo_path, club_id, post_type, status, source_id, body, metadata, is_pinned, created_at, updated_at)
  reactions(post_id, user_id, kind, created_at)
  reports(id, reporter_id, post_id, reason, details, status, created_at, reviewed_at, reviewed_by, resolution_notes, target_type, target_id, review_note)
  account_deletion_requests(user_id, requested_at, purge_after)
  announcements(id, author_id, title, body, created_at, deleted_at, pinned_date, important, priority, expires_at)
  activity_pings(user_id, activity_date, created_at)
  weekly_challenges(id, comparison_key, title, starts_on, ends_on, created_by, created_at)
  invite_codes(role, active, created_at, id, code_hash, expires_at, max_uses, use_count, revoked_at)
  invite_redemptions(user_id, role, redeemed_at, invite_id, person_invite_id)
  post_comments(id, post_id, author_id, body, created_at, club_id, parent_comment_id, edited_at, deleted_at, status, deleted_by)
  invite_attempts(user_id, window_started_at, attempt_count, last_attempt_at, actor_key_hash)
  rate_limits(user_id, action, window_started_at, attempt_count)
  clubs(id, name, attendee_lists_enabled, settings, created_at)
  roles(code, label, rank)
  permissions(code, description)
  role_permissions(role_code, permission_code)
  admin_actions(id, club_id, admin_id, action_type, target_type, target_id, before_data, after_data, created_at, admin_display, target_user_id, target_display, action_detail, note)
  post_media(id, club_id, post_id, storage_path, alt_text, position, width, height, created_at, decorative)
  feed_impressions(id, club_id, user_id, post_id, position, feed_session_id, shown_at, opened, engaged)
  feed_interactions(id, club_id, user_id, post_id, kind, created_at)
  achievement_definitions(id, club_id, code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config, created_at)
  member_achievements(id, club_id, user_id, achievement_id, source_id, unlocked_at, shared_at, visibility, repeatable, verified)
  notifications(id, club_id, user_id, type, category, title, body, source_type, source_id, deep_link, read_at, push_sent_at, created_at)
  notification_preferences(user_id, type, channel, updated_at)
  push_subscriptions(id, user_id, endpoint, keys, created_at, revoked_at)
  challenges(id, club_id, title, description, challenge_type, metric_type, target_value, start_at, end_at, join_mode, visibility, status, created_by, config, created_at, ending_soon_notified_at)
  challenge_teams(id, club_id, challenge_id, name, created_at, captain_id)
  challenge_participants(challenge_id, user_id, club_id, team_id, joined_at, status, progress_value, completed_at)
  challenge_progress(id, club_id, challenge_id, user_id, delta, source_type, source_id, created_at, team_id, note, entered_by)
  events(id, club_id, title, description, event_type, image_url, location, map_link, start_at, end_at, capacity, registration_deadline, created_by, status, created_at)
  event_attendees(event_id, user_id, club_id, response, registered_at)
  coach_engagement_flags(id, club_id, user_id, level, baseline_sessions_per_week, recent_sessions_per_week, flagged_at, reviewed_by, reviewed_at, status, notified_at)
  analytics_events(id, club_id, user_id, event_name, props, schema_version, created_at)
  hidden_posts(user_id, post_id, club_id, created_at)
  saved_posts(user_id, post_id, club_id, created_at)
  posting_restrictions(id, club_id, user_id, restriction_type, expires_at, reason, moderator_id, source_report_id, created_at, lifted_at, lifted_by, lift_reason)
  pins(id, club_id, target_type, target_id, slot, pinned_by, note, created_at)
  notification_batches(user_id, club_id, category, pending_count, pending, window_started_at, next_flush_at, last_flushed_at, updated_at)
  comment_mentions(comment_id, mentioned_user_id, club_id, created_at)
  weekly_recaps(id, user_id, club_id, week_start, sessions_completed, streak, prs, achievements, challenge_progress, club_challenge_progress, upcoming_event, generated_at, classmates)
  onboarding_progress(user_id, welcomed_at, first_week_shown_at, first_month_shown_at, first_class_shown_at, third_class_shown_at)
  member_contact_log(id, user_id, contacted_by, contacted_at, note)
  attendance_log(id, user_id, club_id, occurred_on, source_record_type, source_record_id, recorded_at)
  member_feed_weights(user_id, weights, computed_at)
  member_of_week(id, club_id, week_start, category, user_id, reason, post_id, published_by, published_at)
  monthly_club_recaps(id, club_id, month_start, sessions_logged, posts_created, new_members, challenges_completed, events_held, generated_at, published_at)
  community_health_scores(id, club_id, week_start, score, components, computed_at)
  club_features(club_id, module_key, config, enabled, updated_by, updated_at)
  invites(id, club_id, code_hash, role, label, created_by, created_at, expires_at, revoked_at, revoked_by, redeemed_at, redeemed_by)
  onboarding_step_content(step, title, body, updated_by, updated_at)
  intro_carousel_content(step, title, body, updated_by, updated_at)
  request_idempotency(user_id, action, idempotency_key, result, created_at, fingerprint)
  weekly_challenges_archive(id, comparison_key, title, starts_on, ends_on, created_by, created_at, archived_at, archived_by_migration, archived_reason)
  club_wods(id, club_id, wod_id, name, description, score_type, emom_movements, emom_target_reps, emom_minutes, time_cap_seconds, published_by, published_at, retired_at, retired_by, retired_reason)
  club_wod_sessions(id, club_id, wod_id, session_date, note, post_id, published_by, published_at, cancelled_at, cancelled_by, cancelled_reason)
  club_wod_results(session_id, user_id, record_id, result_text, score_type, rx, occurred_on, attached_at, updated_at)
  coach_congratulations(id, coach_id, kind, target_user_id, occurred_at, comment_id, post_id, created_at)
  bug_reports(id, reporter_id, body, diagnostics, status, admin_note, handled_by, handled_at, created_at)
```

### RLS policies

Seven tables have RLS on and no policy at all, which makes them unreachable except through SECURITY DEFINER RPCs and the service role: `invite_codes`, `invites`, `invite_attempts`, `rate_limits`, `request_idempotency`, `coach_congratulations`, `bug_reports`.

Every other policy is `to authenticated`. The shapes, by group:

- Self-only rows (select/insert/update/delete keyed on `auth.uid()`): `private_records`, `notification_preferences`, `push_subscriptions`, `hidden_posts`, `saved_posts`, `blocks`, `activity_pings`, `feed_impressions`, `feed_interactions`, `onboarding_progress`, `notifications` (select + update to mark read), `notification_batches`, `weekly_recaps`, `member_feed_weights`, `attendance_log` (self), `invite_redemptions`, `account_deletion_requests`.
- Club-visible reads gated on `is_community_member()` and, where it applies, `club_feature_enabled(...)`: `announcements`, `challenges`, `challenge_teams`, `challenge_participants`, `challenge_progress` (participant-scoped), `events`, `event_attendees`, `achievement_definitions`, `member_achievements`, `weekly_challenges`, `weekly_challenges_archive`, `member_of_week`, `pins`, `club_wods`, `club_wod_sessions`, `club_wod_results`, `clubs`, `club_features`, `roles`, `permissions`, `role_permissions`, `onboarding_step_content`, `intro_carousel_content`, `posting_restrictions`, `comment_mentions`.
- `profiles`: select requires `deleted_at is null`, no block edge in either direction, and either self or (`is_community_member()` and `visible_to_club`) or admin. Insert is self-only and forces `is_admin = false` with an existing redemption. Update is self-only; `is_admin`, `club_id` and `recovery_verified_at` are pinned by the `protect_is_admin()` trigger rather than by the policy.
- `workout_posts`: `posts_feed_select` (visibility + block + feature flag + membership), `posts_insert_self` (`is_community_member()` and `has_perm('community.post.create')` and not restricted), `posts_update_self` / `posts_delete_self` keyed on author, plus a second permissive `posts_select_admin_review` so an admin can read removed, deleted and blocked-author posts for moderation.
- Write-through-RPC-only: `post_comments` insert, `reactions` insert, `reports` insert and `challenge_progress` writes have their direct grants revoked or narrowed, so the rate limits, idempotency and notification triggers inside the RPCs cannot be bypassed.
- Staff/admin-scoped: `coach_engagement_flags`, `member_contact_log`, `admin_actions` (admin only — the audit log is not analytics), `analytics_events` (insert self, read with `community.analytics.view`), `community_health_scores` (admin), `monthly_club_recaps` (staff, plus a published-only read for members).
- `storage.objects`: post photos are insert/delete by owner and readable only if the post or media row is visible; the avatar bucket is private, with insert/update/delete by owner and reads limited to own-or-visible.

## Auth and roles today

Sign-in has no email for ordinary members. A member's account is a username mapped onto `@members.haimuniya.invalid`, a non-routable domain, so the club collects no email addresses. Signup starts as a Supabase anonymous session (`enable_anonymous_sign_ins = true`) and becomes a permanent password account; Cloudflare Turnstile now guards that anonymous call (`captchaSiteKey` is live in `cloud-config.js`, and `withCaptcha()` refuses rather than failing open if the provider script cannot load). Password policy is 10 characters minimum, lower+upper+digits. Magic links and email confirmation are off.

Membership is gated by an invite. Two shapes exist: a shared club join code (`invite_codes`, hashed, with max uses, expiry and a revoke flag) and per-person invites (`invites`). A member counts as a member only once `invite_redemptions` holds a row and `profiles.recovery_verified_at` is set — that is `is_community_member()`, and it is what most read policies check. A session with neither is a "ghost": a real `auth.uid()` with no profile and no redemption, and the anonymous read gate exists specifically to make that session read nothing.

Six role codes are seeded in `roles`: member (10), coach (20), head_coach (30), staff (40), admin (50), owner (60). The rank drives two primitives: `is_staff()` is rank ≥ 20, `is_admin()` is rank ≥ 50 or `profiles.is_admin`. Permissions live in `permissions` / `role_permissions` and are checked with `has_perm(code)`. A role is carried on `invite_redemptions.role`; admin is carried by the `profiles.is_admin` flag.

The current division of labour, set by the owner on 2026-09-15: the head coach runs the club and the admin runs the app. head_coach holds `community.member.invite`, `community.invite.manage_codes`, `community.analytics.view`, `community.club.manage_modules` and `community.content.manage_onboarding` on top of the content permissions (announcements, challenges, events, pinning, comment moderation, member restriction, delete-any-post). Four things stay admin-only and are hardcoded `is_admin()` inside their own RPCs rather than permission-gated, so the permission table cannot widen them: role changes, password resets, the audit log, and bug-report triage. Minting a coach-role invite additionally requires `is_admin()` inside `invite_create()`.

Management is deliberately not a membership. The admin account is a separate login with a real email address (so Supabase's own password reset works for the one account that cannot ask another admin), holds `is_admin` and no invite redemption, and reaches its panels through a second Supabase client (`makeMgmtClient()`) independent of the Community tab's member session. The head-coach account keeps its redemption, because the head_coach role has nowhere else to live. The owner's own member account currently holds `is_admin` plus `head_coach`.

`service_role` bypasses RLS and never appears in the browser bundle — `cloud-config.js` carries only the URL, the publishable key, the VAPID public key and the captcha site key.

## In progress or half-done

- Web push is built, deployed and scheduled, but no notification has ever been watched landing on a real phone. A failed push returns 201 and shows nothing, so there is no error for anyone to find. `streak_risk_nudges` is switched off until someone confirms a delivery; it is the only feature toggle deliberately off.
- `deploy-edge-functions.yml` still is not deploying. Its trigger was fixed on 2026-09-17, but after a push to a covered path the function was absent from the gateway at six and again at ten minutes, measured against a control probe. Almost certainly a missing `SUPABASE_ACCESS_TOKEN` repository secret; the workflow fails loudly rather than going green, so the Actions tab should show a red run. Until then every Edge Function deploy is a hand-run command — the habit that once left two functions undeployed for weeks.
- `scheduled-job-alert.yml` has failed every day since 2026-09-15, by design: it needs three repository secrets and fails closed. Nothing is watching the cron jobs until they are set, and one of them is `SUPABASE_SERVICE_ROLE_KEY`, which bypasses every RLS policy — the workflow's header argues the blast radius through and it is left as an owner decision, not a checklist tick.
- Personalized feed ranking is dormant by design. `recompute_feed_weights()` is shipped, granted, scheduled weekly and returns 0 — the signature, grants and auth boundary are pinned and the body is deliberately empty rather than shipping an unreviewed heuristic into every member's feed.
- Multi-club support (BoxLog) is parked at the owner's word ("for now it's only 1 club"). The load-bearing half is done — the product name is configurable — and the two traps are pinned by tests: changing the `haimunia-demo:` localStorage prefix silently empties every phone, and changing `members.haimuniya.invalid` locks everyone out with no self-service reset. Both are new-clubs-only.
- The desktop layout is half-addressed. index.html's own measurements say 43.9% of a 1440px viewport carries nothing; the real fix is a context column that no module renders into. The cheap half shipped — the roster and חברים tabs widened — and the other three tabs are argued against by name in the CSS.
- Required status checks are still being bypassed on every push. CI is green end to end now, so the bypass should stop.
- Node 20 deprecation warnings on `actions/upload-artifact` and `actions/download-artifact`; harmless today, worth pinning to a current release by SHA.
- Backlog: of 188 COMM tickets, 153 are done, 6 partial and 1 todo. The open ones are COMM-143 (Phase 1 notifications wired), COMM-329 (headings and landmark regions in the app shell), COMM-337 (clickjacking headers — now partly overtaken by the Cloudflare move), COMM-351/353/354 (cross-repo design-token reconciliation) and COMM-368 (extract the shared safety helpers into a real package).

## Known bugs and knowingly-open limitations

- The training log is bound per device, not per entry. `LOG_OWNER_KEY` gates the club-facing bridges when a second member signs in on the same phone, which stops the real harm found in the round-10 hunt (one member being offered another's results to publish under their own name, which wrote a real misattributed `club_wod_results` row). The cost is that the second member on a shared device cannot attach their own newly logged result either. Per-entry ownership is the fuller fix and was not bolted on.
- `admin_member_roster` still stops one page early in one case. It sorts and pages on `coalesce(redeemed_at, created_at)` but only returns `redeemed_at`, so a profile with no redemption row sorts on a value the client never sees; when such a row lands last on a page there is no correct next cursor and paging stops. The tie-break added in 202609160002 fixes the common timestamp-collision skip but cannot invent the key the client was never sent. Every row already shown is correct.
- The absurd-weight guard cannot fire on a movement's first-ever set — the reference is 0, so a first-set typo of 500 for 50 goes through unquestioned. That is the moment with the highest chance of a fat-finger error and the least protection.
- Client-supplied `updated_at` is discarded on the update path: the `private_records_touch` trigger overwrites it with `now()`. Correct for the pull cursor, which needs one server clock, but it means a row remembers when a write arrived, never when the member made it. Recency is judged from the payload instead.
- Stale-write arbitration trusts device clocks. A device with a badly wrong clock can lose its own writes or win ones it should not. The alternative needs a server-assigned version per record, which the bare-upsert sync path does not have.
- Leaked-password protection will show as a permanent WARN in Supabase's security advisor: it is Pro-plan only on this free-tier project. Generated passwords do the same job.
- The `anon` EXECUTE default on schema `public` cannot be closed — Supabase's bootstrap sets it as `supabase_admin` and the ALTER is refused even from the dashboard SQL editor. Every function that exists today has `anon` revoked explicitly and `supabase/tests/0113` fails CI the moment a new one forgets, so the exposure is only a future function, not a current one.
- The headcoach password is still the weak one it was created with, and was in public git history until the repo went private on 2026-09-17. Rotating it is an owner action.
- A working 500-use join code was published as a QR image on 2026-09-16 and was fetchable for about a day. It has been revoked (`active = false` plus `revoked_at`) and the file is out of git; it was used exactly once, by the owner, testing it. The git history is still what it is, which is why `functions/_middleware.js` is described as disclosure control and not a secret store.
- `CHANGES.md` is stale again — its newest entry is 2026-09-15 while the code is at 2026-09-17. The same drift was already recorded as FEAT-003 in the audit. `README.md` (GitHub Pages), `docs/DESIGN_HANDOFF.md` (two token values), `docs/audit/AUTHORIZATION_MATRIX.md` (read at ~120 migrations, now 173) and `docs/handover/OWNER_ACTIONS.md` (item 1, captcha, since done) all lag the code. `docs/handover/SHARED_CONTEXT.md` is the freshest state document and says v4.73.0/171 migrations against the current 4.74.0/173.

Two defect patterns are named in the repo's own documents and both are worth carrying forward. Sibling drift — a rule fixed in one place and not carried to its twin — accounts for roughly half of every finding across ten bug-hunt rounds. And on 2026-09-16/17, seven separate things reported success while doing nothing (a `_redirects` file Pages never consults, a grep against a dump shape that does not exist, `tar | grep -q` dying on SIGPIPE under pipefail, a workflow input that silently skipped a restore drill, a CSS reconstruction that read the first of two `<style>` blocks, and two more). All seven passed review and all seven were caught only by running them for real.

## Last 15 commits

- 2026-09-17  1366769  Turning the captcha on broke two browser scenarios, correctly
- 2026-09-17  dd527a5  CAPTCHA on, reversing a decision rather than quietly contradicting it
- 2026-09-17  9ce17d2  The CLI prints different output depending on who runs it
- 2026-09-17  63ccafe  An admin switch for push, and the one desktop surface worth widening
- 2026-09-17  8f3b607  Push is deployed and scheduled; the deploy workflow still is not deploying
- 2026-09-17  ecb4329  The deploy workflow never ran on a merge
- 2026-09-17  da8ba8a  The docs said this did not exist
- 2026-09-17  16e2052  Web push: the half that was never built
- 2026-09-17  114ca3b  A command that answers "is production running what the repo says"
- 2026-09-17  ac7edaa  A dead confirm branch, and a toolbar break made deliberate
- 2026-09-17  6615d6f  The prompt told the next session the repo was public
- 2026-09-17  62be7b7  The drift class becomes a test instead of a habit
- 2026-09-17  1bc7f7a  The migration was in the repo for a day and not in the database
- 2026-09-17  8a0f437  Full handover
- 2026-09-17  0f6b86f  Close the anon EXECUTE grant, and the class it belongs to
