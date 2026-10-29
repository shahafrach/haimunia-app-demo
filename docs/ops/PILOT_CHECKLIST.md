# Pilot checklist: the owner's walk-through

On **https://box-log.pages.dev** with two phones. Call them **A** (yours) and
**B** (a friend's, or a spare). Use Safari or Chrome, not the WhatsApp browser.
Do the steps in order. Each line: what to do, what success looks like, what to
do if it fails.

Before you start: migration `202610290001_pilot_readiness` is on the box-log
project, and the Turnstile setting is on in the Supabase dashboard
(Authentication, Attack Protection, `COMMUNITY_SETUP.md`). Never paste a link
in a public place: the bootstrap link is a key.

| # | Step | Success looks like | If it fails |
|---|------|--------------------|-------------|
| 1 | **A**: Supabase SQL editor, run `select public.bootstrap_owner_invite();` ([FIRST_CIRCLE.md](FIRST_CIRCLE.md)). Copy the link. | One cell with `https://box-log.pages.dev/#invite=` and 64 characters. | "function does not exist": the migration is not applied (`npm run push:prod`). |
| 2 | **A**: open the link in Safari/Chrome. Tap the join button. | A screen "הוזמנת להצטרף למעגל", then the account step (username and password). The address bar no longer shows the `#…`. | "ההזמנה לא תקפה": over an hour old or already used, run step 1 again. |
| 3 | **A**: sign up: username, password, then name and emoji. **This is the first real Turnstile check.** | Account created, profile saved, then "עוד אין לך מעגל" with **יצירת מעגל**. | Stuck on "מתחברים…" or a captcha error: Turnstile site key or hostname (`box-log.pages.dev`) is wrong in the Cloudflare widget, or enforcement was enabled before the key shipped. Check `COMMUNITY_SETUP.md`. |
| 4 | **A**: **יצירת מעגל**, type Friends, a name, an emoji. | The circle opens on the feed, you are the owner. | "not authorized": the redemption did not land; redo from step 1. |
| 5 | **A**: in the circle, **הזמנה**, **שיתוף**, send the link to **B** (WhatsApp is fine). | A message with a link and "הקישור תקף 7 ימים". | "invite_limit"/"circle_full": see the circle's invites; not expected on day one. |
| 6 | **B**: open that link **in Safari/Chrome** (from WhatsApp, "open in browser" if asked). Sign up with its own username. | B lands in the circle; A sees "someone joined" if A turned that notification on. | Link says invalid: it was used up or older than 7 days; make a new one. In-app browser page: follow its steps to open in Safari/Chrome. |
| 7 | **A**: Log tab (center button), log a set of a lift. | Prefilled from the last session; saved in under 30 seconds. | Offline banner: reconnect, it queues. |
| 8 | **A**: share the workout/PR to the circle (the share bar offers it). | **B** sees it in the circle feed within a refresh. A PR shows the lift and a percent, no absolute weight unless A chose to show weights. | Nothing on B: pull to refresh; check both are in the same circle. |
| 9 | **B**: react to A's post (fist bump, fire, clap). | The count updates on both phones. | Reaction not saved: check the network; one tap per kind. |
| 10 | **A**: tag **B** as trained together. **B**: confirm (**התאמנו יחד**). | After B confirms, it counts in the week view for B. | No prompt on B: reload; the tag appears on the Home/Circle screen. |
| 11 | **A** and **B**: Me, notifications, turn on the four switches, allow the browser prompt. Add the app to the Home Screen first on iPhone. | A test reaction/tag produces a push on the other phone. | No push on iPhone: the app must be installed to the Home Screen. Check `VAULT_SECRETS.md` and the `rotate-vapid` workflow; `job_health_check()` in `MONITORING.md`. |
| 12 | **A**: circle, **השבוע** tab. | Both members with percent of own target; A's tagged workout counted once B confirmed. | Empty week: set a weekly target in Me (**קביעת יעד**). |
| 13 | **B**: **עזיבת המעגל**, confirm. | B is out; A sees "a member left"; B's posts in the circle are gone. | Still listed: reload on A. |
| 14 | **A**: send a new invite; **B** opens it and joins again. | B is back, with no earlier posts. | Use a fresh link, the old one is spent. |
| 15 | **B**: Me, **פנייה**, write "בדיקה", send. Then **A** reads it in the dashboard (Table Editor, `bug_reports`, [SUPPORT.md](SUPPORT.md)). | A row with the text and the app version, nothing else. | "לא הצלחנו לשלוח": signed out? Rate limit is 5 an hour. |
| 16 | **B**: Me, **בקשת מחיקת חשבון**, confirm. | B is signed out; the account is gone from Authentication, Users once the deletion runs; A's circle shows a member left. | Account still listed: deletion has a grace period; it is purged by the scheduled job. |
| 17 | Backups: [BACKUPS.md](BACKUPS.md), run the workflow once with the drill. | Both jobs green. | The log names the missing secret. |

When all lines pass, send the invitation message ([INVITE_MESSAGE.md](INVITE_MESSAGE.md)).
