# Home port notes (second batch)

Home (`shahafrach/home`) is read-only reference. Method per feature: what Home does, the gap in BOX-LOG, what shipped.

## 1. Push notifications

**Home:** VAPID key pair as Edge Function secrets (public key also in the build); `register_push_subscription` RPC stores
endpoint + keys per device; `push-sw.js` handles `push` and `notificationclick`; Edge Function `send-reminders` is
called by `pg_cron` through `pg_net` with a shared key from Vault; permission is requested only from a tap; iPhone
gets push only after "Add to Home Screen" and Settings explains it.

**BOX-LOG already had all of that** (`sw.js` push handlers, `push_subscriptions`, `notif_push_send` + cron every 3
minutes, `rotate-vapid` workflow so nobody sees the private key, iOS install gate in the toggle panel, permission asked
from the toggle tap). Nothing was rebuilt. Gaps were the triggers:

| Brief | Result |
|---|---|
| Workout reminder, chosen time and days | **New.** `reminder_prefs` (days, hour, 15-minute grid, Asia/Jerusalem), cron `reminder_push_due` every 15 min. Content-free text: the server never sees the private log, so it cannot know you already trained. Off by default. |
| Reaction in a circle | **Now on by default** (missing row = on for this one type; an explicit off row wins), server and client. |
| Comment in a circle | **Skipped:** `decisions.md` has no text comments, only reactions. |
| New PR by a circle member | **New** type `pr_circle`, trigger on `POST_PR` going active, to the other members; names the member only (no lift, no weight). Off by default. |
| Each behind its own toggle | Yes, same Me panel; 3 new switches. |

Delivery of the two personal types reuses `notif_push_pending`/`notif_push_send` (circle requirement relaxed for
them only). Tapping one opens the Add tab (`/tab/add`), also on a cold start (`sw.js`).

Secrets: none new. VAPID already exists through the `rotate-vapid` workflow.

## 2. Weekly progress digest

**Home:** the daily digest is one `pg_cron` job (hourly, minute 5) that counts due items per user on the server and
sends one push through `send-reminders`; per-user `digest_enabled` and an hour; the same push path as reminders.

**BOX-LOG differs on purpose:** the training log is private and stays on the device (`decisions.md`), so the server cannot
count workouts, PRs or 1RM. The push is therefore content-free ("הסיכום השבועי שלך מוכן") and the numbers are built
on the phone when the screen opens.

- Schedule: `reminder_prefs.digest_day/hour/minute` (default Friday 10:00), picked in Me under the `weekly_digest` switch (off by
  default; switching off stops it). Same `reminder_push_due` job as the workout reminder (migration `202611080002`).
- Progress screen: already existed (התקדמות). Added **"השבוע שלך"** at its top (`BoxLogProgress.weekDigest`/`digestLines`):
  workouts vs target, new PRs, 1RM estimate increases, weeks on target in a row. Only good news: a lower estimate or an empty
  week yields no failure line. "Streak" is weeks, not days (`decisions.md`: no daily streaks).
- One tap opens it: the push deep link is `/tab/history`, also from a cold start.

## 3. Feedback inbox

**Home:** table `feedback` (kind bug/idea/question, status new/doing/done, app version); users insert and read only their
own rows; no update/delete grant to clients; the owner reads everything with the service role / dashboard. There is no
automated reader in Home.

**BOX-LOG already had** the form, the table (`bug_reports`, no client grant, rate limit 5/hour, status, staff RPCs).
**Added:** `read_at` and `tag` (migration `202611080003`), and the reader: the manual **feedback-inbox** workflow
(`scripts/feedback-inbox.mjs`) that prints unread reports (no reporter id, no device facts) and optionally marks exactly
those read. How to ask a session to use it: [feedback-inbox.md](feedback-inbox.md).

## 4. Encryption at rest

**Home:** voucher codes only. AES-256-GCM in the browser (`src/lib/voucherCrypto.ts`), stored as
`enc:v1:<key ref>:<iv>:<ciphertext>`; the key (one per user or household) lives in Supabase Vault and is fetched once per
session through an RPC, held in memory only; the device cache keeps the plain code; old plain rows still read; migration
pattern is "new values are written encrypted, old ones are re-encrypted on next sync".

**BOX-LOG audit of what is stored server-side** (every table in `supabase/migrations`):

| Data | Where | Verdict |
|---|---|---|
| Body weight | device only; `private_records` CHECK forbids the type (202610280001) | stays on device, untouched |
| Passwords | Supabase Auth (bcrypt) | not ours to encrypt |
| Recovery codes, reset codes | HMAC-SHA256 only (`recovery_codes`) | already one-way, better than encryption |
| Email / phone / health columns | none exist, by rule | nothing to encrypt |
| Push endpoint + keys | `push_subscriptions` | server needs them in the clear to send; encrypting with a server-held key adds nothing |
| Training log backup (`private_records`: sets, WODs, custom moves, measurements, notes) | owner-only RLS, no circle ever sees it | see below |
| Bug report text | `bug_reports`, no client grant | member-written, staff-read by design |
| DB dumps | `backup-database.yml` | already encrypted with `BACKUP_PASSPHRASE` |

**Decision: skip.** The only candidates are user-defined body measurements (waist, chest) and free-text session notes in the
private backup. They are disclosed in `PRIVACY.md`, readable only by their owner under RLS, disk-encrypted by Supabase, and
reach backups only through the already-encrypted dump. Home's scheme keeps the key in the same Supabase project, so it would
not protect against the one party that can read the table, while adding a real risk: a lost key or a bug makes a member's
whole backup unreadable on restore. Revisit if a health-type field is ever added (the rule forbids it today) or if the
backup is ever exposed to someone besides the owner.

## 5. Accessibility

**Home's standards** (`audit/UX-AUDIT.md`, `docs/SYSTEM.md`): axe clean at WCAG 2.2 AA; real pixel contrast on every style and mode;
44 px controls (switch rows are the tap target); `aria-invalid` + `aria-describedby` on every field, errors linked; named
tiles; dialog pattern (Esc, focus return); `data-reduce-motion` and `prefers-reduced-motion` collapse motion to zero.

**BOX-LOG already met most of it** (axe scan on 5 screens, token contrast tests for 6 palettes, a global reduced-motion
rule, logical RTL properties). Gap: none of it was measured on the account screens or in a real browser per palette, and the
touch-target rule was not measured at all. New check `scripts/browser-check/a11y-screens-palettes.mjs` (run by `run-all`) measures,
at 320 px: sign-up explainer, login, forgot password, two-step code gate and its recovery form, Me (security panel, enrolment,
confirm forms, both schedules) and Progress with the weekly summary, for 44 px targets, axe serious/critical, colour contrast in
all 6 palettes (classic default + chalk, slate, cedar, sand, iris) in light and dark, tab order, sideways scroll, and endless
animation under reduced motion.

**Fixed (all found by that check):**
- every `label.log-row` (switch or checkbox row) is now at least 44 px (share settings, share prompt);
- `.link-btn` 36 → 44 px (e.g. "+ הוספת מדד חדש"); the Progress search input 26 → 44 px;
- day chips in the new schedules: spoken name now contains the visible letter (WCAG 2.5.3), 44 px chips;
- header logo in classic/light is a known **axe false positive** (white text over a dark photo; checked on a screenshot), excluded in the check only.

Result: 60 of 60 checks pass. Not measured: iOS Safari/VoiceOver and Android TalkBack by hand (no device here), 200 % text zoom.
