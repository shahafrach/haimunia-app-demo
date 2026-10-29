# User tests, October 2026

Three end-to-end tests of BOX-LOG, run as real people against a real backend, plus a
usability pass. Nothing here touched production: the backend is a throwaway local
Supabase stack on the CI runner, every address is checked to be loopback, and the
browser aborts (and fails the run on) any request that leaves the machine. All three
scripts ended with `isolation: PASS` and no blocked request.

**Result: 43 of 53 steps pass** (40 of 50 steps plus the three isolation checks), 10 fail. Of the 10: **4 are product problems** (findings 1, 2, 3 and 5; the table says which), 5 are
mistakes in the test scripts that are written down below and not yet fixed, and 1 could not
start because of an earlier failure. Source: CI run 40937913305, commit `7487f0d`, the
third and last push allowed for this work. The two harness mistakes are small and known; they
are fixed in a local commit that is **not pushed** because it would be a fourth push.

Earlier runs, for the record: the first real run (merge commit `9517b52`) reached sign-up and
stopped at an overlay; run 40933660737 (`a2d500b`) passed 28 of its steps. That run's job was
green although 28 steps failed, because the runner shell is plain `bash -e` and `| tee` hid the
script's exit status; fixed in `7487f0d`, so a failed step now fails the job.

## How the tests run

- **Backend:** `supabase start` on the runner, every migration applied (`202610290002_founder_link` included, merged from main during this work). Anonymous sign-ins on, email confirmation off, as in `supabase/config.toml` and on production.
- **First circle:** `select public.bootstrap_owner_invite()` run with `psql` as `postgres`, as `docs/ops/FIRST_CIRCLE.md` says. The link it returns names the production host; the tests keep only the token and open it on the local page.
- **Browser:** Chromium 151 (Playwright 1.62.1) at 390x844, device scale 2, touch, locale he-IL, Asia/Jerusalem, RTL as the app sets it. One browser context per person, real sign-ups, no mocked backend.
- **Measuring:** taps and typed fields are counted by the script's own helpers (`Person.tap`, `Person.type`); seconds are wall time of the step, which includes waiting for the server; contrast is computed from the page's computed styles (WCAG 2.x, text over an image is measured from pixels with the text hidden); layout (right-to-left, sideways scroll, controls under 44 px, controls below the fold) is read from bounding boxes.
- **Screenshots:** each step saves dark Classic and one light palette (rotating through the six), `NN-step-person-dark-classic.png` and `NN-step-person-light-<palette>.png`, in the `e2e-user-tests` artifact of the CI run, with `results.json`, `summary.md` and the log per test.

### What is different from production (and so not tested)

| Difference | Effect |
|---|---|
| **CAPTCHA is off.** The local stack has no Turnstile secret; the override config has an empty `captchaSiteKey`. | The Turnstile step of sign-up (PILOT_CHECKLIST step 3, "the first real Turnstile check") is **not covered**. |
| The page is configured with a stand-in host (`e2e-local.supabase.co`) that the runner answers from the local stack, because `cloud.js` only accepts `https://*.supabase.co`. `cloud.js` is served as shipped. | None for behaviour. |
| The served `index.html` has the project host in its Content-Security-Policy swapped for the stand-in host. | The shipped CSP is not what was tested. |
| Service workers are blocked. | Offline is tested as a lost connection with the queue in IndexedDB, not as an installed PWA with the precache. |
| Chromium with a phone user agent (iPhone Safari for Dana and Noa, Android Chrome for the others, WhatsApp for one visit) and viewport, not a phone. | The iOS Add to Home Screen sheet shows because of the user agent; push, the share sheet (a file is downloaded instead) and the keyboard are not real. |

## Results

`PASS`; `FAIL (product)`; `FAIL (harness)` (the script was wrong or raced the app); `FAIL (not reached)` (an earlier step left nothing to act on).

### Test 1: the owner (Dana)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/01-owner/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Open the bootstrap link | dana | PASS | 4.209 | 0 | 0 | `01-bootstrap-link-dana-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Sign up with a username and password | dana | PASS | 0.849 | 2 | 3 | `02-sign-up-dana-dark-classic.png`, `-light-slate.png` |  |
| 3 | Choose a name and an emoji | dana | PASS | 0.327 | 2 | 1 | `03-name-emoji-dana-dark-classic.png`, `-light-cedar.png` |  |
| 4 | Create a Friends circle | dana | PASS | 2.857 | 2 | 1 | `04-create-circle-dana-dark-classic.png`, `-light-sand.png` |  |
| 5 | Set a weekly target of 3 | dana | PASS | 0.379 | 4 | 0 | `05-weekly-target-dana-dark-classic.png`, `-light-iris.png` |  |
| 6 | Log the first set ever (Back Squat 60 x 5) | dana | PASS | 1.295 | 7 | 3 | `06-first-set-dana-dark-classic.png`, `-light-classic.png` |  |
| 7 | Log the same lift twice more | dana | PASS | 1.134 | 6 | 4 | `07-baseline-sets-dana-dark-classic.png`, `-light-chalk.png` |  |
| 8 | Log a heavier set so a PR fires | dana | FAIL (harness) | 0.249 | 3 | 2 | `08-pr-moment-dana-dark-classic.png`, `-light-slate.png` | HARNESS: the script raced the app: the moment opened a moment later (step 9 found its button). |
| 9 | Render and share the PR card | dana | PASS | 0.256 | 2 | 0 | `09-pr-card-dana-dark-classic.png`, `-light-cedar.png` |  |
| 10 | Share the PR with the circle | dana | FAIL (product) | 8.267 | 1 | 0 | `10-pr-share-dana-dark-classic.png`, `-light-sand.png` | PRODUCT (probable): the share worked (request, percent-only row) but no confirmation appeared on the Log tab within 8 s (finding 5) |
| 11 | Open the week view | dana | PASS | 0.228 | 2 | 0 | `11-week-view-dana-dark-classic.png`, `-light-iris.png` |  |
| 12 | Turn on all four notification switches | dana | PASS | 0.663 | 6 | 0 | `12-notifications-dana-dark-classic.png`, `-light-classic.png` |  |

### Test 2: the friend (Yoav)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/02-friend/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Dana signs up and creates the circle | dana | PASS | 8.067 | 6 | 5 | `01-dana-circle-dana-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Dana turns on sharing workouts | dana | PASS | 0.372 | 3 | 0 | `02-dana-share-setting-dana-dark-classic.png`, `-light-slate.png` |  |
| 3 | Dana logs a set and it goes to the circle | dana | PASS | 0.929 | 5 | 3 | `03-dana-logs-dana-dark-classic.png`, `-light-cedar.png` |  |
| 4 | Dana creates an invite link | dana | PASS | 1.129 | 5 | 0 | `04-dana-invite-dana-dark-classic.png`, `-light-sand.png` |  |
| 5 | Yoav opens the link inside WhatsApp | yoav-whatsapp | PASS | 4.283 | 0 | 0 | `05-yoav-whatsapp-yoav-whatsapp-dark-classic.png`, `-light-iris.png` |  |
| 6 | Yoav opens the link in his browser and signs up | yoav | PASS | 5.206 | 4 | 4 | `06-yoav-signup-yoav-dark-classic.png`, `-light-classic.png` |  |
| 7 | Yoav sees Dana's post | yoav | PASS | 0.16 | 2 | 0 | `07-yoav-feed-yoav-dark-classic.png`, `-light-chalk.png` |  |
| 8 | Yoav reacts with all three reactions | yoav | PASS | 0.461 | 3 | 0 | `08-yoav-react-yoav-dark-classic.png`, `-light-slate.png` |  |
| 9 | Dana sees Yoav's reactions | dana | PASS | 0.556 | 2 | 0 | `09-dana-sees-reactions-dana-dark-classic.png`, `-light-cedar.png` |  |
| 10 | Dana tags Yoav as trained together | dana | PASS | 0.498 | 4 | 0 | `10-dana-tags-dana-dark-classic.png`, `-light-sand.png` |  |
| 11 | Yoav confirms training together | yoav | PASS | 5.566 | 3 | 0 | `11-yoav-confirms-yoav-dark-classic.png`, `-light-iris.png` |  |
| 12 | Yoav shares a workout of his own | yoav | PASS | 0.822 | 7 | 3 | `12-yoav-posts-yoav-dark-classic.png`, `-light-classic.png` |  |
| 13 | Dana sees Yoav's post | dana | PASS | 7.917 | 7 | 0 | `13-dana-sees-yoav-dana-dark-classic.png`, `-light-chalk.png` |  |
| 14 | Yoav leaves the circle | yoav | FAIL (harness) | 15.785 | 4 | 0 | `14-yoav-leaves-yoav-dark-classic.png`, `-light-slate.png` | text check wrong: after leaving he sees the "step 1 of 3, paste an invite link" screen, not "עוד אין לך מעגל"; every database check passed (finding 7) |
| 15 | Dana no longer sees his posts | dana | PASS | 3.098 | 3 | 0 | `15-dana-sees-gone-dana-dark-classic.png`, `-light-cedar.png` |  |
| 16 | Dana invites Yoav again | dana | PASS | 0.707 | 4 | 0 | `16-dana-reinvites-dana-dark-classic.png`, `-light-sand.png` |  |
| 17 | Yoav rejoins with the new link | yoav | FAIL (harness) | 12.001 | 0 | 0 | `17-yoav-rejoins-yoav-dark-classic.png`, `-light-iris.png` | HARNESS: the join form is already inline on that screen; the script looked for the sheet button |

### Test 3: privacy and limits (Noa and Avi)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/03-privacy/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Noa creates a Couple circle | noa | PASS | 8.227 | 7 | 5 | `01-noa-couple-noa-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Noa makes one invite for Avi and keeps a spare | noa | PASS | 1.305 | 6 | 0 | `02-noa-invites-noa-dark-classic.png`, `-light-slate.png` |  |
| 3 | Avi joins with the first invite | avi | PASS | 5.261 | 4 | 4 | `03-avi-joins-avi-dark-classic.png`, `-light-cedar.png` |  |
| 4 | A third person opens the spare invite and is refused | cleo | PASS | 4.469 | 1 | 0 | `04-cleo-refused-cleo-dark-classic.png`, `-light-sand.png` |  |
| 5 | Noa tries to make a third invite | noa | PASS | 15.558 | 4 | 0 | `05-noa-third-invite-noa-dark-classic.png`, `-light-iris.png` |  |
| 6 | Noa creates a second circle | noa | PASS | 1.928 | 3 | 1 | `06-noa-second-circle-noa-dark-classic.png`, `-light-classic.png` |  |
| 7 | Noa sets what each circle gets | noa | PASS | 0.369 | 3 | 0 | `07-noa-settings-noa-dark-classic.png`, `-light-chalk.png` |  |
| 8 | Noa logs four Back Squat sets, the last a PR | noa | FAIL (harness) | 2.118 | 16 | 9 | `08-noa-squat-sets-noa-dark-classic.png`, `-light-slate.png` | HARNESS: same race as Test 1 step 8 |
| 9 | She shares that PR with the couple only | noa | PASS | 8.446 | 3 | 0 | `09-noa-squat-pr-noa-dark-classic.png`, `-light-cedar.png` |  |
| 10 | Noa logs four Deadlift sets, the last a PR | noa | FAIL (harness) | 1.416 | 14 | 9 | `10-noa-deadlift-sets-noa-dark-classic.png`, `-light-sand.png` | HARNESS: same race |
| 11 | She shares that PR with the friends circle only | noa | PASS | 8.411 | 3 | 0 | `11-noa-deadlift-pr-noa-dark-classic.png`, `-light-iris.png` |  |
| 12 | Noa looks at the friends circle's feed | noa | FAIL (product) | 1.003 | 5 | 0 | `12-noa-friends-feed-noa-dark-classic.png`, `-light-classic.png` | PRODUCT: the PR card shows the lift and the date and no percent (finding 3) |
| 13 | Noa looks at the couple's feed | noa | PASS | 0.787 | 5 | 0 | `13-noa-couple-feed-noa-dark-classic.png`, `-light-chalk.png` |  |
| 14 | Avi sees the couple's circle and nothing else | avi | PASS | 7.893 | 7 | 0 | `14-avi-sees-couple-only-avi-dark-classic.png`, `-light-slate.png` |  |
| 15 | Noa logs her body weight | noa | PASS | 6.798 | 4 | 1 | `15-noa-bodyweight-noa-dark-classic.png`, `-light-cedar.png` |  |
| 16 | Avi logs a set with no connection | avi | PASS | 2.624 | 5 | 3 | `16-avi-offline-avi-dark-classic.png`, `-light-sand.png` |  |
| 17 | Noa sees the post that was queued | noa | PASS | 0.175 | 2 | 0 | `17-noa-sees-offline-post-noa-dark-classic.png`, `-light-iris.png` |  |
| 18 | Noa sends a friend a founder link | noa | FAIL (product) | 10.576 | 5 | 0 | `18-founder-send-noa-dark-classic.png`, `-light-classic.png` | PRODUCT: create_founder_invite answered 400 "not authorized" for a member who signed up minutes earlier (finding 1) |
| 19 | The friend signs up and creates their own circle | dev | FAIL (not reached) | 29.55 | 3 | 1 | `19-founder-friend-dev-dark-classic.png`, `-light-chalk.png` | not reached: no founder link |
| 20 | Avi deletes his account | avi | PASS | 2.065 | 4 | 0 | `20-avi-deletes-avi-dark-classic.png`, `-light-slate.png` |  |
| 21 | Avi disappears from the circle | noa | FAIL (product) | 1.915 | 7 | 0 | `21-noa-sees-avi-gone-noa-dark-classic.png`, `-light-cedar.png` | PRODUCT: his membership row is still there and the header still says 2 members (finding 2) |

Harness mistakes behind the five `FAIL (harness)` rows, all in `scripts/e2e/` and fixed locally, not pushed:
1. `afterSave` returned on the quiet "נשמר ✓" class before the post-workout moment had opened (step 9 of Test 1 found its share button a fraction of a second later, so **the moment does open**). Steps 8 (Test 1), 8 and 10 (Test 3). The assertions about the moment's order (PR, comparison, ring, share) have therefore not run.
2. After leaving their last circle a member sees an inline "paste an invite link" form, not a sheet; `joinByPaste` looked for a sheet button (Test 2, step 17), and the "he is told he has no circle" check expected other words (step 14, finding 7).

## What worked, as measured

- **Sign-up:** bootstrap link to a permanent account in 2 taps and 3 typed fields (0.8 s); no real email is stored (`<name>@members.haimuniya.invalid`); the token is removed from the address bar; name and emoji saved; the app then opened the create-circle sheet by itself (link to circle: 0 + 2 + 2 + 2 taps for Dana).
- **The friend's path (Test 2, steps 1 to 13 and 15, 16):** the WhatsApp browser shows three numbered steps naming Safari and WhatsApp, a copy-link button and "continue here anyway", and creates no account; in a normal browser Yoav signed up and landed in Dana's circle as a member, saw her post (no kilograms), reacted with all three kinds (`fist_bump`, `fire`, `clap`; three rows in the database), Dana saw the counts, tagged him, Yoav saw the pending card on Home (it needed no reload), confirmed, posted his own workout, Dana saw it; when he left, his membership, posts, reactions and tag were all gone and Dana's feed, member list and counts followed.
- **Privacy (Test 3):** a PR shared with weights hidden sent `pr_share` with no `p_weight` and the stored post carried only `+x%` and no kilograms; the PR prompt tells the member so for each circle ("בלי משקל מוחלט"). Body weight: 118 requests inspected over the session, none mentions it or its value, and the server holds no `bodyweight` record while all 8 lift entries were backed up; it is kept after a reload. Circle isolation: Noa's two circles each asked for their own feed, the couple's feed holds no Deadlift and the friends feed no Back Squat, Avi (in one circle) saw only the couple's PR, and the member lists did not mix.
- **The Couple limit:** a spare invite opened by a third person (Cleo) gave "המעגל הזה מלא ואין בו מקום לעוד חברים" and no membership; Noa's third invite was refused with "המעגל מלא, אי אפשר להזמין עוד חברים".
- **Offline:** Avi logged a set offline, the bar said it would be sent when the connection returns, nothing reached the server, and the post arrived 502 ms after the connection came back; Noa then saw it.
- **PR card:** a 104,695-byte PNG was rendered and handed over (downloaded here, no share sheet).
- **Weekly target, week view, notifications:** target 3 saved, Home showed "0 מתוך 3 אימונים", the week view showed Dana at 33% and "אין דירוג"; four switches stored as `in_app`.
- **Deletion:** the confirmation names the 30 days; the request was recorded, the profile marked deleted, Avi signed out with "בקשת המחיקה התקבלה" (and see finding 2).
- **Contrast:** 46 text measurements in dark Classic and the light palettes, all at or above AA; the lowest was 5.18:1. Nothing was measured over a photo (no step put measured text over an image).

## Findings, ranked by impact

"Measured" is a number from the run; "read" is from the code and not yet driven.

### Blocker

**1. A member who has just signed up cannot create a founder link.** Test 3 step 18; step 19 (the friend) could not start.
- *What happened:* Noa, signed up about ten minutes earlier in the same browser, opened Me, the founder sheet, "יצירת קישור": `create_founder_invite` answered `400 {"code":"P0001","message":"not authorized"}` and the sheet said "אפשר ליצור קישור רק מחשבון עם פרופיל." She has a profile.
- *Probable cause (read, not proven):* the function refuses when the JWT's `is_anonymous` claim is true. Sign-up starts as an anonymous session and upgrades it with `updateUser`, which does not issue a new token, so the access token keeps `is_anonymous: true` until it is refreshed (an hour). `bug_report_submit` (migration 202610290001) makes the same check, so PILOT_CHECKLIST step 15 (a "פנייה" right after sign-up) is at risk too.
- *Expected:* a 7-day, one-use link. *Suggested fix:* refresh the session after the upgrade (`auth.refreshSession()`), or check `auth.users.is_anonymous` / the profile instead of the JWT claim. Not fixed here: it is not proven, and no push was left to test a fix.

**2. A deleted member stays in the circle; a Couple cannot replace them.** Test 3 step 21 (failed in both runs).
- *What happened:* after Avi's deletion, Noa's member list, week view and feed no longer showed him, but the circle header still said "מעגל זוגי · 2 חברים", his `circle_members` row was still there, and nothing told her a member left.
- *Expected:* `docs/circles/decisions.md`: "Account deletion removes all posts and reactions. The circle sees 'a member left'." `request_account_deletion()` (migration 202610260001) marks the profile deleted and soft-deletes posts; it does not touch `circle_members`.
- *Why it matters (read):* `create_circle_invite` refuses with `circle_full` when a couple has 2 membership rows, so the owner cannot invite a new partner for up to 30 days.
- *Suggested fix:* remove the membership, reactions, tags and benchmark results in `request_account_deletion` as `leave_circle` does, and show the "a member left" line.

### Friction

**3. The PR card shows no percent when weights are hidden.** Test 3 step 12. The friends circle's card read "Deadlift PR · תאריך 2026-10-29" and the reactions: no percent and no number. The post in the database does carry the percent (`result_text` `+x%`; step 11 checks it). `renderPrPostCard` draws only `new_result`, `previous_result`, `improvement` and the date. A circle that hides weights therefore sees "a PR" and nothing about it, which is the case the product's privacy rule creates. *Fix:* draw `metadata.improvement_pct` / `result_text` on the card.

**4. Things sit on top of the control a person is about to tap.** Measured by hit-testing the centre of each control before the tap: the share bar ("האימון שותף...", 12 s) covered the save button in 4 steps and the PR-card button in 1; the medal prompt covered the backup question ("כן, לגבות") after the first set and, after the script closed it, the tab bar still did; the account form's "יצירת חשבון" button, the three reactions on a post and "מי התאמן/ה איתי" sat under the tab bar after the smallest scroll that shows them (4, 1 and 1 steps). The script closed the share bar each time (one extra tap); the first run, without that, timed out on five Log taps. *Expected:* a second set takes 2 taps (`scripts/browser-check/log-taps.mjs`); *measured:* a first-ever set of a new lift took 5 taps and 3 typed fields. *Fix:* do not show the share bar over the save button, queue the medal prompt until the person leaves the Log tab, and give scrolled pages the room the tab bar takes.

**5. After sharing a PR from the Log tab nothing confirms it.** Test 1 step 10 (probable). The share worked (request, percent-only row), but "השיא שותף למעגלים" never showed within 8 s. The sentence is `setMessage`, which is drawn only on the circle screens; the person is on the Log tab. *Fix:* show the confirmation as a toast on any screen.

**6. The notification switches say "on" where push cannot work, and the reason is far from them.** Test 1 step 12 (iPhone user agent, browser tab): all four switches turned on as bell-only; the reason ("כדי לקבל התראות דחיפה ב-iPhone/iPad יש קודם להוסיף את האפליקציה למסך הבית...") is the first line of the Me screen, the switches are below appearance, target and sharing. The switch itself is a 20x20 checkbox in a 44 px row. *Fix:* put the reason in the notifications section and label the state "בפעמון בלבד".

**7. After leaving the last circle the person lands on a screen that looks like sign-up.** Test 2 step 14: "שלב 1 מתוך 3 · הזמנה, הדביקו את קישור ההזמנה", plus a first-owner code field, for someone who has an account and a profile. Every database check passed. *Fix:* a screen that says he left and offers "join with a link", without the sign-up progress.

**8. The week view's share button and the member card reach under the screen edge and the tab bar** (run 40933660737, step 11, measured): the button spans y 855 to 899 on an 844 px screen, tab bar at 758. *Fix:* move it above the list.

### Polish

**9. A failed analytics insert on every sign-up.** 2 to 4 `409` responses per sign-up (steps `dana-circle`, `noa-couple`, `avi-joins`, `cleo-refused`, `founder-friend`): `POST /rest/v1/analytics_events` violates `analytics_events_user_id_fkey` ("Key is not present in table profiles"). Events sent before the profile exists are lost and the console shows red. *Fix:* hold analytics until the profile row exists, or drop the foreign key's strictness for pre-profile events.

**10. The sign-up screens retried a refused anonymous sign-in in a tight loop.** Seen only against a stub API that answered 400 (over a hundred `POST /auth/v1/signup` in three seconds), never against the real backend. If Supabase refuses (CAPTCHA, rate limit) that would hammer it. Unconfirmed; worth a look at `ensureAnonymousSession`.

**11. The full-circle message sits inside the "step 1 of 3, paste your invite link" form,** with the first-owner code field under it. Readable (5.4:1 to 5.7:1) but it reads as a form error rather than a dead end.

## Not covered, and why

- Turnstile (CAPTCHA off locally), real push, the share sheet, Add to Home Screen on a phone, the keyboard, a real iOS or Android browser, an installed PWA with the precache.
- The post-workout moment's order (PR, comparison, ring, share): the moment opens, but the assertions did not run (harness mistake 1).
- Rejoining after leaving (Test 2 step 17), the founder link end to end (step 19, blocked by finding 1), and whether the PR card shows weights when a circle does show them.
- The sizes in the light palettes were screenshotted, not all measured.

## Blockers fixed in this session

None. No product code was changed and no migration was added. Findings 1 and 2 stop their steps from finishing; neither was fixed because finding 1's cause is unproven, finding 2 changes the account-deletion function (a migration) and the session was told not to touch product code except to unblock a test, and there is no push left to test either.
