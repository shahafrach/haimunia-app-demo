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
