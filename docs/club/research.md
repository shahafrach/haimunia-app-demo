# Haimunia club: research and build plan

2026-11-11. Research only: no code, migration or database change. Repositories read:
`shahafrach/haimunia-app-demo` (BOX-LOG 5.0.3, this repo) and `haimuniya/haimunia-app` (live club app 3.1.1,
read-only clone; this session has no push access to it). File paths without a prefix are in this repo;
`old:` means `haimuniya/haimunia-app`.

**How the docs were checked.** `supabase.com` is blocked by this session's network, so Supabase figures come from
web-search extracts of the official pages linked below, not from reading them in full. Verify the numbers marked
**(verify)** on the live page before relying on them.

## Owner decisions (2026-11-11)

The owner answered the open questions and corrected the plan on 2026-11-11. They are settled. Session 1 copies them
into `docs/circles/decisions.md` and `docs/journal.md`.

| # | Decision |
|---|---|
| 1 | The owner connects the Claude GitHub app to the `haimuniya` account. Session 3 assumes push access to `haimuniya/haimunia-app`. If push access is still missing when that session starts, it stops and reports. |
| 2 | The transfer carries body weight. **The recorded exception:** the backup is encrypted on the phone; the key never reaches the server, because it exists only in the code the member copies; the server stores ciphertext only, for at most 24 hours, and deletes it on the first download. A test proves the stored blob is not valid JSON and contains no plaintext field names. |
| 3 | The club has **no cloud copy of the private log**. A new phone is covered by the backup file and the transfer code. The club UI hides every cloud-backup entry point. |
| 4 | Club share defaults: post every workout, PRs as percent improvement, absolute weights off. A member's privacy setting always wins, as in BOX-LOG. |
| 5 | If the owner leaves or deletes the account, ownership passes to the coach. With no coach, nobody owns the club until the owner reassigns it. The one-line SQL lives in `docs/ops/CLUB_OWNERSHIP.md` (written in session 1; the line is under C). |
| 6 | Anonymous sign-in limit: 300 per hour for launch week, then 60. It is set through `set-auth-config.yml`, never by hand. The join screen shows "יותר מדי הרשמות כרגע, נסו שוב בעוד שעה" on a 429. |
| 7 | The new app's IndexedDB is `haimunia-club-db`, named at repo birth. Import reads the 3.1.1 backup format unchanged. |
| 8 | "שאלה למאמן" is a WhatsApp link to the coach's number in the club config, added only once the coach agrees; until then the button is hidden. Bug reports from the club app go to `bug_reports` with `app = 'club'`. The owner does not read them in routine operation, and nothing in the club flow waits on him. |
| 9 | One direction only: old app → club app. The backup file covers the other way. |
| A | Migrations deploy through the **Supabase GitHub integration** on merge to `main` (see "Migration path" below for what the repository proves today). |
| B | Zero work for the owner: every recurring or launch-time step a workflow can do is a workflow. The owner's gates are only: approve PRs, one Cloudflare visit (Pages project and Turnstile hostname), name the coach, and go/no-go on the pilot. |
| C | Four sessions, not nine (see "Build sessions"). |
| T | **Timing.** Launch either before 22.11.2026 or after 19.01.2027. The owner is away in between, and the design must run with zero owner involvement in that period. |
| O | The old app stays live and unchanged for at least one month after launch. After that the owner decides whether to keep it or replace it with a pointer to the new address. |

## Migration path: what is live today

The repository does not settle this, and this session cannot read the Supabase dashboard (no project link, and
`supabase.com` is blocked).

| Evidence | Says |
|---|---|
| `docs/ops/MIGRATIONS.md`, CLAUDE.md | manual: `npm run push:prod` |
| `.github/workflows/apply-migrations.yml` | `workflow_dispatch` only, typed `apply`, on `main` only, with the same gates as `push:prod` |
| `docs/ops/PASSWORD_RESET.md:26` | "both happen on merge to `main`" (the migration and the function) |
| `docs/feedback-inbox.md:31` | "applied (label `deploy-backend`)"; no workflow in `.github/workflows/` reads that label |
| `.github/workflows/deploy-edge-functions.yml:51-59` | Edge Functions **do** deploy on push to `main` |
| Supabase GitHub integration | configured in the Supabase dashboard; nothing in the repository shows it, so it can be neither confirmed nor ruled out from here |

**The gate written into every session:** merge to `main`, then the session confirms with a read-only check that
production has no pending migration. Session 1 adds `migration-status.yml`, a read-only workflow: `workflow_dispatch`
plus `push` to `main` on `supabase/migrations/**`. It waits 10 minutes for the integration, then runs
`supabase migration list --linked` and `check:drift`, and fails if anything is pending.
- Green: the integration is live. Session 1 rewrites `MIGRATIONS.md` and the CLAUDE.md rule to say so. `push:prod`
  stays as the manual fallback and is no longer a gate.
- Red with pending migrations: the integration is not live. The session dispatches `apply-migrations.yml` (`confirm = apply`)
  itself. Approving the PR is the owner's instruction for that run. The session reports that the integration needs
  connecting, which is a dashboard step for the owner after his return, and does not block the launch.
- No manual `push:prod` step anywhere.

## Summary: where the plan as given is wrong or incomplete

| # | Finding | Effect | Fix |
|---|---|---|---|
| 1 | Supabase Auth allows **30 anonymous sign-ins per hour per IP** by default ([rate limits](https://supabase.com/docs/guides/auth/rate-limits)). Every sign-up here starts anonymous (decisions.md, Auth). | 250 members joining on launch night over the gym's Wi-Fi share one IP. The 31st person in an hour gets a 429. | Decided (6): `set-auth-config.yml` gains an `anon_limit` input (`rate_limit_anonymous_users`). The pilot session sets it to 300 before the link goes out. A scheduled check lowers it to 60 after seven days (session 1, see K). The join screen shows "יותר מדי הרשמות כרגע, נסו שוב בעוד שעה" on 429. Turnstile still gates each sign-up. |
| 2 | Push subscriptions belong to a **user**, not an app. `notif_push_pending` (`202611100001_lost_code_reset.sql:101`) sends every notification to every live subscription of the user. | A member signed in to both BOX-LOG and the club app gets club pushes on BOX-LOG and the other way round, and the tap opens a screen that app does not have. | Add `push_subscriptions.app` (`box-log`/`club`). Route club-circle notifications to `club` subscriptions only; everything else to `box-log`. |
| 3 | Decision 8 uploads body weight (encrypted). decisions.md says "Body weight never leaves the device", and `202610280001` bans it from `private_records`. | Contradiction between decisions. | Decided (2): the exception is recorded in decisions.md in session 1. The server holds ciphertext it cannot decrypt, at most 24 h, deleted on the first download; the key lives only in the code (see D). |
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
empty whatever its database is called. **Data moves only through the backup file or the transfer code.** Decided (7):
the new app opens `haimunia-club-db` at version 1, with 5.x's store set (the eight stores plus `syncOutbox`,
`wodMovementTags`, `communityOutbox`), from the first commit. Import still accepts 3.1.1's
`customWodMovementTags` array and writes it into the `wodMovementTags` store.

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
| Private log cloud backup with consent | `cloud.js` `private_records`, `renderBackupConsentCard`, `src/dormancy.js` | **skip** (decided 3): the `private_records` upload, the consent card, the dormancy panel and every cloud-backup entry point are removed, not hidden behind a flag. A test asserts that no request to `private_records` is made |
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
| Owner handoff (`circle_members_after_delete`, `202610250004:143`) | longest-standing member | club (decided 5): the coach becomes the owner, and the coach seat is empty; with no coach, the club has no owner until the owner reassigns it. A random member never inherits 250 people. Account deletion goes through the same trigger (202610290003) |
| Last member deletes the circle (same function) | yes | club: never automatic |
| `remove_member` (`202610250004:348`) | owner only | owner or coach. The coach cannot remove the owner or another coach |
| `clubs_update_owner` policy | owner edits settings | unchanged; the coach gets RPCs only |
| `circle_invites` (`202610250003:307`) | `max_uses` 1–20, 7-day expiry, 20 per day | club link: one active row, `max_uses` = cap, no expiry (`expires_at` far future, or a nullable column with a check tied to type) |
| `create_circle_invite` | issues a new link | club: `rotate_club_link(club)`, owner or coach. It deletes the old row and returns the new token once, 5 rotations per day |
| `join_circle` (`202610250004:423`) | 10 attempts per user per hour; `circle_full`, `too_many_circles` (10) | unchanged; the club counts as one of a member's 10 circles |
| `circle_share_defaults` (`:204`) | `else` = friends | explicit `when 'club'` (decided 4): `share_workouts` true, `share_prs` true, `share_percent` true, `share_weekly_count` true, `show_weights` false. `set_share_defaults` lets a member turn any of them off, and hidden data is never sent (decisions.md) |
| Announcements | dropped (`strip_gym`, decisions.md "Drop") | new table `club_announcements(id, club_id, author_id, body ≤ 500, pinned, created_at)`; RLS read for club members; writes only through `post_announcement`/`pin_announcement`/`delete_announcement` (owner or coach, 10 per day). No notification. decisions.md gets the club exception |
| Delete others' posts | none | `moderator_delete_post(post)` for the owner or coach of that club only, soft delete, `notifications` text cleared as in `circle_members_after_delete` |
| Notifications | reaction, trained_together, circle_joined, week_card, pr_circle | `notif_on_pr_post`, `notif_week_card_due` and `notif_on_circle_join` return early for `type = 'club'`. Reaction (1 per post per hour) and trained-together stay |
| `push_subscriptions` | per user | add `app` (finding 2); `register_push_subscription` takes it; `notif_push_pending` joins on it |
| `training_log_usage` | dropped | recreate (finding 4): insert-only for `anon` through a definer function, 1 row per device per event per day, purge at 400 days, `training_log_usage_report()` granted to no role |
| `transfer_blobs` | — | see D |
| `bug_reports` | owner reads | add `app` (`box-log`/`club`), default `box-log`; see J |
| Owner admin | SQL editor | granted-to-no-role functions `owner_create_club`, `owner_set_coach`, `owner_set_club_owner`, run by a new `club-admin.yml` workflow (`workflow_dispatch`, Management API SQL endpoint, the existing `SUPABASE_ACCESS_TOKEN`). It prints counts only, never a token or a username list: the repository is public, so its logs are public |

**Reassigning an ownerless club** (decided 5). Session 1 puts this line in `docs/ops/CLUB_OWNERSHIP.md`. Run it in the
Supabase SQL editor, or as `club-admin.yml` with `action = set_owner`:

```sql
select public.owner_set_club_owner('<username>');
```

It makes that member the owner of the one `club`-type circle. It refuses a username that is not a member, and it
demotes the current owner, if there is one, to member. It is `SECURITY DEFINER` with `search_path ''`, granted to no
role, and listed in the definer guard.

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
8. The owner-handoff rule: the owner leaves, or requests account deletion → the coach becomes the owner; no coach → no owner, the club survives; `owner_set_club_owner` restores one.
9. Transfer blob (decided 2): after a `transfer-put` of a fixture backup that includes body weight, the stored `ciphertext` does not parse as JSON (also after gunzip), and contains none of the byte strings `"entries"`, `"bodyweightEntries"`, `"weight"`, `"sessionNotes"`, `"app"`, `"box-log"`. It runs as a Deno test of the function and as a pgTAP check on the row.
10. The club's share defaults are the decided ones; a member's `set_share_defaults` off wins on the next post.

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
- CORS allow-list: exactly `https://haimuniya.github.io` for put and `https://haimunia.pages.dev` for take (since F-001, 2026-11-14, put also accepts `https://haimunia.pages.dev`; decisions.md) (today's functions send `*`, `_shared/recovery.mjs:72`).

**The stored blob is opaque** (decided 2): see test 9 in C. The function also refuses a body that parses as JSON,
so a client bug cannot upload plaintext.

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

Owner steps (decision B): **one Cloudflare visit.** It creates the Pages project `haimunia` from `shahafrach/haimunia-club`
(granting Cloudflare's GitHub app access to that repo) and adds `haimunia.pages.dev` to the existing Turnstile widget.
Everything else is done by a session or a workflow:
- The session creates the private repo (`mcp__github__create_repository`, requested at session start).
- `set-auth-config.yml` sets the redirect URL and the anonymous limit.
- `deploy-edge-functions.yml` deploys the functions on merge.
- The migration path is above.

## G. Capacity on the Free plan

Quotas: 500 MB database per project, 5 GB egress, 50,000 MAU, 500,000 Edge Function invocations; paused after a week
idle (the keepalive covers that) ([billing](https://supabase.com/docs/guides/platform/billing-on-supabase),
[pricing](https://supabase.com/pricing)) **(verify)**.

Assumptions: 250 members, 150 active weekly, 3 workouts each, every workout posted (decided 4).

| Item | Arithmetic | Per year |
|---|---|---|
| Posts | 150 × 3 × 52 = 23,400 rows × ~1.5 KB with indexes | ~35 MB |
| Reactions | 23,400 × 4 × ~200 B | ~19 MB |
| Notifications | ≤ 1 per post per hour plus tags, ~30,000 × ~600 B | ~18 MB (purge after 90 days → ~5 MB standing) |
| `training_log_usage` | 2 apps × 300 devices × 3 events × 365 × ~120 B | ~40 MB (purge at 400 days) |
| `transfer_blobs` | worst case 40 × 5 MB, gone within 24 h | ≤ 200 MB transient |
| `private_records` (if the club backs up the private log) | 250 × ~3,000 records × ~500 B | **~375 MB** |

Decided (3): the club has no private-log cloud backup, so the club adds about **120 MB a year** to BOX-LOG's footprint,
inside 500 MB with room for BOX-LOG. With the backup it would have filled the project in a year
(`private_records.payload` has no size check, `202608260001_community_foundation.sql:24`).

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
| Connected | Plus: username (no email), display name and emoji; club membership and role; posts per the share settings (workout summary or count, PR lift and percent, absolute weight only if chosen); reactions; trained-together tags; push endpoint; feedback text if sent; the recovery-code HMAC. **Never**: body weight, measurements, session notes, the private log (decided 3). |
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

**Decided: 3** (decision 8).
- "שאלה למאמן" is hidden until the coach agrees and `coachWhatsApp` is set in `app-config.js` of the club repo; then it opens `https://wa.me/<number>`.
- "תקלה באפליקציה" writes to `bug_reports` with `app = 'club'`.
- The owner does not read them routinely. The `feedback-inbox` workflow can filter by `app` when he chooses to. No club flow waits on a reply.

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
| The owner is away 22.11.2026 to 19.01.2027 and something needs him | See below. |

**Running with zero owner involvement** (decision T). Everything that can fail between 22.11.2026 and 19.01.2027
must fail safe or be handled by someone else:

| Event | Handled by |
|---|---|
| Lost password | recovery code, then the one-hour self-service reset (decisions.md); no owner step |
| Owner account gone or owner leaves | the coach becomes the owner (decided 5) |
| Abusive member or post | the coach removes or deletes |
| Join link leaked | the coach rotates it |
| Club full (250) | `circle_full` message; the coach removes inactive members |
| Transfer purge job stops | blobs stay, but each take still deletes its blob and the 40-blob cap stops new uploads. Data is not lost; transfers pause until the cap frees |
| Anonymous limit not lowered | the scheduled `auth-launch-limit.yml` (session 1) runs daily: if `rate_limit_anonymous_users` is above 60 and the last successful `set-auth-config.yml` run is more than 7 days old, it sets 60, and otherwise does nothing. About 15 s a day of Actions minutes |
| Project paused for inactivity | not with daily members; `keepalive.yml` is already scheduled |
| A bug report | waits in `bug_reports`; nothing blocks on it |
| GitHub Actions minutes run out (happened 2026-09-19) | the apps keep working; only the limit-lowering check stops. The pilot session confirms the minutes left before the link goes out |

Launch before 22.11.2026 only if all four sessions finish and the pilot is a "go" by **20.11.2026**, leaving two days to
watch it run. Otherwise launch after 19.01.2027. The old app's one-month minimum then ends while the owner is back.

---

## Build sessions

Four sessions (decision C). Each session reads CLAUDE.md, `docs/circles/decisions.md` and this file first. Each
ends with one full `npm test` and one browser-check run, in the foreground, and reports the printed numbers.

### 1. BOX-LOG club backend

| | |
|---|---|
| Repo | `shahafrach/haimunia-app-demo`, one branch, one PR at the end |
| Depends on | nothing. Before writing the migration it checks that no other open PR adds one (CLAUDE.md, Parallel work) |
| Scope | **Decisions:** decisions.md and journal.md get the owner decisions above. **Schema:** one migration with everything in C, `transfer_blobs`, `training_log_usage`, `push_subscriptions.app`, `bug_reports.app`, the owner functions. **BOX-LOG client:** hides `type = 'club'` circles and sends `app = 'box-log'` on push register. **Transfer functions:** `transfer-put`, `transfer-take` (D), purge job and job-health entry. **Workflows:** `set-auth-config.yml` gains `anon_limit` and the club redirect URL; new `auth-launch-limit.yml` (daily, K), `club-admin.yml` (C), `migration-status.yml` (Migration path). **Load test:** `0152_club_load_test.sql` (H). **Docs:** `docs/ops/CLUB_OWNERSHIP.md`, and `MIGRATIONS.md` corrected once the migration path is known |
| Owner gates | approve the PR |
| Done when | the PR is green on a branch updated from `main` and merged; `migration-status.yml` is green (or `apply-migrations.yml` ran, per Migration path); `check-edge-functions-deployed.mjs` passes; `club-admin.yml action=create_club` has run, creating the club with the owner as its first member |
| Must pass | `npm test`; `node scripts/browser-check/run-all.mjs`; `supabase test db` (CI) with tests 1–10 from C and `0152`; `check-migration-immutability`, `check-migration-versions`; the Deno tests for both functions, including the opaque-blob test (decided 2); `test/sw-precache.test.mjs` and the design-token guards for any client change |

### 2. Haimunia club app

| | |
|---|---|
| Repo | `shahafrach/haimunia-club` (new, private), created by the session |
| Depends on | session 1 merged and its migration applied |
| Scope | **Birth:** 5.x's client copied without the circles-only parts (B, "skip"), the percentage table and usage counting ported, `haimunia-club-db` (decided 7), config for `haimunia.pages.dev`, `_headers`, `_middleware.js`, CSP, the `sw.js` precache list. **Offline mode.** **Connected mode:** join by link, the 429 message (decided 6), sign-up and recovery, feed, reactions, trained-together, announcements, coach tools, two notification types, push with `app = 'club'`, offline → connected with the log kept on the device and nothing uploaded, no cloud-backup entry point (decided 3), the support split (decided 8), the privacy page (I). **Transfer import:** installed-only paste screen, decrypt, import with `prefs`, placeholder WOD, save-as-file fallback, `persist()` |
| Owner gates | **one mid-session gate**: the Cloudflare visit (F). The session pushes the repo, prints the two steps, and **waits until the owner types "continue"**. Then the PR to the club repo's `main`, approved by the owner |
| Done when | `https://haimunia.pages.dev` serves the merged `main`; a smoke run on the live URL passes (offline log, join with a test link, one reaction, a transfer round trip with a synthetic backup that includes body weight); the test account is then deleted |
| Must pass | the ported jsdom suite, plus new tests: `haimunia-club-db` names and stores; import of `old:test/fixtures/old-app-backup-v1.json`, `old-app-backup-emom.json` and `v2.34.0-device.json` with counts equal to the file and old club-WOD results kept; a ciphertext made by the old app's export code decrypts here (a shared fixture); no `private_records` request; the transfer screen refuses outside standalone mode; 429 shows the Hebrew line; the design-token and contrast guards; `sw-precache`. Browser checks in Chromium for every new screen (layout, keyboard, a11y). An e2e run against local Supabase: join, 251st join refused, coach removes and rotates, a member's privacy off wins |

### 3. Haimunia old app update

| | |
|---|---|
| Repo | `haimuniya/haimunia-app`. **Needs push access** (decided 1). If it is missing at start, the session stops and reports; it does nothing else |
| Depends on | session 1 (the transfer function and `training_log_usage` live) and session 2 (the new URL live) |
| Scope | One release (decision 10): the banner to the new address, the transfer-code export (encrypt on the phone, `transfer-put`, the code shown once and copyable), the usage config and CSP pointed at `hvwakffluwvegedefoth.supabase.co`, `APP_VERSION`/`SW_VERSION` bumped, `CHANGES.md`. No IndexedDB version or store change. The banner shows from the date in `app-config.js` `clubBannerFrom` (set to launch day); the transfer entry in Settings works from the merge, so the pilot can use it before the banner shows. The session creates the rollback ref itself as a branch `rollback-3.1.1` (the old repo's CLAUDE.md asks the owner for a tag; a branch needs no owner step) |
| Owner gates | merge the PR at launch |
| Done when | the PR is open and green and the rollback branch exists. The owner's merge is the launch |
| Must pass | the full `npm test` of that repo, including `storage-compat`, `upgrade-in-place`, `old-app-backup-imports` and `usage-counting` (no real count sent); new tests: the transfer payload round-trips through the club app's decrypt fixture, the code has ≥ 100 bits, the request body is not JSON, and the banner is hidden before `clubBannerFrom`; the browser checks in `scripts/browser-check/` |

### 4. Haimunia pilot

| | |
|---|---|
| Repos | both apps (read), `haimunia-app-demo` (workflow runs only) |
| Depends on | sessions 1–3 done; the old app PR merged by the owner |
| Scope | **Before:** confirm the Actions minutes left, and that the coach is named (`club-admin.yml action=set_coach` after the coach has joined). **Pilot:** the coach picks three members, at least one iPhone and one Android. Each makes a transfer code in the old app, installs the club app from the banner flow, pastes the code, and sends a screenshot of both count screens. **Check:** counts are equal per group (entries, WOD results, custom movements and WODs, body weight, measurements, notes); a reaction push arrives on each phone. **Launch** (after go): run `set-auth-config.yml` with `anon_limit = 300`, then the coach sends the link. **Seven days later:** `auth-launch-limit.yml` lowers it to 60 on its own; the session lists that run in its checklist and the date it is expected |
| Owner gates | name the coach; go / no-go |
| Done when | three matching count reports, three pushes received, the limit raised, the link sent by the coach |
| Must pass | the counts check; `migration-status.yml` green; `scheduled-job-alert` reports every job healthy (including the transfer purge) |

Order: 1 → 2 → 3 → 4. Launch before 22.11.2026 only if session 4 says "go" by 20.11.2026; otherwise the four sessions run
in full before the owner leaves, and session 4 waits until after 19.01.2027.

## Still open

| # | Item | Proposal |
|---|---|---|
| 1 | **First join link for the coach.** A join token must never appear in a public repository's workflow logs, so `club-admin.yml` cannot print it. The coach needs a first link. | Fold it into "name the coach". `owner_create_club` makes the owner's existing BOX-LOG account the club's first member. The owner opens the club app once, signs in, taps "קישור הצטרפות" and sends it to the coach in the same message that asks the coach to accept. Confirm the owner has a BOX-LOG username on the project. |
| 2 | **Is the Supabase GitHub integration connected?** The repository cannot show it (Migration path). | Session 1's `migration-status.yml` answers it on the first merge. If it is not connected, connecting it is a dashboard step for after 19.01.2027, and `apply-migrations.yml` covers the launch. |
| 3 | **Launch window.** Today is 11.11.2026; launching before 22.11.2026 needs four sessions and a pilot in nine days. | Plan for after 19.01.2027 unless session 1 is merged by 14.11.2026. |
| 4 | **Coach's WhatsApp number** is stored in a committed config file of a private repo, served to every visitor of the site. | Only with the coach's consent (decided 8); the button stays hidden until then. |
