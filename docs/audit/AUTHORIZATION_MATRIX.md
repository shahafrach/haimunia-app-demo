# Authorization matrix — real RLS, as written

Security/threat-modeling audit stream. Built by reading every file in
`supabase/migrations/` in filename order and recording the **live** policy text
(the last `create policy` for a given name wins), not the stated intent in any
doc or comment. Every row cites `file:line` of the migration that declares the
policy that is live today.

**Reconciled 2026-09-18 against `main` at `7f30823`, and the sentence that
used to sit here — "nothing here was verified against a running database" — is
no longer true.** The counts and the per-table policy text below were read
from a real Postgres 16 instance built by applying all **173** migrations in
filename order, then queried through `pg_policies`,
`information_schema.role_table_grants` and `pg_proc`.

The caveat that replaces the old one, stated precisely: five migrations could
not apply in that container — `202609050005`, `202609060016`, `202609060018`
and `202609080003` (all need `pg_cron`) and `202609120008` (needs PG17's
`MAINTAIN` privilege). **None of the five creates a table or a policy**, so the
table and policy counts here are complete. What is still *not* verified is
runtime enforcement for two real users; that is what `supabase/tests/*.sql`
does under `supabase test db`, which needs Docker and did not run here.

**That reconciliation read the live database but did not re-read the per-table
rows in section 1 against the migrations that changed them.** Most of those
rows were written on 2026-09-06 against migrations up to `202609060010`, and
**72 migrations have landed since**. They are re-read here, and every row that
moved is marked **(changed 2026-09-06→18)**. The largest single correction is
`202609060011_close_launch_readiness_gap_findings.sql`, which re-gated sixteen
policies on `is_community_member()` and so closed almost the entire
ghost-session read surface this document used to be a catalogue of.

One interaction between the two passes, stated rather than left implicit:
`202609120008` is one of the five migrations that could not apply in that
container, and it is the one that revokes the **TRUNCATE** default privilege
(see § 0). So a grant read from `information_schema.role_table_grants` in that
container reflects the schema *without* it. That does not affect any policy or
count above; it means the container was, on that one axis, the schema as it
stood before 2026-09-12.

Where an outcome could not be fully determined it says so in the Notes column.

### Live totals

| | |
|---|---|
| Tables in `public` | **62**, every one with RLS enabled (none without) |
| Policies | **137** |
| Functions in `public` | **235**, of which **182** are SECURITY DEFINER |

## 0. Roles in play

| Role | What it is |
|---|---|
| `anon` | The publishable key with **no** session. Postgres role `anon`. |
| *ghost* | An **anonymous sign-in** session. Postgres role `authenticated`, real `auth.uid()`, **no** `invite_redemptions` row, **no** `profiles` row. Obtainable by anyone in one unauthenticated POST (`enable_anonymous_sign_ins = true`, `supabase/config.toml:53`). **This is not the `anon` role** and every `to authenticated` policy applies to it. |
| `member` | Redeemed + `profiles.recovery_verified_at` set → `is_community_member()` true (`202609060001_anonymous_read_gate.sql:88`). `invite_redemptions.role = 'member'`, rank 10. |
| `coach` | `invite_redemptions.role = 'coach'`, rank 20 (`202608280001_clubs_and_rbac.sql:48-54`). `is_staff()` true. **7 permissions**, the content half only: `post.create`, `comment.moderate`, `challenge.create`, `event.manage`, `announcement.publish`, `member.invite`, `content.manage_onboarding`. Note what a plain coach does **not** hold: `content.pin`, `post.delete_any`, `member.restrict`, `member.remove`, `analytics.view`. |
| `head_coach` | rank 30, seeded since `202608280001:51`, and the role that **runs the club** since 2026-09-15 (`202609150004_head_coach_runs_the_club.sql`). **13 permissions** — coach's 7 plus `invite.manage_codes`, `analytics.view`, `content.pin`, `post.delete_any`, `member.restrict`, `member.remove`. **(changed 2026-09-06→18.)** Two corrections worth carrying: `club.manage_modules` was granted by `202609150004` and **deleted again six files later** by `202609150011_module_toggles_are_the_admins.sql`, so a head coach cannot switch club modules; and `member.remove` arrived with `202609160005`, which widened `admin_remove_member()` from a hardcoded `is_admin()` to a permission **plus a strict-rank guard** — you reach strictly below your own rank, so a head coach reaches members and coaches, an admin stops short of the owner, and two head coaches cannot delete each other. Four things deliberately did **not** move and stay hardcoded `is_admin()` inside their own RPC, so no permission edit can widen them by accident: role changes (`admin_grant_coach`/`admin_set_role`), password resets (`admin_reset_password`), the audit log, and bug-report triage (`bug_report_set_status`). Minting a **coach-role** invite still requires `is_admin()` inside `invite_create()` (`202609030008:97`), so the tier is not self-propagating. |
| `staff` | rank 40. Seeded with 6 permissions, held by nobody. Latent — and worth knowing, because `weekly_challenges_archive` gates on the *permission* `community.challenge.create`, which this role does not hold. |
| `admin` | `profiles.is_admin = true` → `my_role_code()` resolves `'admin'`, rank 50 (`202608280001_clubs_and_rbac.sql:164-187`). `is_admin()` true — **14 permissions**, head_coach's 13 plus `club.manage_modules`. **The admin account is deliberately NOT a member of the club** (`202609150010_management_is_not_a_membership.sql`): it holds no `invite_redemptions` row, so `is_community_member()` is **false** for it and every member-data policy in section 1 refuses it. That is intended — management routes through `renderManageApp`/`renderClubManageApp`, whose RPCs are `is_admin()`/`is_staff()` gated, never `is_community_member()` gated. `202609150009` briefly made it a full `owner` member and was reverted the same day. **(changed 2026-09-06→18.)** The head coach, by contrast, keeps its redemption: `head_coach` is carried *by* `invite_redemptions.role` and there is nowhere else to put it. |
| `service_role` | Bypasses RLS entirely. Key never in the browser bundle (verified: `cloud-config.js:1-22` holds only URL + publishable key + VAPID **public** key). |

Two authorization primitives:

- `public.is_staff()` = `role_rank(my_role_code()) >= 20` — `202608280001_clubs_and_rbac.sql:238-241`
- `public.is_admin()` = `role_rank(my_role_code()) >= 50` — `202608280001_clubs_and_rbac.sql:245-248`
- `public.has_perm(text)` — `202608280001_clubs_and_rbac.sql:198-210`; `owner` short-circuits to true.
- `public.is_community_member()` — `202609060001_anonymous_read_gate.sql:88-100` (SECURITY DEFINER).

Baseline grants: `revoke all on all tables in schema public from anon, authenticated`
(`202608260001_community_foundation.sql:103`) plus
`alter default privileges in schema public revoke select, insert, update, delete on tables from anon, authenticated`
(`202608270002_lock_anon_defaults.sql:29`). So `anon` (keyless, sessionless) has
no table access anywhere in `public`.

**Two holes in that baseline were found and closed after the first pass, and a
third cannot be closed at all** — all three are about *default* privileges, the
ones a newly created object inherits, not about any object that exists today:

- **`202609120008_default_privileges_truncate_gap.sql`** — `202608270002` named
  four of the seven relevant privilege types. Postgres's default for a fresh
  table also includes **TRUNCATE**, REFERENCES, TRIGGER and (PG17+) MAINTAIN,
  and **TRUNCATE is not gated by RLS at all**. Confirmed live at the time: 42 of
  61 public tables were truncatable by `authenticated`, including `roles`,
  `permissions`, `role_permissions` and `admin_actions` — `truncate table
  public.admin_actions` succeeded as `authenticated` inside a rolled-back
  transaction. No policy in this document could ever have caught that. Now every
  remaining table-level privilege is named. **(new since 2026-09-06.)** This is
  the migration the 2026-09-18 container could not apply, per the header.
- **`202609170001_lock_anon_defaults_reaches_functions.sql`** — the same
  migration never covered **functions**. Nineteen carried an `anon` EXECUTE
  grant; none was exploitable (sixteen are trigger functions, which Postgres
  refuses to call directly; two are `security invoker`, so RLS applies; one is
  pure), but the grant was real and becomes live the day a trigger function
  stops being one. The instructive case is `admin_actions_page`: it **was**
  revoked, twice, for the *three*-argument signature, and `202609150015` added a
  four-argument overload without carrying the revoke. **A revoke names a
  signature; an overload is a new function with default privileges.**
  **(new since 2026-09-06.)**
- **Not closable:** after that ALTER, a new function still comes out
  `=X/postgres | …`, and the leading `=X` is PUBLIC's SQL-default EXECUTE, which
  `anon` inherits through. A second default-ACL entry is owned by
  `supabase_admin`, and altering another role's default privileges raises
  "permission denied" even as `postgres` from the dashboard SQL editor. The
  standing guard is **`supabase/tests/0113`**, which asserts on every CI replay
  from empty that no function in `public` is anon-executable — and asserts the
  opposite direction too, so an over-revoke that closed the hole by breaking
  every screen cannot pass it.

**The exposure surface was the ghost session, not `anon` — and
`202609060011_close_launch_readiness_gap_findings.sql` closed almost all of
it.** Every row below marked **(changed 2026-09-06→18)** in the ghost column is
that migration.

---

## 1. Per-table matrix

Legend: `Y` = permitted, `–` = denied (no grant and/or no policy), `self` =
own rows only, `cond` = permitted subject to the predicate in Notes.

### Identity / membership

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `profiles` SELECT | – | **self only** | Y cond | Y cond | Y (all) | Y | `202609060001:115` — `deleted_at is null AND no block edge AND (id = auth.uid() OR (is_community_member() AND (visible_to_club OR is_admin())))` |
| `profiles` INSERT | – | – | self | self | self | Y | `202608280003:214` — `id = auth.uid() AND is_admin = false AND recovery_verified_at is null AND exists(invite_redemptions)` |
| `profiles` UPDATE | – | – | **self, any column** | self | self | Y | `202608270003:82` — `using(id=auth.uid()) with check(id=auth.uid())`. Column restriction is a *trigger*, not the policy: `protect_is_admin()` (`202608280003:67-78`) pins `is_admin`, `club_id`, `recovery_verified_at` when `auth.role() = 'authenticated'`. Everything else (`handle`, `display_name`, `bio`, `avatar_url`, all 12 privacy toggles) is freely writable. |
| `profiles` DELETE | – | – | – | – | – | Y | no grant |
| `invite_codes` all | – | – | – | – | – | Y | no grant at all (`202608270003:14-18`) |
| `invites` all | – | – | – | – | – | Y | `202609030001:134` RLS on, reached only through `admin_invite_*` definer fns |
| `invite_redemptions` SELECT | – | self | self | self | self | Y | `202608270003:28` — `user_id = auth.uid()`. Cross-member `role` is read only via `member_roles()` (`202609060009:1124-1130`, now gated on `is_community_member()`). |
| `invite_redemptions` I/U/D | – | – | – | – | – | Y | **no write grant** — only `redeem_invite_code()`, `grant_coach_role()`, `admin_grant_coach()`, `admin_revoke_coach()` |
| `invite_attempts` all | – | – | – | – | – | Y | `202608270006:48` revoked from all; `202608280013:35-37` |
| `rate_limits` all | – | – | – | – | – | Y | `202608270010:20` |
| `account_deletion_requests` SELECT | – | self | self | self | self | Y | `202608260001:142` |

### Content

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `workout_posts` SELECT | – | **self only** | Y cond | Y cond | **Y (all, ungated)** | Y | `202609060001:138` (main) OR'd with `posts_select_admin_review` `202608270009:32` — a second **permissive** policy `using(exists profiles where id=auth.uid() and is_admin)` with no block/feature-flag/`is_community_member` clause. Admin therefore reads deleted, removed, blocked-author and feature-flag-disabled posts. Intentional for moderation; recorded here because it is invisible from the main policy. |
| `workout_posts` INSERT | – | – | Y cond | Y cond | Y cond | Y | `202608280015:207` — `author_id = auth.uid() AND is_community_member() AND has_perm('community.post.create') AND not is_posting_restricted()`. The direct grant is still live (`202608260001:105`), but **it no longer bypasses the rate limit**: `202609060012:25` adds a BEFORE INSERT trigger applying the identical `check_rate_limit('post_create', 20, 10)`, skipped only inside the transaction-local `app.allow_unrated_post_insert` pin that `post_create()` sets around its own insert, so a real composed post spends one token and not two. **(changed 2026-09-06→18.)** |
| `workout_posts` UPDATE | – | – | self, **7 columns now server-derived** | self | self | Y | `202608260001:133` — `using(author_id=auth.uid()) with check(author_id=auth.uid())`, still no column restriction *in the policy*. **SEC-002/SEC-005 are closed by a trigger** (`202609060011:169`): `workout_posts_guard_moderated_fields()` fires BEFORE UPDATE OF `status`, `deleted_at`, `score_value`, `score_direction`, `comparison_key`, `published_at`, `is_pinned` and raises `field is server derived` (P0001) for any `authenticated` change to them — closing both "author PATCHes a moderator's `post_delete()` back to active" and "author forges the comparison board or the feed's `published_at`". Bypassed only inside the transaction-local `app.allow_moderation_write` pin set by `post_delete()`, `request_account_deletion()` and `admin_remove_member()`; skipped entirely for non-`authenticated` roles, so service-role backfills are unaffected. `visibility`, `metadata` and `body` remain author-writable through `post_set_visibility()`/`post_edit_caption()`, which the trigger does not touch. **(changed 2026-09-06→18.)** |
| `workout_posts` DELETE | – | – | **–** | **–** | **–** | Y | `posts_delete_self` **dropped** and `revoke delete … from authenticated` at `202609060011:285`. `reports.post_id` is `on delete cascade`, so a hard DELETE let an author erase the moderation evidence filed against their own post, not just the post. `post_delete()` (soft delete, UPDATE-only, moderator-aware) is now the sole removal path. **(changed 2026-09-06→18.)** |
| `post_comments` SELECT | – | – | cond | cond | cond | Y | `202608280016:98` via `post_visible_to_viewer()` — closed to a ghost because `posts_feed_select` is now gated |
| `post_comments` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant **revoked** `202608270010:86`; only `add_post_comment()` |
| `post_comments` UPDATE | – | – | – | – | – | Y | no grant; `comment_edit()` / `comment_moderate()` only |
| `post_comments` DELETE | – | – | self | self | self | Y | `202608270004:60` |
| `comment_mentions` SELECT | – | – | cond | cond | cond | Y | `202608280021:44` — mentioned member or comment author |
| `reactions` SELECT | – | – | cond | cond | cond | Y | `202608270001:25` via `post_visible_to_viewer()` |
| `reactions` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant revoked `202608270010:87`; `toggle_reaction()` only |
| `reactions` DELETE | – | – | self | self | self | Y | `202608260001:138` |
| `post_media` S/I/U/D | – | – | cond/self | cond/self | cond/self | Y | `202608280005:169-193` |
| `reports` SELECT | – | **–** | **–** | **–** | Y (all) | Y | `202609120012:48` — `exists(profiles where id = auth.uid() and is_admin)`. **The reporter's own-row branch was removed**: a direct table read exposed `reviewed_by`, `review_note` and the moderation state to the person who filed the report. A coach still reads the queue only through `mod_queue()`. **(changed 2026-09-06→18.)** |
| `reports` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant revoked `202608270010:88`; `report()` only |
| `hidden_posts` / `saved_posts` | – | self | self | self | self | Y | `202608280014:51-95` |
| `pins` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:123` — was `using (true)`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `pins` write | – | – | – | – | – | Y | no grant; `pin_set()`/`pin_clear()` require `content.pin` |

### Club / RBAC / config

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `clubs` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:135` — was `using (true)`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `clubs` I/U/D | – | – | – | – | – (owner only) | Y | `202608280001:257-262` — `my_role_code() = 'owner'`. No account can hold `owner` today. |
| `roles` / `permissions` / `role_permissions` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:138,141,144` — were `using (true)`. Gated on tidiness rather than as a breach (a ghost learning the club's role names is not a confidentiality loss), at zero functional cost. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| same, I/U/D | – | – | – | – | – (owner only) | Y | `202608280001:265-286` |
| `club_features` SELECT | – | **Y** | Y | Y | Y | Y | `202609010012:43` — `using (true)` |
| `club_features` write | – | – | – | – | via RPC | Y | no policy; `admin_set_club_feature()` requires `has_perm('community.club.manage_modules')` (admin/owner only, `202609010012:92-96`) |
| `onboarding_step_content` SELECT | – | **Y** | Y | Y | Y | Y | `202609030004:77` — deliberately pre-redemption |
| `onboarding_step_content` UPDATE | – | – | – | – | Y | Y | `202609030004:85` — `has_perm('community.content.manage_onboarding') or is_admin()` |
| `intro_carousel_content` SELECT | – | **Y** | Y | Y | Y | Y | `202609050007:65` — deliberately pre-redemption |
| `intro_carousel_content` UPDATE | – | – | – | – | Y | Y | `202609050007:68` |

### Announcements / challenges / events

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `announcements` SELECT | – | – | Y cond | Y cond | Y cond | Y | `202609060001:171` — `deleted_at is null AND (expires_at null/future OR is_staff()) AND club_feature_enabled('announcements') AND is_community_member()` |
| `announcements` INSERT | – | – | – | Y | Y | Y | `202608270006:142` — `author_id = auth.uid() AND is_staff()` |
| `announcements` UPDATE | – | – | – | **self-authored only** | Y (any) | Y | `202609060013:88` — `author_id = auth.uid() or is_admin()`. Previously `using(is_staff())` unscoped, so any coach could edit or soft-delete any announcement including an admin's. **(changed 2026-09-06→18.)** |
| `weekly_challenges` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:119` — was `using (true)`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** `202609110007` additionally reshapes the leaderboard for privacy and deterministic order. |
| `weekly_challenges` INSERT | – | – | – | Y | Y | Y | `202609060005:44` — `created_by = auth.uid() AND has_perm('community.challenge.create')` |
| `weekly_challenges` U/D | – | – | – | Y | Y | Y | `202609060005:53,56` |
| `challenges` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:77` — same predicate **plus `is_community_member()`**. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `challenges` I/U/D | – | – | – | Y | Y | Y | `202608280009:88-93` — `has_perm('community.challenge.create')`; insert also `created_by = auth.uid()` |
| `challenge_teams` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:44`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `challenge_teams` I/U/D | – | – | – | Y | Y | Y | `202608280009:98-103` |
| `challenge_participants` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:48`. Exposed the `user_id` of every participant to a ghost; `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `challenge_participants` INSERT | – | – | self cond | self cond | self cond | Y | `202608280009:112` — `user_id = auth.uid() AND is_community_member() AND challenge active` |
| `challenge_participants` UPDATE | – | – | self cond | Y cond | Y cond | Y | `202608280009:118` `using(user_id = auth.uid() or has_perm(...))`, column-unrestricted — but `progress_value` and `status` are now trigger-guarded (`202609060005:124-155`) |
| `challenge_participants` DELETE | – | – | self | Y | Y | Y | `202608280009:121` |
| `challenge_progress` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:52`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `challenge_progress` INSERT | – | – | self cond | self cond | self cond | Y | `202609120002:49` — self + `entered_by is null` + `is_community_member()` + an own `challenge_participants` row with `status in ('active','completed')`. The earlier predicate compared an unqualified column to itself and was a **tautology**, so any member could log progress into a challenge they had never joined; `202609120009` separately requires the challenge itself to be active. `'withdrawn'` stays excluded — leaving a challenge ends the ability to log into it. **(changed 2026-09-06→18.)** |
| `challenge_progress` U/D | – | – | – | – | – | Y | append-only, no grant |
| `events` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:66` — same predicate **plus `is_community_member()`**. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `events` I/U/D | – | – | – | Y | Y | Y | `202608280010:51-56` — `has_perm('community.event.manage')` |
| `event_attendees` SELECT | – | **–** | Y cond | Y | Y | Y | `202609060011:56` — the same three-branch predicate **wrapped in `is_community_member()`**. `can_view_profile_field` still requires only a non-null `auth.uid()`, which is exactly why the outer gate had to be added rather than relying on it. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** `202609120003` additionally takes a capacity lock on RSVP. |
| `event_attendees` I/U/D | – | – | self cond | Y | Y | Y | `202608280010:68-77` |

### Achievements / recognition / recaps

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `achievement_definitions` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:147` — was `using (true)`. No member data; gated for tidiness. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `achievement_definitions` I/U/D | – | – | – | – | Y | Y | `202608280007:67-71` — `is_admin()` |
| `member_achievements` SELECT | – | **–** | Y cond | Y cond | Y cond | Y | `202609060011:97` — byte-identical to `202609010012`'s version **except for the added `is_community_member()`**, deliberately: an earlier draft re-typed the policy from memory, dropped the `club_feature_enabled('achievements')` gate and open-coded the mutual-follow check, which silently re-enabled achievement reads for a club with the module switched off. Caught by `supabase/tests/0055` on the first real pgTAP run. **Do not re-type this policy; copy it.** `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `member_achievements` write | – | – | via RPC | via RPC | via RPC | Y | `ach_claim()` (`202608290002:27`) |
| `member_of_week` SELECT | – | **–** | Y | Y | Y | Y | `202609060011:115` — was `using (true)` while carrying `user_id`. `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `member_of_week` write | – | – | – | – | – | Y | no grant; `member_of_week_publish()` requires `is_staff()` |
| `monthly_club_recaps` SELECT | – | **–** | Y (published) | Y (all) | Y (all) | Y | `202609010002:224` staff/analytics all rows; `202609060011:151` `is_community_member() AND published_at is not null` for everyone else. Aggregate-only by table shape (no `user_id`, no text column). `202609060011` re-gated on `is_community_member()`. **(changed 2026-09-06→18.)** |
| `weekly_recaps` SELECT | – | self | self | self | self | Y | `202608290011:92` |
| `community_streaks` (view) SELECT | – | **self only** | Y cond | Y cond | Y cond | Y | `202609060002:88-124` — `is_community_member()` + subject's `visible_to_club` + `in_leaderboards` (raw column *and* `can_view_profile_field`); `last_activity_on` additionally gated on `show_attendance`. Gated. |
| `community_feed` (view) SELECT | – | – | Y | Y | Y | Y | `202608260001:169-179`, `security_invoker = true` → inherits `posts_feed_select`, so gated. |

### Social graph / telemetry / ops

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `follows` SELECT | – | self edges | self edges | self edges | self edges | Y | `202608260001:119` |
| `follows` INSERT | – | – | self cond | self cond | self cond | Y | `202608280003:239` — `follower_id = auth.uid() AND target allow_follows AND no block edge`. **No `is_community_member()`** — a ghost has no profile row so the FK to `profiles` blocks it in practice. |
| `follows` UPDATE | – | – | – | – | – | Y | grant exists, **no policy** → denied |
| `follows` DELETE | – | – | self | self | self | Y | `202608260001:121` |
| `blocks` S/I/D | – | self | self | self | self | Y | `202608260001:123-125` |
| `blocks` UPDATE | – | – | – | – | – | Y | grant exists, no policy → denied |
| `private_records` S/I/U/D | – | self, rate-limited and size-capped | self | self | self | Y | `202608260001:114-117` — `user_id = auth.uid()` only. **The missing membership gate is deliberate and stays**: this is the offline-sync channel and is documented to work pre-redemption (`COMMUNITY_SETUP.md` § Offline synchronization). `202609060012:227` adds a BEFORE INSERT rate limit of 1000 writes / 10 min — a *rate* limit rather than the audit's suggested row cap, because a real athlete's multi-year history is many thousands of legitimate rows and a hard cap would silently break a first sync. `202609060012:224` adds `pg_column_size(payload) <= 65536` **NOT VALID**, so it binds every new and updated row while leaving unknown legacy rows unvalidated; `validate constraint private_records_payload_size` is an outstanding follow-up once real data is confirmed to fit. **(changed 2026-09-06→18.)** |
| `activity_pings` S/I | – | self | self | self | self | Y | `202608270001:69-70` |
| `attendance_log` SELECT | – | – | self | **–** | Y (all) | Y | `202608310001:137` self; `202609060013:51` narrows the cross-member branch to `has_perm('community.analytics.view')` alone — **not plain coach rank**, which is what PRIVACY.md has always promised members. A plain coach now reads this table only through SECURITY DEFINER functions (engagement decline, recaps, classmates, streaks, health score), which is what keeps those aggregate-only. A head coach does hold `analytics.view`, so raw cross-member reads reach rank 30 and above. **(changed 2026-09-06→18.)** |
| `attendance_log` write | – | – | – | – | – | Y | no grant; trigger `attendance_log_from_record()` only |
| `analytics_events` INSERT | – | **self, unlimited** | self | self | self | Y | `202608280012:44` — `user_id = auth.uid() OR user_id is null`. No rate limit. |
| `analytics_events` SELECT | – | – | – | – | Y | Y | `202608280012:46` — `has_perm('community.analytics.view')` |
| `feed_impressions` SELECT | – | self | self | self | self | Y | `202608280006:45` |
| `feed_impressions` INSERT | – | – | via RPC | via RPC | via RPC | Y | grant **revoked** `202609050005:128`; `feed_record_impressions()` only |
| `feed_impressions` UPDATE | – | – | – | – | – | Y | never granted; only `feed_record_interaction()` (`202609060010:112`) |
| `feed_interactions` S/I | – | self | self | self | self | Y | `202608280006:50-52` |
| `member_feed_weights` SELECT | – | self | self | self | self | Y | `202608310006:162` |
| `notifications` SELECT/UPDATE | – | self | self | self | self | Y | `202608280008:61,63`. **No INSERT policy** — `notif_create()` is service_role (`202608290012`). |
| `notification_preferences` S/I/U/D | – | self | self | self | self | Y | `202608280008:93-99` |
| `push_subscriptions` S/I/U/D | – | self, **capped at 10 active** | self | self | self | Y | `202608280008:102-108` — `user_id = auth.uid()`. `202609120005:29` adds a BEFORE INSERT trigger refusing an 11th row with `revoked_at is null`; revoked history is deliberately excluded from the count, or a long-time member who changes phones would eventually lock themselves out. **(changed 2026-09-06→18.)** Delivery is additionally gated server-side: `notif_push_pending()` (`202609170002`, narrowed by `202609170003`) selects only subscriptions whose owner opted in explicitly, and it checks the `push_delivery` club feature **inside the function**, so switching push off stops delivery to an already-subscribed device for an already-written notification with the cron still running. |
| `notification_batches` SELECT | – | self | self | self | self | Y | `202608280018:56` |
| `admin_actions` SELECT | – | – | – | **–** | Y | Y | `202609160007:44` — `is_admin()`, replacing `admin_actions_read_analytics`'s `has_perm('community.analytics.view')`. **That permission was granted to `head_coach` on 2026-09-15, which silently opened the audit log to the staff it audits.** The policy was always the real gate: `admin_actions_page()` is `security invoker` over a table `authenticated` can SELECT. `202609150004` narrowed the function and not the policy; `202609150015` then re-declared the function from the pre-narrowing body and put the permission back. Both are on `is_admin()` now. Pinned by `supabase/tests/0085`, which had been unable to run for the eleven hours CI was dead. **(changed 2026-09-06→18.)** |
| `admin_actions` write | – | – | – | – | – | Y | no policy, no grant; `log_admin_action()` definer, granted to no role |
| `posting_restrictions` SELECT | – | – | **– (via RPC)** | Y | Y | Y | `202609120012:74` — `has_perm('community.member.restrict') or has_perm('community.comment.moderate')`. The member's own-row branch is replaced by `my_posting_restrictions()`, a definer function returning exactly the six columns the client asked for and never `moderator_id`/`lifted_by`/`source_report_id`/`lift_reason`, which the old self-read exposed regardless of what the shipped client selected. `202609150013` additionally enforces one active restriction per member. **(changed 2026-09-06→18.)** |
| `member_contact_log` SELECT/INSERT | – | – | – | Y | Y | Y | `202608290013:313,323` — `is_staff()` |
| `coach_engagement_flags` all | – | – | – | Y | Y | Y | `202608280011:32-39` — `is_staff()` |
| `community_health_scores` SELECT | – | – | – | – | Y | Y | `202609010009:287` |

### Club WOD, support and plumbing

Eight tables existed in `public` and appeared nowhere in this matrix until
2026-09-18. Policy text below is the live text read from `pg_policies`, and
the grant column is what `authenticated` actually holds.

| Table | anon | ghost | member | coach | admin | service_role | Live policy / grant |
|---|---|---|---|---|---|---|---|
| `club_wods` SELECT | – | – | Y | Y | Y | Y | `club_wods_read` — `is_community_member()`. **SELECT is the only grant**; every write is a definer RPC, so there is no insert/update/delete policy to read. |
| `club_wod_sessions` SELECT | – | – | Y | Y | Y | Y | `club_wod_sessions_read` — `is_community_member()`. SELECT-only grant, same shape: writes go through `club_wod_session_publish` / `_cancel`. |
| `club_wod_results` SELECT | – | – | Y cond | Y cond | Y cond | Y | `club_wod_results_read` — `is_community_member() AND (user_id = auth.uid() OR can_view_profile_field(user_id, 'show_workout_results'))`. A member's own row is always visible to them; everyone else's is subject to that member's own privacy toggle. |
| `weekly_challenges_archive` SELECT | – | – | – | Y | Y | Y | `weekly_challenges_archive_read` — `has_perm('community.challenge.create')`. Note this is the PERMISSION, not `is_staff()`: the `staff` role does not hold it, so a `staff`-role account is denied here while a coach is not. |
| `onboarding_progress` SELECT/UPDATE | – | self | self | self | self | Y | `onboarding_progress_self_select` / `_self_update` — `user_id = auth.uid()` on both, with the same predicate in `with_check`. No INSERT grant. |
| `bug_reports` | – | – | – | – | – | Y | **No policy and no grant to any client role.** Reporters file through `bug_report_submit()` and read their own through a function whose return type simply has no staff-internal columns; staff read through another. The table itself is unreachable, which is what makes `reporter_id` unforgeable. |
| `coach_congratulations` | – | – | – | – | – | Y | No policy, no client grant. Written only by `coach_congratulate()`. |
| `request_idempotency` | – | – | – | – | – | Y | No policy, no client grant. Server-side write-dedupe; a client that could read it could enumerate other members' request fingerprints. |

### Storage buckets

| Object | anon | ghost | member | coach | admin | Notes |
|---|---|---|---|---|---|---|
| `post-photos` SELECT | – | – | cond | cond | Y | `202608270006:207` — object name's uid prefix must equal the post's `author_id` **and** `post_visible_to_viewer(p.id)`. Private bucket + signed URL. |
| `post-photos` INSERT | – | – | cond | cond | cond | `202608270006:204` → `can_upload_post_photo()` (`:189`) — own-uid prefix, redeemed, **`< 20` objects per member** |
| `post-photos` DELETE | – | – | self | self | self | `202608270004:36` |
| `avatar-photos` SELECT | – | self only | cond | cond | cond | `202609060003:70` — own object, or `is_community_member() AND can_view_profile_field(owner,'visible_to_club')`. Bucket flipped to private at `202609060003:40`. |
| `avatar-photos` I/U/D | – | – | cond | cond | cond | `202609010010:60-70` → `can_write_own_avatar()` (`:42`) — own-uid prefix + redeemed. **No object-count cap** (deliberate, see SEC-006). |

---

## 2. Client-callable SECURITY DEFINER surface

**99** `SECURITY DEFINER` function *names* carry a live `grant execute … to
authenticated` — 134 signatures once overloads are counted, out of 119 distinct
names granted in total (the other 20 are `security invoker`, so RLS applies to
the caller normally). That is up from 75 on 2026-09-06. **(changed
2026-09-06→18.)**

This does not contradict the **182** in Live totals above: that is every
SECURITY DEFINER function in `public`, whoever may call it. This 99 is the
subset a logged-in browser can actually invoke — the surface that matters for
this section. The rest are triggers, `service_role`-only senders
(`notif_create`, the three `notif_push_*`) and internal helpers.

Counted mechanically over all 173 migrations by replaying every
`grant`/`revoke … on function public.X(args) to/from authenticated` in filename
order and keeping the last event per signature, then classifying by the last
`create [or replace] function` for that name.

Because a definer function reads its base tables with the owner's rights, RLS
never runs inside one and each must restate its own gate. The 2026-09-06 pass
enumerated all 75 then-existing and read every one whose body contained no
recognisable guard. This re-read did not repeat that function-by-function
audit; it checked the *deltas* — the ~24 names added since — and the five
functions whose gate was changed by a later migration. Result:

**Gated on `is_community_member()`** (correct for member-data reads/writes):
`feed_page`, `community_search`, `community_profile`, `club_summary`,
`member_roles` (all five fixed in `202609060009_definer_read_gate.sql:225,659,800,1079,1130`),
`post_create`, `post_edit_caption`, `add_post_comment` (3-arg),
`comment_edit`, `comment_delete`, `toggle_reaction`, `report`, `ach_claim`,
`event_rsvp`, `chal_progress`, `attendance_classmates_today`.

**Gated on `is_admin()` / `has_perm()`** (correct for admin/staff surfaces):
all `admin_*`, all `mod_*`, `analytics_dashboard`, `member_segments`,
`retention_*`, `community_health_history`, `registration_funnel`,
`recap_monthly_publish`, `member_of_week_*`, `coach_*`, `chal_record_progress`,
`chal_reassign_team`, `chal_set_captain`, `pin_set`, `pin_clear`,
`admin_set_club_feature`, `review_report`, `bug_report_list_all`,
`bug_report_set_status` (admin, not staff), `club_wod_publish` /
`club_wod_retire`.

**Gates that moved after the first pass — check these against memory:**

| Function | Was | Is | Why |
|---|---|---|---|
| `admin_actions_page` | `has_perm('community.analytics.view')` | **`is_admin()`** (`202609160007`) | The permission reached `head_coach` on 2026-09-15, making the audit log readable by the staff it audits. Narrowed once by `202609150004`, silently reverted by `202609150015` re-declaring the function from the old body, narrowed again here. Its **policy** is the gate that actually matters — the function is `security invoker` over a table `authenticated` can SELECT. |
| `admin_remove_member` | hardcoded `is_admin()` | `has_perm('community.member.remove')` **+ strict-rank guard** (`202609160005`) | The head coach owns the invite surface and could add members but never remove one. Reaching strictly below your own rank is what makes the widening safe. |
| `attendance_log` staff reads | `is_staff()` | `has_perm('community.analytics.view')` (`202609060013`) | Plain coach rank was never what PRIVACY.md promised members. |
| `bug_report_set_status` | — | `is_admin()` (`202609150002`) | Reading a bug report is `is_staff()`; closing one is the admin's call. |

**Gated on `auth.uid()` only — deliberate and verified safe:**

| Function | Why the weaker gate is correct |
|---|---|
| `post_set_visibility` (`202609060007:144`) | Own-row only (`author_id is distinct from v_uid → not authorized`, `:158`); narrowing must stay available to a restricted member. |
| `feed_record_impressions` (`202608280006:60`) | Writes only `user_id = auth.uid()` rows; ≤50 per call. |
| `feed_record_interaction` (`202609060010:112`) | Own rows; rate limited 300/10min; `post_visible_to_viewer()` check. |
| `notif_mark_read` (`202608280008:128`) | Own notifications. |
| `mark_recovery_verified` (`202608280003:83`) | Re-reads `auth.users` for a real email+password+`email_confirmed_at`; cannot be self-certified. |
| `redeem_invite_code` (`202609030003:64`) | This *is* the pre-membership entry point. |
| `submit_report` / `admin_grant_coach(uuid)` / `add_post_comment(4-arg)` | Thin wrappers delegating to a fully gated overload (`202608280025:75`, `:421`, `202608280021:83`). |
| `can_upload_post_photo`, `can_write_own_avatar`, `club_feature_enabled`, `role_rank` | Predicate helpers with no side effect; each answers only about `auth.uid()` or about non-member config. |

The 2026-09-06 pass found **no** client-callable definer function with a
genuinely missing guard, and this re-read found none among the additions — but
it also did not re-read all 99 line by line, and says so rather than implying a
coverage it did not do. What has been added instead is a **standing** guard the
first pass did not have: `supabase/tests/0113` fails CI the moment a function in
`public` becomes anon-executable, in either direction.

Three later migrations hardened definer functions that already had correct
gates: `202609120006` (malformed-`jsonb` guard on the post and feed RPCs),
`202609120001` (achievement-claim verification), and `202609110004` (PR and
achievement share forgery guard).

## 3. Privilege-escalation trace (answer: no client-reachable path exists)

`invite_redemptions.role` is the role store (`202608280001:139`) and has **no
INSERT/UPDATE/DELETE grant to `authenticated`** — only `select`
(`202608270003:27`). Every writer:

| Writer | Gate | Cite |
|---|---|---|
| `redeem_invite_code()` shared-code branch | hardcodes literal `'member'` | `202609030003:117-127` |
| `redeem_invite_code()` per-person branch | grants the `invites` row's role, which only an **admin** could have set to `coach` | `202609030003:146-158` + `202609030008:97` |
| `admin_grant_coach(uuid,text)` | raw `profiles.is_admin` check; `p_role in ('coach','head_coach')` only | `202608280025:396-404` |
| `admin_revoke_coach()` | raw `profiles.is_admin` check | `202608280025:433-436` |
| `grant_coach_role()` / `grant_coach_role_by_handle()` | `service_role` only | `202608270006:112`, `202608270007` |

`profiles.is_admin` is pinned by the `protect_is_admin()` trigger for any
`auth.role() = 'authenticated'` session (`202608280003:67-78`), and
`profiles_insert_self` forces `is_admin = false` (`202608280003:216`). So:

- **Coach → admin: not reachable.** A coach cannot mint a coach invite either
  (`202609030008:97`), so the tier is not self-propagating.
- **Member → coach: not reachable** without an admin action.
- **Ghost → member: requires a valid invite code**, 5 attempts / 15 min per
  `auth.uid()` **and** per hashed device key, whichever is higher
  (`202609030003:92-102`; helper `bump_invite_attempt` at `202608280013:42`).
  Codes are `encode(gen_random_bytes(24),'hex')` = 192 bits (`202608270006:97`),
  so guessing is not a realistic attack; the throttle is a cost floor, and the
  migration says so itself (`202608280013:20-22`).
- `owner` (rank 60) can rewrite `roles`/`role_permissions` via RLS
  (`202608280001:265-286`). **Nothing client-reachable can grant `owner`, and no
  account holds it today** — but the claim "nothing in the shipped system can
  grant it" was falsified on 2026-09-15 and is worth restating precisely.
  `202609150009_the_admin_is_a_member_too.sql` granted the admin account an
  `owner` redemption **from a migration**, to get it past
  `is_community_member()`; `202609150010_management_is_not_a_membership.sql`
  reversed that the same day, on the grounds that management is a separate login
  and not a very senior membership. So the correct statement is: `owner` is
  unreachable from any client path, and reachable from a migration or the
  service role — which is the same as saying it is reachable by whoever can
  deploy. **(changed 2026-09-06→18.)**
- **Staff impersonation by display name** is blocked in both directions since
  `202609120007`, which extended `202609060015`'s guard from UPDATE to INSERT
  and to `bio` — a member could previously sign up *as* "מאמן" rather than
  rename themselves to it.
- **Blocking now unfollows both ways** (`202609150012`), and unblocking does not
  re-follow. That is a real change to the `follows` and friends-scope rows
  above: an `are_friends()` branch narrows to the caller alone after a block.
  **(changed 2026-09-06→18.)**

## 4. Cross-club isolation (answer: there is none)

`clubs` holds exactly one seeded row (`202608280001:25-27`). `club_id` columns
exist on `profiles`, `workout_posts`, `challenges`, `weekly_recaps`,
`member_of_week` etc., **and no read or write policy anywhere filters on it.**
`club_feature_enabled()` hardcodes `default_club_id()`
(`202609010012:49-58`), as does `admin_set_club_feature()` (`:92`). The
migration states the position plainly: *"There is deliberately no multi-tenant
logic anywhere — the column exists so a second club is a data migration later
instead of a schema rewrite, and nothing reads it as a filter today"*
(`202608280001:9-11`). Consequence: the day a second `clubs` row exists, every
policy in section 1 becomes a cross-tenant read. Recorded as SEC-008, and still
true at 173 migrations — `club_feature_enabled()` and `admin_set_club_feature()`
still hardcode `default_club_id()`, and the live read above found 62 tables and
one `clubs` row. Standing up a second club is a separate deploy
(`docs/deploy/PER_CLUB_SETUP.md`), not a row in this one.
