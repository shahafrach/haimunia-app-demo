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
