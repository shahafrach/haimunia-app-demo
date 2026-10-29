# User tests, October 2026

Three end-to-end tests of BOX-LOG, run as real people against a real backend, plus a
usability pass. Nothing here touched production: the backend is a throwaway local
Supabase stack on the CI runner, every address is checked to be loopback, and the
browser aborts (and fails the run on) any request that leaves the machine. All three
scripts ended with `isolation: PASS` and no blocked request.

**Read this first.** The numbers below come from CI run 40933660737 (attempt 2, commit
`a2d500b`), the first run in which the tests got past sign-up. **That run was not
finished business: 26 of its 53 steps could not give a verdict because an earlier step in
the same script was blocked by a harness fault or by a missing invite link** (marked
`FAIL (harness)` and `FAIL (not reached)`, never counted as product failures). Two
steps found real product problems (findings 1 and 2). The push after that run fixes the
harness faults; its run is reported in a PR comment, not here, because this file was
written before it finished.

Also true of that run: the job was green although 28 steps had failed, because the
runner shell is plain `bash -e` and a `| tee` pipeline reports `tee`'s status. That is
fixed (`PIPESTATUS`), so a failed step now fails the job.

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

`PASS`, `FAIL (product)`, `FAIL (harness)` (the script was blocked or mistaken), `FAIL (not reached)` (an earlier step left nothing to act on), `PASS (vacuous)` (passed, but the thing it checks was never there). The founder-link steps were added after the first run and so have no run of their own here except where listed.

### Test 1: the owner (Dana)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/01-owner/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Open the bootstrap link | dana | PASS | 4.211 | 0 | 0 | `01-bootstrap-link-dana-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Sign up with a username and password | dana | PASS | 0.73 | 2 | 3 | `02-sign-up-dana-dark-classic.png`, `-light-slate.png` |  |
| 3 | Choose a name and an emoji | dana | PASS | 0.278 | 2 | 1 | `03-name-emoji-dana-dark-classic.png`, `-light-cedar.png` |  |
| 4 | Create a Friends circle | dana | PASS | 2.755 | 2 | 1 | `04-create-circle-dana-dark-classic.png`, `-light-sand.png` |  |
| 5 | Set a weekly target of 3 | dana | PASS | 0.28 | 4 | 0 | `05-weekly-target-dana-dark-classic.png`, `-light-iris.png` |  |
| 6 | Log the first set ever (Back Squat 60 x 5) | dana | FAIL (harness) | 12.703 | 5 | 3 | `06-first-set-dana-dark-classic.png`, `-light-classic.png` | harness: a click on the backup question timed out (something covered it) |
| 7 | Log the same lift twice more | dana | FAIL (harness) | 12.73 | 4 | 4 | `07-baseline-sets-dana-dark-classic.png`, `-light-chalk.png` | harness: the third save click timed out (something covered it) |
| 8 | Log a heavier set so a PR fires | dana | FAIL (not reached) | 0.286 | 2 | 2 | `08-pr-moment-dana-dark-classic.png`, `-light-slate.png` | not reached: only two sets were saved |
| 9 | Render and share the PR card | dana | FAIL (not reached) | 15 | 0 | 0 | `09-pr-card-dana-dark-classic.png`, `-light-cedar.png` | not reached |
| 10 | Share the PR with the circle | dana | FAIL (not reached) | 38.323 | 0 | 0 | `10-pr-share-dana-dark-classic.png`, `-light-sand.png` | not reached |
| 11 | Open the week view | dana | PASS | 0.187 | 2 | 0 | `11-week-view-dana-dark-classic.png`, `-light-iris.png` |  |
| 12 | Turn on all four notification switches | dana | PASS | 0.463 | 6 | 0 | `12-notifications-dana-dark-classic.png`, `-light-classic.png` |  |

### Test 2: the friend (Yoav)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/02-friend/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Dana signs up and creates the circle | dana | PASS | 7.926 | 6 | 5 | `01-dana-circle-dana-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Dana turns on sharing workouts | dana | PASS | 0.267 | 3 | 0 | `02-dana-share-setting-dana-dark-classic.png`, `-light-slate.png` |  |
| 3 | Dana logs a set and it goes to the circle | dana | PASS | 0.763 | 5 | 3 | `03-dana-logs-dana-dark-classic.png`, `-light-cedar.png` |  |
| 4 | Dana creates an invite link | dana | FAIL (harness) | 12.018 | 0 | 0 | `04-dana-invite-dana-dark-classic.png`, `-light-sand.png` | harness: the Circle tab tap timed out after the first log (a medal prompt, inferred) |
| 5 | Yoav opens the link inside WhatsApp | yoav-whatsapp | FAIL (not reached) | 14.339 | 2 | 1 | `05-yoav-whatsapp-yoav-whatsapp-dark-classic.png`, `-light-iris.png` | not reached: no invite (the previous step failed, so the link was "null") |
| 6 | Yoav opens the link in his browser and signs up | yoav | FAIL (not reached) | 29.351 | 3 | 1 | `06-yoav-signup-yoav-dark-classic.png`, `-light-classic.png` | not reached: same |
| 7 | Yoav sees Dana's post | yoav | FAIL (not reached) | 87.559 | 4 | 0 | `07-yoav-feed-yoav-dark-classic.png`, `-light-chalk.png` | not reached: same |
| 8 | Yoav reacts with all three reactions | yoav | FAIL (not reached) | 12.004 | 0 | 0 | `08-yoav-react-yoav-dark-classic.png`, `-light-slate.png` | not reached: same |
| 9 | Dana sees Yoav's reactions | dana | FAIL (not reached) | 0.556 | 2 | 0 | `09-dana-sees-reactions-dana-dark-classic.png`, `-light-cedar.png` | not reached: Yoav never joined |
| 10 | Dana tags Yoav as trained together | dana | FAIL (not reached) | 12.192 | 2 | 0 | `10-dana-tags-dana-dark-classic.png`, `-light-sand.png` | not reached: Yoav never joined |
| 11 | Yoav confirms training together | yoav | FAIL (not reached) | 15.284 | 2 | 0 | `11-yoav-confirms-yoav-dark-classic.png`, `-light-iris.png` | not reached |
| 12 | Yoav shares a workout of his own | yoav | FAIL (not reached) | 12.046 | 1 | 0 | `12-yoav-posts-yoav-dark-classic.png`, `-light-classic.png` | not reached |
| 13 | Dana sees Yoav's post | dana | FAIL (not reached) | 15.828 | 7 | 0 | `13-dana-sees-yoav-dana-dark-classic.png`, `-light-chalk.png` | not reached |
| 14 | Yoav leaves the circle | yoav | FAIL (not reached) | 24.058 | 1 | 0 | `14-yoav-leaves-yoav-dark-classic.png`, `-light-slate.png` | not reached |
| 15 | Dana no longer sees his posts | dana | PASS (vacuous) | 3.064 | 3 | 0 | `15-dana-sees-gone-dana-dark-classic.png`, `-light-cedar.png` | vacuous: Yoav never joined, so nothing was there to disappear |
| 16 | Dana invites Yoav again | dana | PASS | 0.61 | 4 | 0 | `16-dana-reinvites-dana-dark-classic.png`, `-light-sand.png` | invite was made, but Yoav was not in the circle |
| 17 | Yoav rejoins with the new link | yoav | FAIL (not reached) | 12 | 0 | 0 | `17-yoav-rejoins-yoav-dark-classic.png`, `-light-iris.png` | not reached |

### Test 3: privacy and limits (Noa and Avi)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/03-privacy/`) | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | Noa creates a Couple circle | noa | PASS | 8.041 | 7 | 5 | `01-noa-couple-noa-dark-classic.png`, `-light-chalk.png` |  |
| 2 | Noa makes one invite for Avi and keeps a spare | noa | PASS | 1.121 | 6 | 0 | `02-noa-invites-noa-dark-classic.png`, `-light-slate.png` |  |
| 3 | Avi joins with the first invite | avi | PASS | 5.167 | 4 | 4 | `03-avi-joins-avi-dark-classic.png`, `-light-cedar.png` |  |
| 4 | A third person opens the spare invite and is refused | cleo | PASS | 4.47 | 1 | 0 | `04-cleo-refused-cleo-dark-classic.png`, `-light-sand.png` |  |
| 5 | Noa tries to make a third invite | noa | PASS | 15.458 | 4 | 0 | `05-noa-third-invite-noa-dark-classic.png`, `-light-iris.png` |  |
| 6 | Noa creates a second circle | noa | PASS | 1.86 | 3 | 1 | `06-noa-second-circle-noa-dark-classic.png`, `-light-classic.png` |  |
| 7 | Noa sets what each circle gets | noa | PASS | 0.258 | 3 | 0 | `07-noa-settings-noa-dark-classic.png`, `-light-chalk.png` |  |
| 8 | Noa logs four Back Squat sets, the last a PR | noa | FAIL (harness) | 12.689 | 5 | 3 | `08-noa-squat-sets-noa-dark-classic.png`, `-light-slate.png` | harness: a save click timed out (something covered it) |
| 9 | She shares that PR with the couple only | noa | FAIL (not reached) | 38.325 | 0 | 0 | `09-noa-squat-pr-noa-dark-classic.png`, `-light-cedar.png` | not reached |
| 10 | Noa logs four Deadlift sets, the last a PR | noa | FAIL (harness) | 12.779 | 6 | 5 | `10-noa-deadlift-sets-noa-dark-classic.png`, `-light-sand.png` | harness: a save click timed out |
| 11 | She shares that PR with the friends circle only | noa | FAIL (not reached) | 38.34 | 0 | 0 | `11-noa-deadlift-pr-noa-dark-classic.png`, `-light-iris.png` | not reached |
| 12 | Noa looks at the friends circle's feed | noa | FAIL (not reached) | 16.538 | 10 | 0 | `12-noa-friends-feed-noa-dark-classic.png`, `-light-classic.png` | not reached: no PR was shared |
| 13 | Noa looks at the couple's feed | noa | FAIL (not reached) | 16.311 | 10 | 0 | `13-noa-couple-feed-noa-dark-classic.png`, `-light-chalk.png` | not reached: no PR was shared |
| 14 | Avi sees the couple's circle and nothing else | avi | FAIL (not reached) | 15.7 | 7 | 0 | `14-avi-sees-couple-only-avi-dark-classic.png`, `-light-slate.png` | not reached: no PR was shared |
| 15 | Noa logs her body weight | noa | FAIL (not reached) | 6.628 | 4 | 1 | `15-noa-bodyweight-noa-dark-classic.png`, `-light-cedar.png` | not reached: only 2 of 8 lift entries were saved, so the backup check could not mean anything |
| 16 | Avi logs a set with no connection | avi | PASS | 2.462 | 5 | 3 | `16-avi-offline-avi-dark-classic.png`, `-light-sand.png` |  |
| 17 | Noa sees the post that was queued | noa | PASS | 0.109 | 2 | 0 | `17-noa-sees-offline-post-noa-dark-classic.png`, `-light-iris.png` |  |
| 18 | Noa sends a friend a founder link | noa | FAIL (product) | 10.377 | 5 | 0 | `18-founder-send-noa-dark-classic.png`, `-light-classic.png` | PRODUCT: create_founder_invite answered 400; no link was shown (finding 2) |
| 19 | The friend signs up and creates their own circle | dev | FAIL (not reached) | 29.473 | 3 | 1 | `19-founder-friend-dev-dark-classic.png`, `-light-chalk.png` | not reached: no founder link |
| 20 | Avi deletes his account | avi | PASS | 1.891 | 4 | 0 | `20-avi-deletes-avi-dark-classic.png`, `-light-slate.png` |  |
| 21 | Avi disappears from the circle | noa | FAIL (product) | 1.57 | 5 | 0 | `21-noa-sees-avi-gone-noa-dark-classic.png`, `-light-cedar.png` | PRODUCT: his membership row is still in the database and the header still says 2 members (finding 3) |

Founder link (Test 3, steps 18 and 19): driven for the first time in this run; step 18 failed on a product problem (finding 2), step 19 could not start.

## What worked, as measured

- **Sign-up:** bootstrap link to a permanent account in 2 taps and 3 typed fields; no real email is stored (`<name>@members.haimuniya.invalid`); the token is removed from the address bar; the profile (name, emoji) saved; the app then opened the create-circle sheet by itself (4 steps from the link to a circle for Dana: 0 + 2 + 2 + 2 taps).
- **Circles:** a Friends circle and a Couple circle were created; the empty feed says what will appear there instead of showing nothing; Noa held two circles and the member lists did not mix (Avi absent from the second).
- **The Couple limit:** a spare invite opened by a third person (Cleo) gave "המעגל הזה מלא ואין בו מקום לעוד חברים" and no membership row; Noa's third invite was refused with "המעגל מלא, אי אפשר להזמין עוד חברים" (the refusal shows up as an HTTP 400 in the console).
- **Weekly target and week view:** target 3 saved, Home showed "0 מתוך 3 אימונים", the week view showed Dana at 33% after one workout day and "אין דירוג".
- **Notifications:** four switches, all stored as `in_app` (rows in `notification_preferences`).
- **Offline:** Avi logged a set offline, the bar said it would be sent when the connection returns, nothing reached the server, and the post arrived 492 ms after the connection came back.
- **Deletion:** the confirmation names the 30 days; the request was recorded, the profile marked deleted, Avi was signed out with "בקשת המחיקה התקבלה".
- **Contrast:** 38 text measurements in dark Classic and the light palettes, all at or above AA; the lowest was 5.16:1 (light Sand, "מי התאמן/ה איתכם?"). Text over a photo was not measured: the screens that put text over an image (post-workout moment, scene headers) were not reached or not selected.

## Findings, ranked by impact

Confidence is stated because several steps were not reached. "Measured" means a number from this run; "read" means from the code, not yet driven.

### Blocker

**1. A deleted member stays in the circle; a Couple cannot replace them.** Step 21 (Test 3, `noa-sees-avi-gone`).
- *What happened:* after Avi's account deletion Noa reloaded: the member list, the week view and the feed no longer showed Avi, but the circle header still said "מעגל זוגי · 2 חברים", his `circle_members` row was still in the database (count 1), and nothing said that a member left.
- *Expected:* `docs/circles/decisions.md`: "Account deletion removes all posts and reactions. The circle sees 'a member left'." `request_account_deletion()` (migration 202610260001) marks the profile deleted and soft-deletes his posts; it does not touch `circle_members`.
- *Why it matters (read, not yet driven):* `create_circle_invite` refuses with `circle_full` when `count(circle_members) >= 2` for a couple, so the owner of a Couple cannot invite a new partner until the purge removes the row, up to 30 days.
- *Suggested fix:* remove the membership (and reactions, tags, benchmark results) in `request_account_deletion`, as `leave_circle` does, and post the "a member left" line the decisions file promises.

**2. The founder link cannot be created.** Step 18 (Test 3, `founder-send`).
- *What happened:* Noa (a permanent account with a profile) opened Me, the founder sheet, "יצירת קישור"; `create_founder_invite` answered HTTP 400 and no link appeared. The sheet's own error text was not captured in this run. Step 19 (the friend) could not start.
- *Expected:* a 7-day, one-use link.
- *Cause:* unknown. The push that follows records the response body and the sheet's error text for this call. It is not fixed here: there is no evidence yet to fix on, and the pgTAP test for the function passes in CI.
- *Suggested next step:* read the `founder-send` note in the next run's log.

### Friction

**3. Dialogs cover the controls a person is about to tap while logging.** Steps 6 and 7 (Test 1), 4 (Test 2), 8 and 10 (Test 3): in all five a tap on a Log-tab control or the Circle tab timed out after 12 s. Notes in two of them read "Closed on the way: medal-prompt": a medal prompt (and, after the first set, the "first entry saved" card and the backup question) arrives between saves. *Confidence: medium.* The cause was inferred from those notes; the harness did not record what was on top. It does now (`covered by ...` per step), so the next run names it. *Expected:* a second set takes 2 taps (`scripts/browser-check/log-taps.mjs` budget); *measured:* a first-ever set of a new lift (Avi, offline step) took 5 taps and 3 typed fields. *Suggested fix:* hold the medal prompt until the person leaves the Log tab or taps the save button's confirmation away; keep the share bar off the save button.

**4. The week view's share button and part of the member card sit under the screen edge or the tab bar.** Step 11 (Test 1): `[data-week-card="ready"]` top 855, bottom 899 on an 844 px screen (tab bar at 758); the member card spans 673 to 815. Measured. *Expected:* the week card, the point of the screen on Saturday night, reachable without scrolling for a one-person circle. *Fix:* put the share button above the list, or make it part of the header.

**5. The notification switches say "on" where push cannot work, and the reason is far from them.** Step 12 (Test 1, iPhone in a browser tab): all four switches turned on and were stored as bell-only; the explanation ("כדי לקבל התראות דחיפה ב-iPhone/iPad יש קודם להוסיף את האפליקציה למסך הבית...") is the first line of the Me screen, the switches are below appearance, target and sharing. The switch is a 20x20 checkbox inside a 44 px row. *Fix:* put the reason inside the notifications section and label the state ("בפעמון בלבד").

**6. Primary buttons of the first screens need a scroll.** "המשך" (profile form, Test 1 step 3) and "יצירת חשבון" (account form, the sign-up steps of Tests 2 and 3) were below the tab bar's top edge at 844 px and needed scrolling to tap. *Confidence: medium* (the measure treated page content only; sheets and fixed bars are now excluded). *Fix:* shorten the emoji grid or pin the button.

### Polish

**7. Console errors on every sign-up.** 3 to 4 "409 (Conflict)" responses per sign-up (steps `dana-circle`, `noa-couple`, `avi-joins`, `cleo-refused`), unidentified in this run. The new harness records method, path and body of every 4xx/5xx. Harmless to the person so far.

**8. The sign-up screens retried a refused anonymous sign-in in a tight loop.** Seen only against a stub API that answered 400 (over a hundred `POST /auth/v1/signup` in three seconds), not against the real backend. If Supabase ever refuses (CAPTCHA, rate limit) that would hammer it. *Unconfirmed;* worth a look at `ensureAnonymousSession`.

**9. The full-circle message sits inside the "step 1 of 3, paste your invite link" form,** with the first-owner code field below it. Readable (5.4:1 to 5.7:1), but it reads as a form error rather than a dead end.

## Not covered, and why

- Turnstile (CAPTCHA off locally).
- Real push, the share sheet, Add to Home Screen on a phone, the keyboard, a real iOS or Android browser.
- Steps marked `not reached`: the PR moment, PR card, PR share (with and without weights), the friend's reactions, tag and confirm, leave and rejoin, circle isolation by PR card, body weight on the wire. Their assertions are written; they have no verdict from this run.
- Whether the PR card in the feed shows the percent when weights are hidden. From the code, `renderPrPostCard` draws only `new_result`, `previous_result`, `improvement` and the date, while a no-weights PR stores only `result_text` and `metadata.improvement_pct`; Test 3 step 12 asserts the percent is on the card. Not yet run.
- Founder link end to end (step 19).

## Blockers fixed in this session

None. No product code was changed and no migration was added.
