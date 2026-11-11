# Haimunia club: research and build plan

2026-11-11. Research only: no code, migration or database change. Repositories read:
`shahafrach/haimunia-app-demo` (BOX-LOG 5.0.3, this repo) and `haimuniya/haimunia-app` (live club app 3.1.1,
read-only clone; this session has no push access to it). File paths without a prefix are in this repo;
`old:` means `haimuniya/haimunia-app`.

**How the docs were checked.** `supabase.com` is blocked by this session's network, so Supabase figures come from
web-search extracts of the official pages linked below, not from reading them in full. Verify the numbers marked
**(verify)** on the live page before relying on them.

## Summary: where the plan as given is wrong or incomplete

| # | Finding | Effect | Fix |
|---|---|---|---|
| 1 | Supabase Auth allows **30 anonymous sign-ins per hour per IP** by default ([rate limits](https://supabase.com/docs/guides/auth/rate-limits)). Every sign-up here starts anonymous (decisions.md, Auth). | 250 members joining on launch night over the gym's Wi-Fi share one IP. The 31st person in an hour gets a 429. | Owner raises `rate_limit_anonymous_users` before launch (dashboard or `set-auth-config.yml`), and the join screen says "try again in an hour" on 429. Turnstile still gates each sign-up. |
| 2 | Push subscriptions belong to a **user**, not an app. `notif_push_pending` (`202611100001_lost_code_reset.sql:101`) sends every notification to every live subscription of the user. | A member signed in to both BOX-LOG and the club app gets club pushes on BOX-LOG and the other way round, and the tap opens a screen that app does not have. | Add `push_subscriptions.app` (`box-log`/`club`). Route club-circle notifications to `club` subscriptions only; everything else to `box-log`. |
| 3 | Decision 8 uploads body weight (encrypted). decisions.md says "Body weight never leaves the device", and `202610280001` bans it from `private_records`. | Contradiction between decisions. | Record the exception in decisions.md: ciphertext the server cannot decrypt, kept at most 24 h, deleted after one download. The key must never reach the server (see D). Owner gate. |
| 4 | The old app's usage counting and CSP point at `jajmlyrjlkhclgphbfbb.supabase.co`, the **deleted** project (`old:app-config.js`, `old:index.html:68`). `training_log_usage` was dropped by `202610250001_strip_gym.sql:1503`. | Counting is silently dead today. Decision 9 needs a new table, not a URL change. | New forward migration that recreates `training_log_usage` on the BOX-LOG project, plus the old app's one update (config and CSP). |
| 5 | `case v_type when 'couple' then 2 else 20` appears **twice** (`202610250003_circles_schema.sql:270`, `202610250004_circle_lifecycle_rpcs.sql:394`). The default use count `else 5` is a third copy (`:404`). `circle_share_defaults` uses `else` for friends (`:204`). | A new type `club` silently gets a cap of 20, five uses per link and friends' defaults. | Every `case`/`else` on `type` becomes explicit, and an unknown type raises an error. Twins listed in C. |
| 6 | `notif_on_pr_post` (`202611080001_push_triggers.sql:143`) writes one notification per circle member on every PR. The week card (`202610260001_circle_notifications.sql:266`) is per member per circle. The owner gets a `circle_joined` for every join (`:215`). | Fan-out to 249 members, against decision 7. 250 join pushes to the owner, against decision 6. | All three skip `type = 'club'` in the trigger itself, not only through preferences. |
| 7 | An installed iPhone web app has storage separate from Safari. | A member who pastes the transfer code in Safari, then installs, opens an empty app. | The new app takes the transfer code only when it is running installed (`display-mode: standalone`). In a browser tab it shows "install first". |
| 8 | 3.1.1 drops imported WOD results whose WOD id is unknown (`old:app.js` import, `orphanWodEntries`). 2.x "Club" WODs (category `Club`, `old:app.js:7186`) are no longer in any catalogue. | A member with 2.x club-WOD results loses them in the move, with only a count in the message. | The new app keeps those results under a placeholder custom WOD ("אימון מועדון ישן") instead of dropping them. |

---

## A. Data compatibility

| | 3.1.1 (`old:src/db.js:19`) | 5.0.3 (`src/db.js:9,34`) |
|---|---|---|
| DB name | `box-log-db` | `haimunia-demo-db` |
| Version | 7 | 10 |
| Stores | entries, movements, wodEntries, customWods, bodyweight, settings, measureTypes, measurements | the same 8 + `syncOutbox`, `wodMovementTags` (store, keyPath `name`), `communityOutbox` |
| WOD-builder tags | one settings row `wodMovementTags` | own store |

The origins differ (`haimuniya.github.io` vs `haimunia.pages.dev`), and IndexedDB is per origin. The new app starts
empty whatever its database is called. **Data moves only through the backup file or the transfer code.** The new repo
keeps `haimunia-demo-db` v10 (renaming it later costs a migration), or renames it to `haimunia-club-db` at birth. Recommendation:
rename at birth, while no device has it.

**Backup format.** Both apps write and read `{app: "box-log", version: 1}` (`old:app.js:3116`, `app.js:3606`).
`buildBackupPayload` is the same in both. The sanitizers in `src/sanitize.js` differ only in comments. `MOVEMENTS` and
`WOD_LIBRARY` are identical (checked with diff), so every built-in id resolves. **A 3.1.1 backup imports into 5.x
unchanged.** 5.x drops `baselineSeenAchievements()` after import (`app.js` import block), so a restored log there
pops every medal at once. The club app must keep the 3.1.1 call.

Fields (all of them are rebuilt from a whitelist on import):

| Key | Fields |
|---|---|
| `entries` | id, exerciseId, date, type (`reps`/`duration`), weight, reps, sets, durationSeconds, ts, updatedAt, isPR, groupId, blockLabel, est1RM |
| `customMovements` | id, name, category |
| `wodEntries` | id, wodId, date, scoreType, ts, rx (`true`/`false`/`"plus"`), isPR, timeSeconds or rounds+reps or emomReps or weight, scaledWeight, notes, updatedAt, partnerTag |
| `customWods` | id, name, category (always `Custom`), scoreType, desc, timeCapSeconds, emom* (Movements, MovementTypes, TargetReps, TargetDurations, TargetWeights, Minutes) |
| `bodyweightEntries` | id, date, weight, ts |
| `measureTypes` | id, name |
| `measureEntries` | id, typeId, date, value, ts |
| `sessionNotes` | `{ "YYYY-MM-DD": text }` (≤300 chars) |
| `customWodMovementTags` | name, category |
| top level | app, version, exportedAt |

**Not in the backup**, so lost in a move unless added: the localStorage and settings keys `haimunia:userName`,
`boxStartDate`, `barWeight`, `pctIncrement`, `wodRxDefault`, `theme`, `textScale`, `seenAchievements`, `firstOpenDate`,
`hasOnboarded`, `boxlog:lastExportAt` (`old:app.js`, the `*_KEY` constants). Recommendation: the **transfer payload**
carries a `prefs` object with the first seven (name, box start, bar weight, % increment, Rx default, theme, text
scale). The backup file stays `version: 1`, unchanged, so the file and the old app stay compatible both ways. The 25 MB
limit (`MAX_BACKUP_BYTES`) and `importItems: 20000` per list apply to both.

## B. Feature diff (client), 5.x vs 3.1.1

| 5.x has, 3.1.1 lacks | Where | Club app |
|---|---|---|
| Home "about me" screen: ring, weeks met, last session, PRs | `app.js` `renderProgressOverview`, `renderWeeksSection`, `src/progress.js` | **port** |
| Weekly summary / "השבוע שלך" digest view | `renderWeeklySummary`, `src/progress.js` | **port** (on-device only) |
| Design tokens, five palettes, appearance section | `tokens.css`, `src/theme.js`, `renderAppearanceSection` | **port** |
| Share cards on canvas (PR, week) | `src/share-cards.js` | **adapt**: PR card yes, week card no (decision 5) |
| WOD glossary link | `renderWodGlossaryLink` | **port** |
| Accounts: anonymous → username, recovery code, lost-code reset, MFA | `src/community/auth.js`, `recovery.js`, `mfa.js` | **port** (connected mode) |
| Circles list, create, sheets, couple grid, week | `circles*.js` | **adapt**: one club, no create, no list, no week |
| Feed, posts, reactions, trained-together | `posts.js`, `reactions.js`, `sharing*.js` | **port** |
| Share defaults per circle, privacy panel | `privacy.js`, `sharing-core.js` | **adapt**: one circle, club defaults |
| Notifications center, push toggles | `notifications.js` | **adapt**: only reaction and trained-together |
| Workout reminder and weekly digest push | `reminders.js` | **port** (personal, opt-in, no fan-out) |
| Private log cloud backup with consent | `cloud.js` `private_records`, `renderBackupConsentCard`, `src/dormancy.js` | **open question** (see G, Q3) |
| Outbox and idempotency | `src/outbox.js` | **port** |
| `analytics_events`, event bus | `src/analytics.js`, `src/eventbus.js` | **skip** for the club: usage counting replaces it (decision 9), so there is one counter, not two |
| Founder link, benchmark of the month, weekly competition, couple | `circles*.js`, migrations `202610290002`, `…0006` | **skip** (circles-only) |
| Club achievements share prompt | `share-prompt.js`, `achievements.js` | **port** |

3.1.1 has, 5.x lacks: usage counting (`old:src/usage.js`, keep), the upgrade-backup card (`renderUpgradeBackupCard`,
replaced by the transfer screen), the desktop sidebar (`renderDesktopSidebar`, check whether 5.x's nav covers it),
`renderPctTable` (the percentage table; 3.1.1 shows it when the percentage chips are off, `old:app.js:4627`; 5.x has only `renderStrengthPctChips`, `app.js:4891`, so **port the table**), and the
support form (mailto/WhatsApp to `haimuniya@gmail.com`, see J).

## C. Club circle schema

All changes live in one new migration in this repo (one branch at a time adds a migration, CLAUDE.md).

| Object | Today | Change |
|---|---|---|
| `clubs.type` check (`202610250003:146`) | couple, friends | add `club` |
| `create_circle` (`202610250004:228`) | refuses unknown types | **unchanged**: a club cannot be created from the app. The owner creates it once in the SQL editor with a granted-to-no-role function `owner_create_club(name, emoji)` |
| Member cap (`202610250003:270`, `202610250004:394`) | `else 20` | explicit `when 'friends' then 20 when 'club' then 250 else raise` |
| `circle_members.role` (`202610250003:241`) | owner, member | add `coach`, valid only when `type = 'club'`. One coach at most (partial unique index) |
| `circle_members_guard_role` (`:289`) | a role never changes by update | keep; the coach is set by a granted-to-no-role `owner_set_coach(club, username)` |
| Owner handoff (`circle_members_after_delete`, `202610250004:143`) | longest-standing member | club: the coach first; with no coach, nobody (the club stays ownerless and the owner reassigns by SQL). A random member must never inherit 250 people |
| Last member deletes the circle (same function) | yes | club: never automatic |
| `remove_member` (`202610250004:348`) | owner only | owner or coach. The coach cannot remove the owner or another coach |
| `clubs_update_owner` policy | owner edits settings | unchanged; the coach gets RPCs only |
| `circle_invites` (`202610250003:307`) | `max_uses` 1–20, 7-day expiry, 20 per day | club link: one active row, `max_uses` = cap, no expiry (`expires_at` far future, or a nullable column with a check tied to type) |
| `create_circle_invite` | issues a new link | club: `rotate_club_link(club)`, owner or coach. It deletes the old row and returns the new token once, 5 rotations per day |
| `join_circle` (`202610250004:423`) | 10 attempts per user per hour; `circle_full`, `too_many_circles` (10) | unchanged; the club counts as one of a member's 10 circles |
| `circle_share_defaults` (`:204`) | `else` = friends | explicit `when 'club'`: workouts as a post, PRs and percents, `show_weights` false. **Owner decision** (Q4) |
| Announcements | dropped (`strip_gym`, decisions.md "Drop") | new table `club_announcements(id, club_id, author_id, body ≤ 500, pinned, created_at)`; RLS read for club members; writes only through `post_announcement`/`pin_announcement`/`delete_announcement` (owner or coach, 10 per day). No notification. decisions.md gets the club exception |
| Delete others' posts | none | `moderator_delete_post(post)` for the owner or coach of that club only, soft delete, `notifications` text cleared as in `circle_members_after_delete` |
| Notifications | reaction, trained_together, circle_joined, week_card, pr_circle | `notif_on_pr_post`, `notif_week_card_due` and `notif_on_circle_join` return early for `type = 'club'`. Reaction (1 per post per hour) and trained-together stay |
| `push_subscriptions` | per user | add `app` (finding 2); `register_push_subscription` takes it; `notif_push_pending` joins on it |
| `training_log_usage` | dropped | recreate (finding 4): insert-only for `anon` through a definer function, 1 row per device per event per day, purge at 400 days, `training_log_usage_report()` granted to no role |
| `transfer_blobs` | — | see D |
| `bug_reports` | owner reads | add `app` (`box-log`/`club`); see J |

**Functions that assume couple or friends** (each is a twin to fix together): `circles_schema` `:270`, `:281`,
`:297`; `circle_lifecycle_rpcs` `:204` (defaults), `:228` (create), `:394` (cap), `:404` (uses); clients
`src/community/circles.js:188`, `circles-ui.js:328,378,402,425,476`, `circles-sheets.js:37-38,66-67,217`,
`sharing-core.js:185-190`, `sharing.js:157,195`, `src/share-cards.js:184-190`. **BOX-LOG's own client must
hide `type = 'club'`** in its circle list, or a member in both sees the club in BOX-LOG with the friends UI.

**Leak and guard tests to add** (pgTAP, `supabase/tests/`):
1. Club member cannot read another circle's posts, reactions, members or announcements, and the reverse (extend `0138_circle_leaks_test.sql`).
2. Coach of club A cannot remove, delete, rotate or announce in circle B or club B.
3. Coach cannot remove the owner or change roles; a member cannot call any coach RPC.
4. A 251st join returns `circle_full`; a rotated link returns `invalid`; the new one works.
5. A PR post in a club writes zero `pr_circle` rows; no week-card and no join notification for a club.
6. A club notification is selected for an `app = 'club'` subscription only.
7. `transfer_blobs` and `training_log_usage`: no select for `anon`/`authenticated`; `0113` and `0135` (definer guard) list the new functions.
8. The owner-handoff rule: the owner leaves → the coach becomes the owner; no coach → no owner, the club survives.

## D. Transfer code

**Protocol.**
1. Old app builds the backup payload plus `prefs` (A), JSON, gzip with `CompressionStream` where available.
2. It generates 13 random bytes (104 bits), shown as 21 Crockford base32 characters in groups of 4-4-4-4-5 (about
   100 bits as decided; base32 avoids `0/O/1/I` confusion, the same idea as the recovery alphabet).
3. HKDF-SHA256 over the code bytes with two `info` labels derives **`lookup`** (32 bytes) and **`key`**
   (AES-GCM-256). No PBKDF2: the code is random, not a password.
4. Encrypt with AES-GCM, a 12-byte random IV, and AAD `"haimunia-transfer:v1"`.
5. POST to Edge Function `transfer-put` `{lookup, iv, ciphertext}`. The server stores `sha256(lookup)`, the IV and the
   ciphertext. **It never sees the code or the key.**
6. The new app, running **installed** (finding 7), takes the code, derives `lookup` and `key`, and calls
   `transfer-take {lookup}`. In one statement the function deletes the row and returns it (`delete … returning`), so
   a second take finds nothing.
7. Decrypt. A GCM tag failure means a wrong code. Run the same sanitizing import as the file. Show counts before writing.
   If the decrypted data does not import, the app keeps it as a downloadable file and does not drop it (K).

**Crypto support.** `crypto.subtle` HKDF `deriveKey`/`deriveBits` and AES-GCM are "widely available since
January 2020" and need HTTPS ([MDN deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey),
[SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)). Both origins are HTTPS. **(verify)**
the Safari row of MDN's compatibility table for HKDF. Fallback: none. A phone without Web Crypto uses the backup file.

**Size.** A backup is limited to 25 MB. Real backups are kilobytes to low megabytes. Edge Functions cap memory at
256 MB, CPU at 2 s and wall clock at 150 s on Free ([limits](https://supabase.com/docs/guides/functions/limits)). No
request body limit is documented **(verify)**. Cap the ciphertext at **5 MB** in the function. Above that, the old app
says "use the backup file". Store it in a `bytea` column in a table (`transfer_blobs`), not in a bucket (decisions.md
dropped every bucket). 5 MB × the pending limit below is the worst-case database cost.

**Abuse limits without accounts.** Both functions use `verify_jwt = false` like `recover-password`
(`supabase/config.toml:101`) and the same IP hash (`recover-password/index.ts:28`, `cf-connecting-ip`):
- `transfer-put`: 5 per IP per day; at most **40 pending blobs in total** (about 200 MB worst case; the function refuses more with "try later").
- `transfer-take`: 10 attempts per IP per 15 min. A miss costs an attempt. Guessing 2^104 is hopeless anyway.
- CORS allow-list: exactly `https://haimuniya.github.io` for put and `https://haimunia.pages.dev` for take (today's functions send `*`, `_shared/recovery.mjs:72`).

**Purge.** `pg_cron` hourly: `delete from transfer_blobs where created_at < now() - interval '24 hours'`, plus the
delete-on-take. It is listed in the job-health check like the other jobs.

## E. iPhone and Android

| Topic | Finding | Source |
|---|---|---|
| Banner tap from the old app | The old app usually runs installed. A link to another origin leaves its scope and opens in a browser view; it is not the new app. Inside WhatsApp's in-app browser, install is not possible (decisions.md already detects this on the invite page). | decisions.md, Distribution |
| Flow | The banner shows the transfer code first and copies it. Then "פתחו ב-Safari / Chrome" with the URL to copy. The new app's first screen in a browser says "add to home screen, then open from the icon and paste the code". **(verify on a real iPhone and Android)** | — |
| Storage per installed app (iOS) | An installed web app gets its own quota, the same per origin as a browser app (up to 60% of disk). Persistent origins are exempt from eviction. `persist()` is granted heuristically, for example when the site runs as a Home Screen web app. iOS keeps an installed app's storage apart from Safari's (finding 7) **(verify on device)**. | [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) |
| 7-day eviction | The 7-day cap on script-writable storage applies to Safari browsing, not to Home Screen web apps. | [WebKit 10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) |
| `persist()` | Call it after install and after every import, and show the result in Settings. On Android Chrome, an installed PWA is normally granted it. | WebKit above |
| Push on iPhone | iOS 16.4+, installed only, and permission asked only from a tap. iOS 26: every site added to the Home Screen opens as a web app by default. | [WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) |
| Same VAPID key on a new origin | Works. The subscription is made by the new origin's service worker with the same public key (`cloud-config.js`), and `notif_push_send` signs with the shared private key. `VAPID_SUBJECT` is `https://box-log.pages.dev` (`_shared/webPush.mjs:21`); it is a contact URL, and one is enough for both apps. Deep links are relative (`/circles?c=…`) and resolve against the receiving service worker (`sw.js:203-242`), so club links need club paths. Finding 2 is the real gap. | `sw.js`, `notif_push_send/index.ts` |

## F. Cloudflare

| Step | Detail | Source |
|---|---|---|
| Pages from a private repo | Supported through Git integration once the owner grants Cloudflare's GitHub app access to `shahafrach/haimunia-club`. | [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/) |
| `haimunia.pages.dev` | The subdomain comes from the project name. If `haimunia` is taken, Cloudflare adds a suffix **(verify at creation)**. **Owner gate:** create the project named `haimunia` first, before any code. | [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/) |
| Build settings | Framework none, build command empty, output directory `/` (repo root is the site, as here). | — |
| `_headers` | Copy this repo's `_headers` (frame-ancestors, HSTS, nosniff, no-referrer, Permissions-Policy, COOP). Add `Cache-Control: no-cache` for `/sw.js` and `/index.html`. Limits: 100 rules, 2,000 characters per line. `_headers` does not apply to Pages Functions responses, so `functions/_middleware.js` sets its own. | [Headers](https://developers.cloudflare.com/pages/platform/headers) |
| `_middleware.js` | Copy it to 404 `docs/`, `test/`, `scripts/`, `supabase/`, `package*.json`. | `functions/_middleware.js` |
| Turnstile | Supabase holds **one** CAPTCHA secret per project. The club app must use the **same widget** (`captchaSiteKey`, `cloud-config.js`), with hostname `haimunia.pages.dev` added: FQDN only, no wildcard, 10 hostnames on Free. **Do not** add bare `pages.dev`: it would authorize every Pages site. | [Hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/) |
| CSP | Meta CSP as in `old:index.html:62`, with `connect-src 'self' https://hvwakffluwvegedefoth.supabase.co`, plus the Turnstile host for `script-src`/`frame-src`. | — |
| Supabase Auth | Add `https://haimunia.pages.dev` to the redirect URL list. No email is involved, so the Site URL can stay BOX-LOG's. | — |

Owner clicks: (1) create the GitHub repo, (2) connect Pages and name it, (3) add the Turnstile hostname, (4) raise the
anonymous sign-in limit, (5) approve `push:prod` for the club migration.

## G. Capacity on the Free plan

Quotas: 500 MB database per project, 5 GB egress, 50,000 MAU, 500,000 Edge Function invocations; paused after a week
idle (the keepalive covers that) ([billing](https://supabase.com/docs/guides/platform/billing-on-supabase),
[pricing](https://supabase.com/pricing)) **(verify)**.

Assumptions: 250 members, 150 active weekly, 3 workouts each, every workout posted (club defaults, Q4).

| Item | Arithmetic | Per year |
|---|---|---|
| Posts | 150 × 3 × 52 = 23,400 rows × ~1.5 KB with indexes | ~35 MB |
| Reactions | 23,400 × 4 × ~200 B | ~19 MB |
| Notifications | ≤ 1 per post per hour plus tags, ~30,000 × ~600 B | ~18 MB (purge after 90 days → ~5 MB standing) |
| `training_log_usage` | 2 apps × 300 devices × 3 events × 365 × ~120 B | ~40 MB (purge at 400 days) |
| `transfer_blobs` | worst case 40 × 5 MB, gone within 24 h | ≤ 200 MB transient |
| `private_records` (if the club backs up the private log) | 250 × ~3,000 records × ~500 B | **~375 MB** |

**Without the private-log backup** the club adds about 120 MB a year to BOX-LOG's footprint, inside 500 MB with room
for BOX-LOG. **With it** the project fills in one year. `private_records.payload` has no size check
(`202608260001_community_foundation.sql:24`). Recommendation: no private-log cloud backup for the club (Q3); the
backup file and the transfer code cover a phone change.

Egress: the feed reads 30 posts × ~1 KB × 150 members × 2 opens a day ≈ 9 MB/day ≈ 270 MB/month, plus the transfer
downloads (~250 × 1 MB once). Well under 5 GB.

Edge Functions: `notif_push_send` every 3 minutes ≈ 14,400/month, transfers ≤ 500 once, recovery a handful. Far
under 500,000. MAU: ≤ 300 of 50,000.

## H. Load test (CI local Supabase)

A new `supabase/tests/0152_club_load_test.sql`, running in the existing `supabase test db` job
(`.github/workflows/test.yml:209-214`). pgTAP runs inside one transaction, so it measures database cost, not network.

Setup: one club, 250 users through `join_circle` (anonymous `auth.users` rows as `rls_helpers.sql` makes them), one
coach, 3,000 posts, 12,000 reactions. Then, with `set local role authenticated` and each user's JWT claims:

| Measure | Pass limit |
|---|---|
| 250 joins on one link, the 251st | all 250 `joined`, then `circle_full` |
| Feed page (30 posts) for a member, `explain (analyze)` | < 50 ms, index scan, no seq scan on `workout_posts` |
| `circle_members` read for 250 | < 20 ms |
| One PR post | 0 `pr_circle` rows written |
| One reaction | ≤ 1 notification row |
| `notif_push_pending(200)` with 250 subscriptions | < 100 ms |
| Leak check | a non-member sees 0 rows of each club table |
| Remove 1 member with 50 posts | < 200 ms, the posts and their reactions gone |

Timing limits in CI are noisy. Assert row counts and plans hard. Assert times with three times the target's headroom, and
print the measured value so drift shows (the same caution as `community-render-cost`).

## I. Privacy

What leaves the device:

| Mode | Leaves the device |
|---|---|
| Offline | Usage counts only (`device_id` random, `event`, `screen`; switch in Settings, off forgets the id), sent to Supabase. Nothing else. |
| Connected | Plus: username (no email), display name and emoji; club membership and role; posts per the share settings (workout summary or count, PR lift and percent, absolute weight only if chosen); reactions; trained-together tags; push endpoint; feedback text if sent; the recovery-code HMAC. **Never**: body weight, measurements, session notes, the private log (if Q3 holds). |
| Transfer (one time) | The full backup **including body weight and notes**, encrypted on the phone. The server holds only ciphertext and a hash of the lookup, for at most 24 h; it is deleted on first download. |

The club privacy page (Hebrew, `privacy.html` pattern) needs: the controller (the owner, contact), the table above,
the processors (Supabase, Cloudflare Pages and Turnstile; GitHub Pages for the old app), retention (posts until you
leave, notifications 90 days, usage 400 days, transfers 24 h), what the coach can see and do (names, posts; delete a
post; remove a member; never the private log), the members' rights under Amendment 13 (export, account deletion in
the app), and that the club is one circle on a project shared with BOX-LOG, with no data crossing between circles.

## J. Support

Today the old app opens `mailto:haimuniya@gmail.com` or WhatsApp (empty) with a diagnostics text (`old:app.js:1700-1795`).
BOX-LOG stores feedback in `bug_reports`, read by the owner through `feedback-inbox.yml`.

| Option | Owner work | Coach work | Risk |
|---|---|---|---|
| 1. As BOX-LOG: everything to `bug_reports` | reads every club question | none | breaks "zero routine work" |
| 2. In-app coach inbox | none | reads in the app | new RLS surface, new screens |
| 3. **Split**: "שאלה למאמן" opens WhatsApp to the coach's number (`supportWhatsApp` in config; nothing stored); "תקלה באפליקציה" goes to `bug_reports` with `app = 'club'` | only bugs, on demand | answers on WhatsApp as today | none new |
| 4. Hide support | none | none | bugs go unseen |

**Recommendation: 3.** It matches how the club already talks (WhatsApp), stores nothing new, and the owner sees only real
app defects.

## K. Risks to member data

| Risk | Prevention |
|---|---|
| Members abandon the old app before their data is moved, then lose the phone | The old app stays live ≥ 1 month (decided). The banner offers the backup file as well as the code. |
| The transfer code is pasted in Safari, not the installed app (iOS) | Finding 7: accept the code only in standalone mode. |
| A download succeeds but the import fails (bug, storage full), and the blob is already deleted | Decrypt and write in a way that keeps the plaintext: on any import error, offer "save as file" before leaving the screen. The old phone still has its data, and the code can be made again. |
| Old club-WOD results dropped as orphans | Finding 8: keep them under a placeholder WOD. Test with `old:test/fixtures/v2.34.0-device.json`. |
| The old app's single update corrupts its own data | No IndexedDB version bump and no store change (`old:src/db.js` header, `old:test/storage-compat.test.mjs`); a rollback tag before the merge (old CLAUDE.md, Releases). |
| The club app evicts its storage | `persist()` after install; a backup reminder from `boxlog:lastExportAt` (3.1.1 already has it). |
| Removal or leaving deletes posts | By design (decisions.md); the private log is untouched. Say so in the coach's confirm dialog. |
| An owner leaving hands 250 people to a random member | The handoff rule in C. |
| Shared project: a BOX-LOG migration breaks the club | The club's pgTAP tests run on every migration in this repo; the club repo has no migrations. |
| Quota exhaustion locks both apps | G: no private-log backup for the club; cap transfers; purge jobs. |

---

## Build sessions

| # | Name | Repo | Scope | Owner gate |
|---|---|---|---|---|
| 0 | **Decisions** | demo | Amend decisions.md and journal.md: club type, coach role, announcements, the body-weight transfer exception, `training_log_usage` back, the club notification rule. Docs only. | Approve the PR |
| 1 | **Club schema** | demo | One migration: everything in C plus `transfer_blobs`, `training_log_usage`, `push_subscriptions.app`, `bug_reports.app`; pgTAP tests 1–8; BOX-LOG client hides `club` circles and sends `app` on push register. | Review, merge, `npm run push:prod` |
| 2 | **Transfer functions** | demo | `transfer-put`, `transfer-take`, CORS allow-list, IP limits, purge job, job-health entry, Deno tests. | Merge; deploy-edge-functions |
| 3 | **Load test** | demo | `0152_club_load_test.sql` (H). | Merge |
| 4 | **Club repo birth** | haimunia-club | Copy 5.x's client, strip circles-only parts (B "skip"), port the percentage table and usage counting, rename the DB, config for `haimunia.pages.dev`, `_headers`, `_middleware.js`, CSP, sw precache, tests. Offline mode only. | Create the repo, connect Pages, add the Turnstile hostname |
| 5 | **Club connected mode** | haimunia-club | Join by link, sign-up, recovery, the feed, reactions, trained-together, announcements read, coach tools, notifications (2 types), push with `app = 'club'`, offline → connected (the log stays on the device; nothing is uploaded), support split (J), privacy page. | Name the coach; raise the anonymous limit; test on 2 phones |
| 6 | **Club transfer import** | haimunia-club | The code-paste screen (installed only), decrypt, import with `prefs`, placeholder WOD, save-as-file fallback, `persist()`. | — |
| 7 | **Old app launch update** | haimunia-app | Banner, transfer-code export, usage config and CSP to the BOX-LOG project, version bump, rollback tag. No DB change. | Owner pushes it (this session has no push access); creates the rollback tag; merges at launch |
| 8 | **Pilot** | both | 3 members move over on iPhone and Android; check counts match; then the club gets the link. | Go / no-go |

Sessions 1–3 are sequential in this repo (one migration branch at a time). 4 can start in parallel with 1.

## Open questions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Who gets push access to `haimuniya/haimunia-app` for session 7? This session was refused. | Grant the Claude GitHub app access to the `haimuniya` org for that repo, or apply the PR yourself. |
| 2 | May the transfer carry body weight, against "never leaves the device"? | Yes, as recorded in finding 3: encrypted, key never on the server, 24 h, one download. |
| 3 | Does the club get the private-log cloud backup? | No. It is the only thing that can fill the free database (G). The file and the transfer code cover a new phone. |
| 4 | Club share defaults: post every workout, or a weekly count as friends? | Post every workout (a feed needs content), PRs as percent, absolute weights off. |
| 5 | If the owner leaves or deletes their account, who owns the club? | The coach; with no coach, nobody until you reassign it by SQL. |
| 6 | Anonymous sign-in limit for launch night? | 300 per hour for launch week, then back to 60. |
| 7 | Rename the IndexedDB to `haimunia-club-db` in the new app? | Yes, at birth, before any device has data. |
| 8 | Coach contact for "שאלה למאמן" (J)? | The coach's WhatsApp number in the club repo's config (public file: only if the coach agrees). |
| 9 | Should the old app also accept a transfer back (club → old)? | No. One direction only; the backup file already goes both ways. |
