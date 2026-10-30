# User tests, October 2026

Three end-to-end tests of BOX-LOG, run as real people against a real backend, plus a
usability pass, and the repairs they led to. Nothing here touched production: the backend is
a throwaway local Supabase stack on the CI runner, every address is checked to be loopback,
and the browser aborts (and fails the run on) any request that leaves the machine.

**Result: 53 of 53 steps pass** (CI run 40949591156, commit `1c44c8f`; Test 1 13/13, Test 2
18/18, Test 3 22/22, each counting its isolation check). The same commit is green in
node-tests (1475 tests, also 1475 pass locally), migration-check (pgTAP, 47 files including the new
`0146_signup_claim_and_deletion_leaves_circles_test.sql`) and browser-checks (including the new
`overlays-never-cover.mjs`).

## Before and after

| | Before the repairs | After |
|---|---|---|
| e2e steps passing | 25 of 53 (run 40933660737, first run past sign-up), 43 of 53 (run 40937913305), then 48 of 53 once the script mistakes were fixed (run 40943550735, commit `2659196`, no product change) | **53 of 53** |
| The 5 product failures of the 48-of-53 run | founder link 400 "not authorized" and the friend step behind it; PR card with no percent; no confirmation after sharing a PR on the Log tab; deleted member still in the circle ("2 חברים", row in `circle_members`) | all pass |
| Save button covered by the share bar | covered in 5 steps (a tap on it timed out 12 s in the first run); share bar ended at y=752 over a save button starting at y=691 | no step's save button is covered; browser-check: bar ends at y=673, 18 px above the button |
| Medal prompt over the backup question | the medal opened over "כן, לגבות" (hit-test: covered by `achUnlock`) | the medal waits; opens after the answer |
| Account button vs tab bar | after the browser's own scroll the button ended at y=815, under the bars that start at y=758 | ends at y=644, above them |
| Console: the red 409s | 2 to 4 per sign-up | unchanged (finding 9, not in scope) |

"Before" for the three overlay rows is also reproduced: with the product changes stashed,
`overlays-never-cover.mjs` failed 11 of the 15 checks it had then (the share-confirmation scenario was added after); with them all 18 checks pass.

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

All 53 pass. `E2E_STEP` lines in the job log carry each step's measured facts; the screenshots are in the `e2e-user-tests` artifact (`artifacts/<test>/NN-step-person-dark-classic.png` and `-light-<palette>.png`).

### Test 1: the owner (Dana)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/01-owner/`) |
|---|---|---|---|---|---|---|---|
| 1 | Open the bootstrap link | dana | PASS | 4.238 | 0 | 0 | `01-bootstrap-link-dana-dark-classic.png`, `-light-chalk.png` |
| 2 | Sign up with a username and password | dana | PASS | 1.038 | 2 | 3 | `02-sign-up-dana-dark-classic.png`, `-light-slate.png` |
| 3 | Choose a name and an emoji | dana | PASS | 0.309 | 2 | 1 | `03-name-emoji-dana-dark-classic.png`, `-light-cedar.png` |
| 4 | Create a Friends circle | dana | PASS | 2.821 | 2 | 1 | `04-create-circle-dana-dark-classic.png`, `-light-sand.png` |
| 5 | Set a weekly target of 3 | dana | PASS | 0.358 | 4 | 0 | `05-weekly-target-dana-dark-classic.png`, `-light-iris.png` |
| 6 | Log the first set ever (Back Squat 60 x 5) | dana | PASS | 1.269 | 6 | 3 | `06-first-set-dana-dark-classic.png`, `-light-classic.png` |
| 7 | Log the same lift twice more | dana | PASS | 3.954 | 5 | 4 | `07-baseline-sets-dana-dark-classic.png`, `-light-chalk.png` |
| 8 | Log a heavier set so a PR fires | dana | PASS | 1.238 | 2 | 2 | `08-pr-moment-dana-dark-classic.png`, `-light-slate.png` |
| 9 | Render and share the PR card | dana | PASS | 0.214 | 1 | 0 | `09-pr-card-dana-dark-classic.png`, `-light-cedar.png` |
| 10 | Share the PR with the circle | dana | PASS | 0.263 | 1 | 0 | `10-pr-share-dana-dark-classic.png`, `-light-sand.png` |
| 11 | Open the week view | dana | PASS | 0.234 | 2 | 0 | `11-week-view-dana-dark-classic.png`, `-light-iris.png` |
| 12 | Turn on all four notification switches | dana | PASS | 0.656 | 6 | 0 | `12-notifications-dana-dark-classic.png`, `-light-classic.png` |
| 13 | Nothing left the machine | all | PASS | | | | - |

### Test 2: the friend (Yoav)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/02-friend/`) |
|---|---|---|---|---|---|---|---|
| 1 | Dana signs up and creates the circle | dana | PASS | 7.999 | 6 | 5 | `01-dana-circle-dana-dark-classic.png`, `-light-chalk.png` |
| 2 | Dana turns on sharing workouts | dana | PASS | 0.347 | 3 | 0 | `02-dana-share-setting-dana-dark-classic.png`, `-light-slate.png` |
| 3 | Dana logs a set and it goes to the circle | dana | PASS | 1.262 | 5 | 3 | `03-dana-logs-dana-dark-classic.png`, `-light-cedar.png` |
| 4 | Dana creates an invite link | dana | PASS | 0.773 | 4 | 0 | `04-dana-invite-dana-dark-classic.png`, `-light-sand.png` |
| 5 | Yoav opens the link inside WhatsApp | yoav-whatsapp | PASS | 4.281 | 0 | 0 | `05-yoav-whatsapp-yoav-whatsapp-dark-classic.png`, `-light-iris.png` |
| 6 | Yoav opens the link in his browser and signs up | yoav | PASS | 5.227 | 4 | 4 | `06-yoav-signup-yoav-dark-classic.png`, `-light-classic.png` |
| 7 | Yoav sees Dana's post | yoav | PASS | 0.16 | 2 | 0 | `07-yoav-feed-yoav-dark-classic.png`, `-light-chalk.png` |
| 8 | Yoav reacts with all three reactions | yoav | PASS | 0.362 | 3 | 0 | `08-yoav-react-yoav-dark-classic.png`, `-light-slate.png` |
| 9 | Dana sees Yoav's reactions | dana | PASS | 0.553 | 2 | 0 | `09-dana-sees-reactions-dana-dark-classic.png`, `-light-cedar.png` |
| 10 | Dana tags Yoav as trained together | dana | PASS | 0.373 | 4 | 0 | `10-dana-tags-dana-dark-classic.png`, `-light-sand.png` |
| 11 | Yoav confirms training together | yoav | PASS | 5.554 | 3 | 0 | `11-yoav-confirms-yoav-dark-classic.png`, `-light-iris.png` |
| 12 | Yoav shares a workout of his own | yoav | PASS | 2.186 | 7 | 3 | `12-yoav-posts-yoav-dark-classic.png`, `-light-classic.png` |
| 13 | Dana sees Yoav's post | dana | PASS | 7.918 | 7 | 0 | `13-dana-sees-yoav-dana-dark-classic.png`, `-light-chalk.png` |
| 14 | Yoav leaves the circle | yoav | PASS | 0.828 | 4 | 0 | `14-yoav-leaves-yoav-dark-classic.png`, `-light-slate.png` |
| 15 | Dana no longer sees his posts | dana | PASS | 3.041 | 3 | 0 | `15-dana-sees-gone-dana-dark-classic.png`, `-light-cedar.png` |
| 16 | Dana invites Yoav again | dana | PASS | 0.705 | 4 | 0 | `16-dana-reinvites-dana-dark-classic.png`, `-light-sand.png` |
| 17 | Yoav rejoins with the new link | yoav | PASS | 0.383 | 3 | 1 | `17-yoav-rejoins-yoav-dark-classic.png`, `-light-iris.png` |
| 18 | Nothing left the machine | all | PASS | | | | - |

### Test 3: privacy and limits (Noa and Avi)

| # | Step | Person | Result | s | taps | typed | Screenshots (`artifacts/03-privacy/`) |
|---|---|---|---|---|---|---|---|
| 1 | Noa creates a Couple circle | noa | PASS | 8.139 | 7 | 5 | `01-noa-couple-noa-dark-classic.png`, `-light-chalk.png` |
| 2 | Noa makes one invite for Avi and keeps a spare | noa | PASS | 1.301 | 6 | 0 | `02-noa-invites-noa-dark-classic.png`, `-light-slate.png` |
| 3 | Avi joins with the first invite | avi | PASS | 5.26 | 4 | 4 | `03-avi-joins-avi-dark-classic.png`, `-light-cedar.png` |
| 4 | A third person opens the spare invite and is refused | cleo | PASS | 4.444 | 1 | 0 | `04-cleo-refused-cleo-dark-classic.png`, `-light-sand.png` |
| 5 | Noa tries to make a third invite | noa | PASS | 15.586 | 4 | 0 | `05-noa-third-invite-noa-dark-classic.png`, `-light-iris.png` |
| 6 | Noa creates a second circle | noa | PASS | 1.948 | 3 | 1 | `06-noa-second-circle-noa-dark-classic.png`, `-light-classic.png` |
| 7 | Noa sets what each circle gets | noa | PASS | 0.37 | 3 | 0 | `07-noa-settings-noa-dark-classic.png`, `-light-chalk.png` |
| 8 | Noa logs four Back Squat sets, the last a PR | noa | PASS | 5.913 | 13 | 9 | `08-noa-squat-sets-noa-dark-classic.png`, `-light-slate.png` |
| 9 | She shares that PR with the couple only | noa | PASS | 0.415 | 3 | 0 | `09-noa-squat-pr-noa-dark-classic.png`, `-light-cedar.png` |
| 10 | Noa logs four Deadlift sets, the last a PR | noa | PASS | 6.145 | 10 | 9 | `10-noa-deadlift-sets-noa-dark-classic.png`, `-light-sand.png` |
| 11 | She shares that PR with the friends circle only | noa | PASS | 0.461 | 3 | 0 | `11-noa-deadlift-pr-noa-dark-classic.png`, `-light-iris.png` |
| 12 | Noa looks at the friends circle's feed | noa | PASS | 0.999 | 5 | 0 | `12-noa-friends-feed-noa-dark-classic.png`, `-light-classic.png` |
| 13 | Noa looks at the couple's feed | noa | PASS | 0.824 | 5 | 0 | `13-noa-couple-feed-noa-dark-classic.png`, `-light-chalk.png` |
| 14 | Avi sees the couple's circle and nothing else | avi | PASS | 7.832 | 7 | 0 | `14-avi-sees-couple-only-avi-dark-classic.png`, `-light-slate.png` |
| 15 | Noa logs her body weight | noa | PASS | 6.861 | 4 | 1 | `15-noa-bodyweight-noa-dark-classic.png`, `-light-cedar.png` |
| 16 | Avi logs a set with no connection | avi | PASS | 4.008 | 5 | 3 | `16-avi-offline-avi-dark-classic.png`, `-light-sand.png` |
| 17 | Noa sees the post that was queued | noa | PASS | 0.178 | 2 | 0 | `17-noa-sees-offline-post-noa-dark-classic.png`, `-light-iris.png` |
| 18 | Noa sends a friend a founder link | noa | PASS | 0.499 | 5 | 0 | `18-founder-send-noa-dark-classic.png`, `-light-classic.png` |
| 19 | The friend signs up and creates their own circle | dev | PASS | 5.476 | 5 | 5 | `19-founder-friend-dev-dark-classic.png`, `-light-chalk.png` |
| 20 | Avi deletes his account | avi | PASS | 0.781 | 4 | 0 | `20-avi-deletes-avi-dark-classic.png`, `-light-slate.png` |
| 21 | Avi disappears from the circle | noa | PASS | 1.906 | 7 | 0 | `21-noa-sees-avi-gone-noa-dark-classic.png`, `-light-cedar.png` |
| 22 | Nothing left the machine | all | PASS | | | | - |

## What the tests proved

- **Sign-up:** link to a permanent account in 2 taps and 3 typed fields; no real email is stored; the token leaves the address bar; the access token's `is_anonymous` claim reads `false` 305 ms after the profile form appears (finding 1, after the repair).
- **Friend's path:** the WhatsApp browser shows three numbered steps and creates no account; in a normal browser Yoav signed up and landed as a member, saw Dana's post (no kilograms), reacted with all three kinds, was tagged and confirmed, posted, left (membership, posts, reactions and tag gone) and rejoined with a new link.
- **Privacy:** a PR shared with weights hidden sends no `p_weight`, the stored post carries only `+x%`; body weight never appears in any request (118 inspected) while all 8 lift entries were backed up; Noa's two circles do not leak into each other (each asked for its own feed; the couple's holds no Deadlift, the friends circle no Back Squat); Avi saw only the couple's PR.
- **Limits:** a third person opening a spare Couple invite got "המעגל הזה מלא..." and no membership; a third invite was refused.
- **Offline:** the post queued and reached the server 0.5 s after the connection came back.
- **Founder link:** a signed-up member made a link; the friend signed up from it, landed on the create-circle sheet, made their own circle, joined none of Noa's, and Noa gained none.
- **Contrast:** 48 text measurements in dark Classic and the light palettes, all at or above AA; the lowest was 5.18:1. Nothing was measured over a photo.

## The five findings and their repairs

**1. A member who has just signed up was refused by the founder link and the פנייה.** Fixed.
- *Cause, proven three ways.* (a) The failing call: `create_founder_invite` answered `400 {"code":"P0001","message":"not authorized"}` for Noa, who had signed up minutes before and had a profile; the function's only other refusals are an anonymous caller and a missing profile. (b) The mechanism, in the vendored client: `_updateUser` does `o.user = l.user; _saveSession(o)` and passes `o.access_token` through untouched, so the token issued at the anonymous sign-in, whose `is_anonymous` claim is true, stays the session's token until it is refreshed (jwt_expiry 3600). (c) The database: both functions tested `coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)`, and `auth.users.is_anonymous` is already false after the upgrade (the e2e sign-up step reads it). pgTAP `0146` pins the case: a token that still says anonymous for a row that says permanent now succeeds, and the reverse is refused.
- *Repair:* migration `202610290003_signup_claim_and_deletion_leaves_circles.sql` makes both functions ask `auth.users.is_anonymous`; the client calls `refreshSession()` right after `updateUser` (`src/community/auth.js`, `setCredentials`) and the e2e sign-up step asserts the stored token now says `is_anonymous: false`.
- *Every place that checks `is_anonymous`:* server, the claim: **`create_founder_invite`** (202610290002) and **`bug_report_submit`** (202610290001), the only two, both repaired. Server, the row (`auth.users.is_anonymous`, not affected): `purge_abandoned_profiles` (202609010004, 202609070001, and the edge function), the incomplete-sign-up views and `invite_reclaim` (202609060023), the tie-break list (202609160002), and the abandoned-account purge in 202610250004. Client (`state.user.is_anonymous`, read from the session user the upgrade already updates): `cloud.js` lines 1952, 1964, 2076, 2086, `src/community/circles-ui.js` (the gate and `meLinkHtml`), `src/community/auth.js` (`verifyRecovery`, the recovery gate).

**2. Account deletion left the member in their circles.** Fixed. `request_account_deletion()` now deletes the member's `circle_members` rows first; the existing `circle_members_after_delete` trigger does `leave_circle`'s cleanup (posts, reactions, tags, benchmark results, ownership to the longest-standing member, a circle whose last member this was is deleted). The circle's count and a Couple's seat free up at once. Same migration; pgTAP `0146` covers a friends circle (ownership handoff), a couple (the remaining partner can invite again; before it was `circle_full`) and a circle the member was alone in (deleted); `0064` now expects the member's posts gone, not soft-deleted, and `0126` (an anonymous backup account with no profile can still call it) still passes. e2e step 21: the header reads "חבר/ה אחד" and the row is gone. *Not added:* the "a member left" line `decisions.md` mentions: the count shrinking is the only trace; say if you want a message.

**3. The PR card with weights hidden showed no percent.** Fixed. `renderPrPostCard` shows `metadata.improvement_pct` (or a `+x%` `result_text`) as "שיפור", and no kilograms row unless the member chose to show weights. e2e step 12 (Test 3): "Deadlift PR · שיפור +7.1% · תאריך 2026-10-29". `test/user-test-findings.test.mjs` pins both cases.

**4. Things covered the control under a thumb.** Fixed, and measured.
- The share bar and the status toast ([data-dock]) now sit on top of whatever is docked at the bottom (tab bar, save bar, install dock), using the height `app.js` writes to `--bottom-wrap-h` (ResizeObserver), instead of a fixed offset that overlapped the save bar.
- The medal prompt waits behind the backup question: `offerSharePrompt` parks a medal while `window.haimuniaBackupQuestionOwed()` is true and `setBackupConsent` announces the answer. The PR prompt is not parked.
- `html{scroll-padding-bottom:var(--bottom-nav-reserve)}`: a control the browser scrolls into view (a focused field, a keyboard tab) lands above the bars.
- `scripts/browser-check/overlays-never-cover.mjs` (18 checks, real Chromium, 390x844): for each of the save button, the backup question's two buttons, the medal prompt's buttons, the account button and the share confirmation, it scrolls the way a browser does, asks which element is under the control's centre, and presses there with the mouse.
- In the final e2e run no tap found its target covered by another overlay. Four steps still log a "covered" hit; all are the detector's own limit: a checkbox under its label's text (the label is the tap target), and an emoji chip under its sheet.

**5. No confirmation after sharing a PR (or a medal) from the Log tab.** Fixed. The sentence is now also shown with `showToast` plus a `render()` (the toast paints on the next render of the screen that is up) in `sharePrPrompt` and `shareAchievementUnlock`. Browser-check scenario 4 reads it in the toast dock on the Log tab; e2e step 10 reads it in the page.

## Left as found (not asked for)

- **Notification switches say "on" where push cannot work** (iPhone browser tab): the reason is the first line of Me, far from the switches. Friction.
- **After leaving the last circle** a member lands on a "step 1 of 3, paste an invite link" screen with sign-up progress. Friction.
- **The week view's share button** is below the first screen on a one-person circle. Friction.
- **A failed analytics insert on every sign-up:** `POST /rest/v1/analytics_events` answers 409 (`analytics_events_user_id_fkey`, "Key is not present in table profiles"), 22 times across the run: events sent before the profile exists are lost and the console shows red. Polish.
- **The sign-up screens retried a refused anonymous sign-in in a tight loop** (over a hundred requests in three seconds), seen only against a stub API that answered 400. Unconfirmed against the real backend.
- **The full-circle message** sits inside the "paste your invite link" form. Polish.

## Not covered, and why

- Turnstile (CAPTCHA off locally), real push, the share sheet, Add to Home Screen on a phone, the keyboard, a real iOS or Android browser, an installed PWA with the precache.
- Text over a photo was not measured.
- The server-side claim repair is proven by the failing call, the client code and pgTAP; it was not re-run against the old function in CI (the old function is gone).

## Blockers fixed in this session

Findings 1 and 2 stopped their steps from finishing; both are fixed, each with a regression test: pgTAP `0146` (and `0144`, `0064` updated) for the database halves, `test/user-test-findings.test.mjs` for the client halves, `overlays-never-cover.mjs` for the overlays, and the e2e steps themselves. One forward migration was added (`202610290003`); no applied migration was edited.
