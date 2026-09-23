# Launch readiness — 2026-09-22

Audited at `main` `2cf5cf4` (#44). Read-only: no code changed, and **no suite was
run** — `npm test`, the browser checks, `supabase test db` and `check:drift` were
all out of scope for a read-only pass. Every finding below comes from reading
the code (the latest migration that redefines a function or policy wins), not
from a query against production.

Sources walked: every open item in `docs/PROJECT_STATUS.md`,
`docs/audit/RISK_REGISTER.md` and `docs/community/backlog.md`; `PRIVACY.md` and
`privacy.html` against what the app collects and sends; every "no network" /
GitHub Pages claim; every feature toggle; and every member-visible string that
names a staff concept. Items marked **(re-checked)** were confirmed by a second,
direct read of the cited lines.

**The documents are stale.** `PROJECT_STATUS.md` was last reconciled at
`8ce9e5c` (2026-09-19), 22 PRs ago. `RISK_REGISTER.md` describes `d2e6408`
(2026-09-06). Most of the backlog's non-done rows, and 136 ticket files still
marked `todo`, `partial` or `review`, are done in code. A consolidation session
should re-baseline all three; the list of stale entries is at the end.

---

## Blockers

Each of these either tells an admin or a member something false about their data, or depends on production being in a state no one has recorded.

### B1. Module switches marked "enforced on the server" are not enforced on the server (re-checked)

The club-modules panel promises (`src/community/admin.js:3334`): *"נאכף בשרת – גם מי שיעקוף את המסך לא יקבל את המידע"* (enforced on the server: someone who bypasses the screen still won't get the data) and *"אין טאב, כרטיס, כפתור או התראה"* (no tab, card, button or notification). In fact `club_feature_enabled()` was only added to table **SELECT** policies (`202609010012_club_features.sql:143-213`). SECURITY DEFINER functions skip those policies, and write policies were never gated. A signed-in member calling PostgREST directly still gets:

| Switch | Ungated path (latest definition) | Fix (one new migration) |
|---|---|---|
| feed | `feed_page()` — `202609220003_the_feed_in_the_order_it_happened.sql` (no `club_feature_enabled` anywhere in the file); `posts_insert_self`; `post_create`, `pr_share`, `ach_share`, `toggle_reaction`, `add_post_comment` (`202608280015:207`, `202609120006:59`, `202609110004:139`, `202609120001:88`, `202609120011:146`, `202609060014:233`). These also send notifications. | Add `if not club_feature_enabled('feed') then …` to each RPC, and the check to the insert policy. |
| events | `event_rsvp()` — `202609060017_event_rsvp_idempotency_key.sql:43` (definer, no gate); the events branch of `community_search()` (`202609060009:643`) | Gate both on `'events'`. |
| challenges | `chal_progress()` (`202608290003:70`), `club_summary().active_challenge` (`202609060027:60`), `community_profile().active_challenge` and `community_search()` (`202609060009:776`, `:643`) | Gate each on `'challenges'`. |
| achievements | `ach_claim()` (`202608290002:27`), the achievement notification trigger (`202608280027:238`), `community_profile()` badges | Gate each on `'achievements'`. |
| leaderboards | `community_streaks()` (`202609150001`), view `weekly_challenge_leaderboard` (`202609110007:38`) | Gate both on `'leaderboards'`. |
| announcements | `announcements_insert_admin` (`202608270006:142`), `notif_announcement_fanout` (`202608290010:187`), plus the announcement cards in `feed_page` | Gate the insert policy and the fanout. |

Other functions that read gated tables without a gate: `coach_celebrate_feed`, `recap_monthly_generate` and `member_of_week`. They are staff-facing or scheduled, so they are not blockers, but they belong in the same migration. **One-line fix:** a single forward migration adding the gate to every definer function and write policy above, plus a pgTAP test that switches each module off and calls every related RPC as a member. Until that lands, change the panel copy so it stops claiming "נאכף בשרת". Only one open branch may add a migration at a time; none of the open PRs (#43, #45) adds one today.

### B2. Six migrations the client already calls may not be in production

`PROJECT_STATUS.md:17,59-65` says 175 migrations are applied with no drift. The repository has 181. Nothing records `202609190002`, `202609220001` or `…220002`–`…220005` being applied, yet Cloudflare Pages serves `main` verbatim, and the client calls functions from them (`attendance_classmates_on`, `post_tag_training_partners`, coach tasks, the owner report, and the chronological feed in `src/community/feed.js:157-160`). **Fix:** run `npm run check:drift` against the linked project and `supabase db push` anything missing, before announcing launch.

### B3. Photos outlive account deletion (policy says everything is deleted after 30 days)

`PRIVACY.md:328`/`:763` and `privacy.html:506`/`:1043` promise that the account and all its content are permanently deleted after 30 days. `purge_due_accounts()` (last defined in `202609060011_close_launch_readiness_gap_findings.sql`) only deletes `auth.users` rows. Objects in the `post-photos` and `avatars` buckets are not linked to `auth.users` by any foreign key, so no delete cascades to them, and no job removes them. **Fix:** extend the purge job (for example an Edge Function over each `<uid>/` prefix, like `sanitize_upload`'s `storage.remove`) to delete the member's storage objects.

### B4. "Community activity is deleted after 90 days" is false for two tables (re-checked)

`PRIVACY.md:335-336` (and privacy.html) defines community activity as the days you opened the app plus feed, post and reaction events (`PRIVACY.md:143-148`), and says it is deleted after 90 days. `retention_purge_telemetry()` (`202609050005_scheduled_jobs.sql:75,79`) only purges `feed_impressions` and `analytics_events`. `activity_pings` (`202608270001:61`) and `feed_interactions` (`202608280006:27`) are never purged. The one-time `202609150008` wipe does not count. **Fix:** add both tables to the retention job in a new migration, or rewrite the policy line to say they are kept until the account is deleted.

### B5. A backup-only member cannot delete their data from the app

`PRIVACY.md:103-107` says that to remove backed-up data you request account deletion, and `:351-353` says the app lets you do so. The only delete button is in the Community account tab (`cloud.js:4982` → `request_account_deletion`, `cloud.js:2925`). That tab needs a profile; without one the join form renders instead (`cloud.js:4369`). The backup panel (`cloud.js:5650-5690`) has no delete action, and an anonymous backup account has no handle a coach could look up. **Fix:** add a "delete my cloud backup" action to the backup panel that calls `request_account_deletion`.

### B6. The privacy policy leaves out three data flows

- **Bug reports:** `bug_reports` (`202609150002_bug_reports.sql:26-41`) stores up to 4,000 characters of free text plus the user-agent (`app.js:1898`). `reporter_id` is `on delete set null`, so the text survives account deletion. The sheet also promises "בלי שום נתון אישי" (no personal data, `app.js:1932`).
- **Staff notes about members:** `member_contact_log.note` (`202608290013_coach_tools.sql:295-315`) is free text any staff member can read. The policy (`PRIVACY.md:196-197`) says tasks only rely on the date staff last contacted you. Nothing stops a coach typing health information, which breaks the CLAUDE.md rule against storing health data.
- **Third parties:** the email support route (`cloud-config.js` `supportEmail`, a `mailto:` link) hands the member's real address to Gmail, against "no email address" (`PRIVACY.md:41`/`:420`). Web push goes through Google, Apple or Mozilla push services (`supabase/functions/notif_push_send/index.ts:57-111`), which are not in the provider list (`PRIVACY.md:281-290`).

**Fix:** add all of these to PRIVACY.md and privacy.html together (including bug-report retention), delete bug reports in the purge, and add a "no health details" hint to the contact-note field.

---

## Should-fix

| # | File | Problem | One-line fix |
|---|---|---|---|
| S1 | `cloud.js:4688` (re-checked) | The legacy photo card uses an inline `onerror=` handler. The CSP (`index.html:70`) has no `'unsafe-inline'`, so the browser blocks it: an expired signed URL is never evicted and the photo stays broken. It also has `alt=""`. | Replace it with a delegated `error` listener in `src/community/posts.js` next to `evictSignedUrl` (`:72`), and add an alt fallback. |
| S2 | `src/community/admin.js:2429` (re-checked) | The management login's placeholder is `headcoach`, the real management account's username, on a screen every member can open (`app.js:232-233`). | Use a generic placeholder. |
| S3 | `src/community/admin.js:2608-2615` (re-checked) | The management login confirms a correct password before refusing the account (a different message from "wrong password"), so it can be used to check credentials. | Show one message for both cases. |
| S4 | `src/community/admin.js:2565` | Management sign-in has no captcha, while member sign-in does (`src/community/auth.js:715`). The same rule is applied at only one of two sign-in points. | Wrap it in `withCaptcha`. |
| S5 | `app.js:232-233`, `src/community/admin.js:2389,2395` | "ניהול מערכת" and "ניהול המועדון" appear in every member's menu, even when nobody is signed in, and the unlock screen lists the internal tooling (moderation, audit log, password resets, member removal). | One neutral "כניסת צוות" row, and one neutral sentence on the unlock screen. |
| S6 | `supabase/migrations/202609050005:206-211`, `202609220001:32-43` | Push, weekly recap and abandoned-profile purge go through `cron_invoke_edge_function`. It returns quietly when Vault secrets are placeholders, and `job_health_check` never reads `net._http_response`. Those jobs show green even if they never ran. | Also flag non-2xx `_http_response` rows and placeholder secrets in `job_health_check`. |
| S7 | `app.js:18`, `sw.js:5` | Still `4.77.0` after 22 merged PRs. The service worker serves cached assets first, so a member can get a new `index.html` against old cached JS until the cache name changes. | A consolidation session bumps `APP_VERSION` and runs `npm run sync-version` before launch. |
| S8 | `supabase/tests/0117`–`0122` | The RLS tests for the four new tables (`220002`/`04`/`05`) may never have run: CI has had no minutes since 2026-09-19 (`PROJECT_STATUS.md:69`), and no merge records a local run. | Run `supabase test db` locally, and `test.yml` on `main` after the 2026-10-01 quota reset. |
| S9 | `scripts/smoke-test-multi-role.mjs` | The live multi-role smoke test (COMM-338) has never run against the real project, and `package.json` has no script for it. | Run it once with five throwaway role accounts and record the result. |
| S10 | `_headers:13-19`, `functions/_middleware.js:55-72` | The clickjacking headers exist, but nobody has shown that Cloudflare applies `_headers` to responses that pass through the Functions middleware. | Check production with `curl -I`; if they are missing, set them in the middleware. |
| S11 | `functions/_middleware.js:33-46` (re-checked) | `/.claude/` (`settings.local.json`, `agents/*.md`), `/mockups/`, `/photos/` and `/package.json` are all served publicly. No secrets were found in them. | Add `/.claude/`, `/mockups/` and `/photos/` to `BLOCKED_PREFIXES`. |
| S12 | `supabase/functions/admin_reset_password/index.ts:58` | `ALLOWED_ORIGINS` still includes `https://haimuniya.github.io`, a host that no longer serves the app. | Remove that origin. |
| S13 | `PRIVACY.md:18-20,58-61`, `privacy.html:128-129,176-178` | Says opening the app sends nothing to any server. The service worker fetches `cloud-config.js` with `no-store` (`sw.js:310-311`) and page navigations go to the network first (`sw.js:318-324`), so Cloudflare sees IP and user-agent on every open. | Reword to "sends none of your data; loading the app contacts the host like any website." |
| S14 | `PRIVACY.md:288-290` | Says Turnstile runs only on the sign-in screens. It also loads when backup first starts (`src/community/auth.js:597-599,659`). | Add "and when cloud backup first starts". |
| S15 | `cloud.js:5608,5656` | While backup consent is still pending, the settings text says backup starts automatically at the next save, but the consent card will ask first (`app.js:2140`). | Branch the copy on `haimuniaBackupConsentPending()`. |
| S16 | `PRIVACY.md:347-353` | Promises a portable copy of your data. The only export is the local file; server-side posts, attendance and analytics have no export path. | Add a self-export RPC, or say export covers local data only. |
| S17 | `supabase/migrations/202609110004:284-292`, `src/community/posts.js:827` | COMM-105: a PR shared on a built-in movement shows "שיא אישי" instead of the movement name. Most PRs are on built-in lifts. | Resolve the built-in exercise name when rendering, or pass it into `pr_share`. |
| S18 | GitHub Actions secrets | `SUPABASE_SERVICE_ROLE_KEY` is still stored, but no workflow reads it any more (`PROJECT_STATUS.md:246`). | The owner deletes the secret and considers rotating the key. |
| S19 | `backup-database.yml:85-88` | Scheduled backups exist, but a restore has never been done. | Do one restore drill into a scratch project and record RPO and RTO. |
| S20 | `.github/workflows/` | Migrations are still applied to production by hand, with no gate. That is how B2 happened. | Add a `supabase db push` step gated on `check:drift`. |

---

## Nice-to-have

| # | File | Problem | One-line fix |
|---|---|---|---|
| N1 | `cloud.js:1482`, `CLUB_MODULE_TOGGLES` rows marked `clientOnly` (comments, mentions, directory, …) | Correctly labelled "בתצוגה בלבד" (display only), but with `comments`/`mentions` off, `add_post_comment` still writes and still notifies. | Gate `add_post_comment` in the B1 migration; it costs nothing extra. |
| N2 | `202609010012:40` | `club_features_read using (true)` lets every member read each module's `config`, including coach-task thresholds and owner-report settings. | Expose only `module_key, enabled` to members, through a view or RPC. |
| N3 | `cloud.js:231` | `coachEngage` and `notifPush` are per-device localStorage flags. The comment at `:227-229` says push "stays default off" when the code turns it on. | Fix the comment; move `coachEngage` into `club_features` or delete it. |
| N4 | `src/community/directory.js:891` | Profiles label admin and owner accounts ("מנהל/ת", "בעלים"), which tells members which account to target at the management login. | Show only coach and head coach. |
| N5 | `src/community/admin.js:633-641` | A per-person invite never expires unless an expiry is typed. | Pre-fill a 30-day expiry. |
| N6 | `src/community/coach-tools.js:403-412`, `202609060001:122-125` | COMM-304: a coach who is not an admin sees "חבר/ה" instead of the name of a member who hid their profile in Engage. | A staff-only definer RPC for the flagged members' names. |
| N7 | `202609010001_member_of_week.sql:568` (`member_of_week_publish`) | COMM-315: the chosen member is never notified. | Add a `notif_create` call. |
| N8 | `202608280010_events.sql:14` (AUDIT-RECON-003) | `image_url` has a length check but no URL-scheme check. Only staff write it, and `esc()` plus CSP `img-src` contain it. | Add `~* '^https://'` in a new migration. |
| N9 | `app.js:3609` | The plaintext JSON export has no shared-device warning (SEC-L8). | One line of warning at the export button. |
| N10 | `app.js:6812` | No `window.onerror`/`unhandledrejection` sink. Client crashes only reach `console.error`. | A rate-limited global handler into `bug_report_submit`. |
| N11 | `src/community/notifications.js:664`, `PRIVACY.md` | Revoked push subscriptions are kept indefinitely, with no retention period stated. | Purge revoked rows after N days and state it. |
| N12 | Public comments: `_headers:3-11`, `index.html:40-46`, `sw.js:8-10,209-214`, `src/db.js:3-4`, `frame-guard.js:4`, `cloud-config.js:3`, `src/community/admin.js:1112`, `src/community/notifications.js:677` | Comments still describe GitHub Pages hosting or push as not built. None of it is visible in the UI, but all of it is served. | Rewrite the comments. Leave the applied migrations' comments (`202609080005`, `202609150001`) as they are. |
| N13 | `docs/deploy/HEADERS.md`, `docs/audit/GO_LIVE_GUIDE.md:43`, `LAUNCH_CHECKLIST.md:66`, `THREAT_MODEL.md`, `INFRASTRUCTURE_AUDIT.md`, `ARCHITECTURE_AND_DATA_FLOW.md`, `ROLLBACK_PLAN.md`, `backlog.md:80-85`, `tickets/COMM-334.md`, `COMM-337.md` | Internal docs still say the app is hosted on GitHub Pages. | Mark superseded, or rewrite for Cloudflare Pages. |
| N14 | Accessibility, open in the register | Dialog background not `inert` (`app.js:7829` only); calendar has no grid role or arrow keys (`app.js:5671`); report reasons are not a `radiogroup`; staff sidebar tabs lack a roving tabindex (`app.js:365`). | Handle each as its own small a11y ticket. |
| N15 | `README1.md`, cited at `index.html:181,587,596` | A stray top-level doc. | Move it under `docs/` and update the three citations. |

### Checked and fine

- No member-facing string claims the app makes no network requests. None of the member-facing files mentions GitHub Pages: `privacy.html`, `terms.html`, the UI strings, `manifest.json`. The "offline" claims in `README.md` and `COMMUNITY_SETUP.md` are accurate.
- **CSP:** `connect-src` allows only Supabase, Turnstile and hCaptcha. Fonts and `vendor/supabase.js` are self-hosted.
- EXIF/GPS is stripped twice (`src/image.js`, `sanitize_upload`), and analytics store only `query_length`, never search text.
- The anonymous read gate still holds (`202609060001` is the last definition). Anon `EXECUTE` is revoked (`202609170001:99`), and `job_health_status()` is the only later anon grant and returns nothing sensitive. Every recent definer function sets `search_path = ''`.
- `purge-due-accounts` is scheduled (`202609060011:340`).
- No service-role key, JWT or private key appears outside `vendor/`.
- All 88 `.rpc("…")` names the client calls still exist in the migrations.
- **Toggles that are enforced:** `push_notifications`, `streak_risk_nudges`, `engagement_alerts`, `new_member_posts`, `trained_together`, `onboarding_challenge`, `coach_tasks`, `owner_report`.

### Stale entries for the consolidation session

- **PROJECT_STATUS.md:**
  - The counts are wrong: 181 migrations, 57 browser scenarios, 123 pgTAP files, `cloud.js` at 7,738 lines with 15 modules.
  - Entries already done in code: "eleven modules emit no analytics" (fixed by #29), "display mode never sent" (`cloud.js:1097`), "ux-audit-stash unreviewed" (#19), and the `backup-database.yml` public-repo reasoning (#21).
  - The "engage decline is scaffolded" entry is wrong: the flag defaults on and the producer exists.
- **RISK_REGISTER.md:** clickjacking, the deploy workflow (Edge Functions), in-app feedback, the `isIOSDevice` duplicate and supply-chain pinning are closed.
- **backlog.md:** COMM-143 and COMM-229 are wired. Every scheduled job listed is scheduled. The COMM-312/313 client halves are done (`src/community/admin.js:1751,1805`). The admin reclaim/incomplete-signups UI exists. COMM-377, COMM-370 and COMM-P01–P07 are done.
