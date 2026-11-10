# BOX-LOG fix plan (from the 2026-11 audit)

Written 2026-11-10 against `main` at `72feb0a`. Plan only: no code has changed.
Every item was checked again in the current code and against
[`circles/decisions.md`](circles/decisions.md). Line numbers are from that commit.

## 0. What was measured, and what was not

- **Contrast, now measured.** axe-core 4.14.0 was already declared in
  `scripts/browser-check/package.json` and its lockfile; it was simply not
  installed. It is now installed locally (`node_modules` is gitignored, so there
  is no file change to commit). Run once each:
  - `a11y-axe-scan.mjs`: **6 pass, 0 fail.** Add, History, Calendar, WOD,
    Community/Account: no serious or critical WCAG violation; no console errors.
  - `a11y-screens-palettes.mjs`: **62 pass, 0 fail.** Gate, login, forgot
    password, Me (three states), two-step gate and recovery, Progress, at 320px:
    44px targets, axe, text contrast in 6 palettes x light/dark, no sideways
    scroll, focus order, reduced motion.
  - **No new contrast items.** Note the gap: neither scenario opens the welcome
    sheet, the notification centre, Home, Settings or the circle feed, so M1
    (white subtitle on a light sheet) is confirmed by reading the CSS, not by
    measurement. F6 and F13 extend the palette scenario to cover those screens.
- **Not run:** `supabase test db` (needs Docker), `check:drift` (needs a linked
  project), the full `npm test` and browser suite (not part of a plan session),
  anything against the live Supabase project. Edge functions and
  `functions/_middleware.js` were read, not executed.
- **One item needs a migration: F19**, so **Phase 1 is a migration gate.** The
  merge to `main` also deploys the edge functions to production
  (`deploy-edge-functions.yml`). Check open PRs for another branch adding a
  migration before Phase 1 writes its own.

## 1. Verification result

23 audit items, all confirmed. Merged into **18 items** (F1-F18); F19 added on request.

| Audit | Result | Item |
|---|---|---|
| H1 | confirmed | F1 |
| M1, M2 | confirmed (same screen, same rules) | F6 |
| M3 | confirmed, plus a twin: the header flame `updateStreakLabel` (app.js:5577) | F11 |
| M4, M5, L9 | confirmed (one form, one rule file) | F5 |
| M6, M7 | confirmed (Me has no nav entry; both come from two settings screens) | F12 |
| M8 | confirmed; the audit measured all four inputs ("1,250.5", "abc", "-5", Arabic-Indic) becoming 20 in the browser. The code shows the "1,250.5" and "-5" path; for "abc" the measurement stands over the reading | F2 |
| M9 | confirmed | F7 |
| M10, L1 | confirmed (static pages) | F8 |
| L2 | confirmed, plus 3 twins in app.js | F9 |
| L3 | confirmed | F10 |
| L4 | confirmed in code structure (flex rows, no columns); geometry not measured | F14 |
| L5, L6 | confirmed. L6 is about what the icons mean on screen: every header button has an `aria-label` (sparkle = `עדכוני גרסה`), but there is no visible label | F13 |
| L7 | confirmed (product choice) | F15 |
| L8 | confirmed | F3 |
| L10 | confirmed in code (WHATWG `URL` keeps `%64` encoded); whether Cloudflare then serves the decoded file is not measured | F4 |
| L11 | confirmed: 38 `<script>` tags, 1.5 MB raw on disk for the JS, HTML and CSS | F17 |
| L12 | confirmed | F16 |
| L13 | confirmed, plus a twin: the static `theme-color` metas (index.html:92-93) | F18 |

**Dropped:** none.

**Already fixed:** none.

## 2. Items

Legend: **Mig** needs a migration. **Sec** touches RLS, auth or edge functions.

### F1 · High · works · Offline: the Circle tab tells a signed-in member to create a Supabase project
- **Root cause:** `sw.js:276` answers a failed `cloud-config.js` fetch with an
  empty config, and `circles-ui.js:76` reads "no config" as "never set up".
- **Files:** `sw.js`, `src/community/circles-ui.js`.
- **Fix:** keep the fetch network-first and `no-store`, but on success put the
  response in a small cache and, on failure, serve that last good copy (empty
  only if none was ever cached). In `circles-ui.js` split "not configured" from
  "offline": offline shows "אין חיבור כרגע. היומן הפרטי עובד, והמעגל יתעדכן
  כשהחיבור יחזור." The developer copy (COMMUNITY_SETUP.md) never reaches a member.
- **Twins:** `cloud.js:57`, `auth.js:466`, `notifications.js:271` all read the
  same global; fixed at the source, nothing to change in them.
- Mig no · Sec no · Risk **med** (service worker; a wrong cache serves a stale
  project URL; the `sw.js:274` comment is the reason it is network-first).
- **Verify:** a unit test in the existing sw test file for "fetch fails, cached
  config returned"; extend `scripts/browser-check/circles-client.mjs` with an
  offline pass (context `setOffline(true)` after one online load) asserting the
  offline state and no setup text. Do not add a new file to `scripts/browser-check/`.
- **Manual:** on the phone, open the installed app once online, then airplane
  mode, reopen, open the Circle tab.

### F2 · Medium · works · Bad weight input silently becomes 20
- **Root cause:** the stepper input handler (`app.js:8692`) does
  `replace(",", ".")` then `parseFloat`, so "1,250.5" becomes 1.25 and the
  focusout clamp (`app.js:8738`) lifts it to the minimum; nothing marks the field.
- **Files:** `src/format.js` (one `parseLocaleNumber`), `app.js:8692-8745`.
- **Fix:** one parser: Arabic-Indic and Persian digits to ASCII, a comma
  followed by exactly three digits is a thousands separator, otherwise a comma is
  the decimal point. Unparseable or below the minimum: restore the last valid
  value, set `aria-invalid`, show a one-line message; never clamp silently.
- **Twins:** the handler is delegated, so every `.stepper-val` (`step`,
  `wod-step`, `bw-step`, `measure-step`, the EMOM and time-cap fields) gets it.
  Grep `parseFloat(` over `src/community/*.js` for the weekly target input and
  route it through the same parser.
- Mig no · Sec no · Risk **med** (every logging field).
- **Verify:** new `test/stepper-input-parse.test.mjs` (the four audit inputs plus
  "62,5", "1,250", "٢٠"); run `test/absurd-weight-first-set.test.mjs`; browser
  `log-taps.mjs`.

### F3 · Low · security · Five junk requests lock a username's recovery
- **Root cause:** `handleRecover` (`_shared/recovery.mjs:116-121`) counts the
  username attempt before checking that the request is even well formed.
- **Files:** `supabase/functions/_shared/recovery.mjs`, `test/recovery-edge-functions.test.mjs`.
- **Fix:** compute `shapeOk` first; always count the IP key; count the username
  key only when the username, code and password are all well formed. Same answer
  and same timing for every failure.
- **Residual, stated:** someone sending well-formed junk codes can still lock a
  username for 15 minutes; the code is 80 bits, so this is a nuisance, not a
  guessing risk. Keying on (username, IP) would close it but changes the
  "per username hash and per IP hash" line in decisions.md, so it is not planned.
- **Twin left:** `_shared/mfa-recovery.mjs:34` keys on the signed-in `user.id`,
  which a stranger cannot hold.
- Mig no · Sec **yes** (edge function) · Risk low.
- **Verify:** add "5 malformed requests, then a valid code still succeeds" to the
  recovery test file.
- **Manual:** after merge, check the `deploy-edge-functions` run in Actions went
  green.

### F4 · Low · security · Encoded paths may pass the deploy block list
- **Root cause:** `isBlocked` (`functions/_middleware.js:69`) lowercases the raw
  pathname and never decodes it.
- **Files:** `functions/_middleware.js`, `test/public-surface.test.mjs`.
- **Fix:** `decodeURIComponent` inside try (a malformed escape is a 404), collapse
  repeated slashes, then match.
- Mig no · Sec **yes** (deploy middleware) · Risk low.
- **Verify:** test cases `/%64ocs/x`, `//docs/x`, `/DOCS/x`, `/docs%2fx`, `/%E0%A4%A`.
- **Manual:** after the Pages deploy, `curl -I https://box-log.pages.dev/%64ocs/journal.md` returns 404.

### F5 · Medium · feels · Login copy and validation (M4, M5, L9)
- **Root cause:** `login()` (`auth.js:661-686`) has its own looser rules: it
  accepts an email, and a bad username gets only "שם הכניסה לא תקין" while sign-up
  uses `usernameRuleError`. `passwordRuleError` (`auth.js:359`) has no upper
  bound while the server's `passwordOk` caps at 72.
- **Files:** `src/community/auth.js`.
- **Fix:** login uses `usernameRuleError` for the message (a-z, 0-9, _, 3-24
  characters); `passwordRuleError` adds "עד 72 תווים", which `recovery.js:86`
  picks up because it calls the same function. M4 below decides the label.
- **Lost-code path (added 2026-11-10):** the forgot-password screen
  (`recovery.js:165`) never says what to do without a code, and the sign-up
  screen (`recovery.js:182`) says the code is "the only way" back, which is not
  true: the owner can issue a one-hour reset code (`owner_issue_reset_code`,
  [ops/PASSWORD_RESET.md](ops/PASSWORD_RESET.md)). Add one line under the
  forgot form, "אין קוד? כתבו למי שמפעיל את BOX-LOG, והוא ישלח לכם קוד איפוס
  חד-פעמי.", and correct the sign-up line to say that. No phone number or name
  in the file.
- **Files (add):** `src/community/recovery.js`.
- **Decided 2026-11-10: remove email from login.** Delete the email branch in
  `login()` (`auth.js:666-690`) and the label becomes "שם כניסה" (`auth.js:336`);
  the empty-field message (`auth.js:684`) loses "או אימייל". Grep `אימייל` and
  `looksLikeEmail` across `src/community/` for any other copy or path. F19 is the
  recovery for a lost code, so nobody needs email.
- Mig no · Sec **yes** (auth) · Risk low.
- **Verify:** `test/community-username-password-auth.test.mjs`,
  `test/password-recovery-client.test.mjs`; browser `a11y-screens-palettes.mjs` (login).
- **Manual:** Supabase dashboard, Authentication, Users: sort by email, check
  that every address ends in `@members.haimuniya.invalid`.

### F19 · High · works · Lost recovery code: self-service reset (added and decided 2026-11-10)
- **Why:** today a member with no code must message the app owner, who runs
  `owner_issue_reset_code` in the SQL editor. Decided: a button, nobody in the
  middle, no friend approval.
- **Risk you accepted (stated so the build session does not reopen it):** with
  no email, phone, code or approval, the username alone starts a reset. Anyone who
  knows a username can take that account over after 12 hours unless the real
  owner cancels. The push (below) and the banner are the only warnings, and they
  reach only a device that is signed in or has push allowed. This is why it is
  High.
- **Flow:**
  1. Forgot screen, "אין לי קוד" -> username -> Edge Function `request-reset`
     (no session). Same answer for a known and an unknown username. It stores a
     request (only the hash of a random request token) and returns the token to
     that device only.
  2. The account's devices get a push, "התבקש איפוס לסיסמה שלך. לא אתם? פתחו
     וביטלו.", and every signed-in session shows a banner with ביטול.
  3. After **12 hours**, if nobody cancelled, the requesting device can set a new
     password: `request-reset` checks the token and the time, sets the password,
     revokes every session, and shows a new recovery code once (the same tail as
     `handleRecover`). The token expires 24 hours after the wait ends.
- **Rules (decided):**
  - 12-hour wait; cancel from any signed-in session; a cancel blocks new
    requests for that username for 24 hours.
  - Rate limits: 3 requests per username per day, plus the IP limit and window
    from `recovery.mjs`. A new request replaces an open one and restarts the
    12 hours.
  - Works for every member, in a circle or not. The owner SQL line stays as a
    faster path (`ops/PASSWORD_RESET.md`).
  - Push: a fifth notification type, sent even if the member's other
    notification switches are off, to every device that already allowed push.
    No push permission is asked for because of it.
- **Files:** new migration (`reset_requests` table, no client grants;
  `my_pending_reset()` and `cancel_my_reset()` as `SECURITY DEFINER`,
  `search_path ''`, execute revoked from `public` and `anon`, granted to
  `authenticated`, in the reviewed-functions table; the new notification type
  wherever the type list is constrained); new Edge Function
  `supabase/functions/request-reset` with logic in `_shared/recovery.mjs`, and it
  triggers `notif_push_send`; `src/community/recovery.js` (forgot screen, waiting
  state with the time left, cancel banner); `src/community/notifications.js`
  (the push text and deep link); `deploy-edge-functions.yml` (add the function);
  `docs/ops/PASSWORD_RESET.md`.
- **Decision record:** changes "Home and recovery" and the "four notifications"
  line in decisions.md. The consolidation session after the merge writes both,
  with the accepted risk above.
- Mig **yes** · Sec **yes** (definer functions, edge functions, auth, push) · Risk **high**.
- **Verify:** pgTAP file in `supabase/tests/` (no client can read
  `reset_requests`; a member sees and cancels only their own; anon refused);
  unit tests in `test/recovery-edge-functions.test.mjs` (unknown username gives
  the same answer; reset refused before 12 hours, after cancel, after expiry,
  with a wrong token; limits); browser `circles-client.mjs` with the mock
  (request, banner, cancel). `supabase test db` needs Docker: if the session
  cannot run it, it says so and the PR does not merge until CI runs it.
- **Manual:** after merge, with two phones: request on one, check the push and
  the banner on the other, cancel; request again (after the 24-hour block, or on
  a test account), wait 12 hours, set the new password and sign in.

### F6 · Medium · looks · Welcome sheet: white subtitle, title on the top edge, docked right on desktop (M1, M2)
- **Root cause:** the classic-palette override list (`index.html:180-184`)
  resets the welcome intro and title but not `.scene-page__subtitle`, and its
  `margin-inline:0; padding-block-start:0` beat `#welcomeOverlay .welcome-scene`
  (`index.html:394`), so the sheet loses its centring and top padding.
- **Files:** `index.html` (style block only).
- **Fix:** add the subtitle to the override list (for `#welcomeOverlay` and
  `#achievementsList`); give the welcome sheet `margin-inline:auto` and
  `padding-block-start:max(var(--space-lg), env(safe-area-inset-top))` in a rule
  that wins over line 180.
- Mig no · Sec no · Risk low.
- **Verify:** add the welcome sheet, light theme, to `a11y-screens-palettes.mjs`
  (it is never opened there today); `first-run-sequence.mjs`; screenshot at 390
  and 1280.
- **Manual:** clear site data on the phone, open in light theme.

### F7 · Medium · looks · Notification centre sheet header (M9)
- **Root cause:** `notifications.js:913-925` builds its own header: an empty
  100px `headerStrip`, a text "סגירה" link (`.link-btn`, 36px high), and the
  "הכול כבר סומן כנקרא" line shown next to the empty state.
- **Files:** `src/community/notifications.js`.
- **Fix:** delete `headerStrip`; use the standard header (`h2` plus
  `icon-btn` close, as `index.html:1074`); hide the mark-all row when the list is
  empty so the empty state is one line.
- **Twins:** the reactors sheet (`reactions.js:62-66`) hand-builds the same
  header; fix it the same way.
- Mig no · Sec no · Risk low.
- **Verify:** `community-notification-center.mjs` at 390px; `app-dialog-keyboard.mjs`.

### F8 · Medium · looks · Legal pages and 404 (M10, L1, legal back link from L5)
- **Root cause:** hand-edited static pages.
- **Files:** `privacy.html` (delete the "תנאי שימוש" h1 at line 66), `terms.html`
  (delete the duplicate at 68), `404.html` (`<html lang="he" dir="rtl">`), the
  `.back-link` rule in both legal pages (`inline-flex`, `min-height:44px`).
- Mig no · Sec no · Risk low.
- **Verify:** add to `test/public-surface.test.mjs`: exactly one h1 per legal
  page, every public HTML page has `lang="he" dir="rtl"`.

### F9 · Low · looks · Hebrew prefix glued to a Latin lift name (L2)
- **Root cause:** template strings write `ב${name}`.
- **Files:** `src/progress.js:294`; twins `app.js:1552`, `app.js:1553`,
  `app.js:6383` (an aria-label).
- **Fix:** `ב-` and isolate the name (FSI U+2068 / PDI U+2069 in plain strings,
  `bidiText` in HTML).
- Mig no · Sec no · Risk low.
- **Verify:** a case in the progress unit test; `bidi-measurement-order.mjs`.

### F10 · Low · looks · PR post shows a raw ISO date (L3)
- **Root cause:** `posts.js:588` slices the timestamp instead of formatting it.
- **Files:** `src/community/posts.js`.
- **Fix:** use `fmtDate` (`src/format.js:22`, already loaded and precached).
  In the session, grep `.slice(0, 10)` in `src/community/*.js` for other display sites.
- Mig no · Sec no · Risk low.
- **Verify:** the posts render test.

### F11 · Medium · feels · Daily streak in the nav menu and the header (M3)
- **Root cause:** `computeCurrentStreak` (`app.js:5565`) counts consecutive
  days; it feeds the nav menu line (`app.js:261`) and the header flame
  (`updateStreakLabel`, `app.js:5577`). decisions.md: no daily streaks.
- **Files:** `app.js`, `src/progress.js:295`.
- **Fix:** replace both with weeks the target was met this year, already computed
  as `weeksMet` (`app.js:6446`, `BoxLogProgress.weeksYear`); delete
  `computeCurrentStreak` and the flame.
- **Twins:** `src/progress.js:295` "N שבועות ברצף ביעד" is a run that a missed
  week resets, against "a missed week resets nothing": replace with the count.
  Left deliberately: `achievements.js:39-42` consistency medals count consecutive
  weeks, not days (flag if you want them gone too). The DB-side
  `notif_streak_at_risk` and `community_streaks` (audit.md) need a migration and
  are not in this plan.
- **Decided 2026-11-10:** weeks on target.
- Mig no · Sec no · Risk low.
- **Verify:** grep the tests for `ברצף` and update them; `home-390.mjs`.

### F12 · Medium · feels · Two settings screens; Me unreachable when signed out (M6, M7)
- **Root cause:** Settings (`app.js:6540`) and Me (`circles-ui.js:536`) grew
  separately: both show appearance (`renderAppearanceSection` in each), the menu
  shows the local name, Home the profile name, and Me opens only from the circle
  avatar, so the support sheet (`app.js:1905`) points at a screen with no entry.
- **Files:** `app.js` (settings pane, nav menu, support sheet),
  `src/community/circles-ui.js` (Me), `index.html` (menu entry).
- **Fix (recommended):** one screen, Me, opened from the menu for everyone.
  Signed out it shows local settings plus sign-in; signed in, the profile name is
  the one name everywhere and the local name is only the signed-out fallback.
  The support sheet gets a "כניסה לחשבון" button that opens it.
- **Decided 2026-11-10:** merge Settings into Me, as above.
- Mig no · Sec no · Risk **high** (many tests and browser checks open Settings).
- **Verify:** `member-surface-polish-390.mjs`, `notification-toggles-390.mjs`,
  `app-dialog-keyboard.mjs`, `first-run-sequence.mjs`; grep the tests for
  `open-settings`.
- **Manual:** phone, signed out and signed in: menu, Me, support.

### F13 · Low · feels · Touch targets under 44px; header icons unexplained; no skip link (L5, L6)
- **Root cause:** `.link-btn` is `min-height:36px` (`index.html:313`),
  `.icon-chip` is 30x30 (`index.html:412`), the reactors trigger is 42 wide.
- **Files:** `index.html`, `src/community/reactions.js`.
- **Fix:** `.link-btn` min-height 44; `.icon-chip` keeps its 30px look with a 44px
  hit area (padding or an inset pseudo-element); reactors trigger min 44;
  a "דילוג לתוכן" skip link to `main`; move release notes (the sparkle,
  `index.html:764`) into the nav menu as a text row, so the header keeps only
  icons whose meaning is obvious (menu, medals).
- **Twins:** every `icon-chip` (header menu, medals, release notes, profile
  edit `app.js:6551`); every `link-btn`.
- Mig no · Sec no · Risk med (header layout at 320px).
- **Verify:** extend the 44px check in `a11y-screens-palettes.mjs` to Home,
  Me and the circle feed; `header-medals-icon.mjs`, `install-dock-hit-check.mjs`,
  `text-scale.mjs`.

### F14 · Low · looks · Calendar day rows wrap unevenly (L4)
- **Root cause:** `renderDayEntriesListHtml` (`app.js:5713`) lays rows out as
  flex groups with no columns.
- **Files:** `app.js`, `index.html` (one rule).
- **Fix:** a grid row: name `1fr` with ellipsis, summary `auto`, actions `auto`, one gap.
- Mig no · Sec no · Risk low.
- **Verify:** 390px in Chromium with a long Latin name; add the assertion to
  `training-log-polish.mjs`.

### F15 · Low · looks · Desktop is a 480px column (L7)
- **Decision (yours).** **Recommendation:** accept it. This is a phone app for
  friends; a two-column layout is a large change for a screen nobody uses. If you
  want it, it is its own later session, size L.
- Mig no · Sec no · Risk n/a.

### F16 · Low · perf · Gym-app leftovers (L12)
- **Files:** `index.html:70-71` (CSP: drop `wss://` (no Realtime) and the
  Supabase host from `img-src` (no buckets)); `cloud.js` (coach, challenge, club
  state keys and their comment blocks); `src/community/notifications.js:13-15`;
  `.claude/agents/` (remove admin-moderation, challenges, coach-tools, events,
  feed, recaps; rewrite engagement as reactions only).
- **Fix:** delete; keep everything decisions.md lists under Keep.
- **Out of scope:** DB functions for dropped features (e.g. `notif_streak_at_risk`)
  need a migration; a separate gated session.
- Mig no · Sec no (CSP is client) · Risk med (a CSP mistake blocks the API).
- **Verify:** `test/sw-precache.test.mjs`, the CSP tests (grep `connect-src`),
  `boot-smoke.mjs`, `circles-client.mjs`.
- **Manual:** after deploy, sign in on the phone and react to a post.

### F17 · Low · perf · First load size (L11)
- **Recommendation:** no deploy-time comment stripping: it is a build step, which
  CLAUDE.md rules out. Cloudflare already compresses (about 526 KB gzip; comments
  compress well). Take the real gain from F16 deleting dead code, then measure
  boot time on the phone before deciding anything else.
- **Fix:** none beyond F16, plus moving the longest historical comment blocks in
  `app.js` into `docs/journal.md` where they only record history.
- Mig no · Sec no · Risk low.
- **Verify:** `boot-smoke.mjs`; report the before and after bytes.

### F18 · Low · looks · Splash colour does not match the default palette (L13)
- **Files:** `manifest.json:11-12` to `#152342` (classic, dark, the defaults);
  twins `index.html:92-93` static `theme-color` metas to `#F2F5FA` / `#152342`.
- Mig no · Sec no · Risk low.
- **Verify:** `design-system.mjs`.
- **Manual:** remove and re-add the home-screen app, check the splash.

## 3. Phases

Run in order, one at a time: each phase touches `app.js` or `index.html`, so two
at once would conflict. Update each branch from `main` before merging.

| # | Session | Branch | Items | Size | Gate |
|---|---|---|---|---|---|
| 1 | Offline, input and auth safety | `fix/p1-offline-auth-security` | F1, F2, F3, F4, F5, F19 | L | **Migration gate** (F19) and edge functions deploy on merge. |
| 2 | Welcome, sheets, legal, RTL | `fix/p2-welcome-sheets-legal-rtl` | F6, F7, F8, F9, F10 | M | none |
| 3 | One settings screen and touch targets | `fix/p3-ux-consistency-touch` | F11, F12, F13, F14 (F15 only if you choose two columns) | L | none |
| 4 | Strip and perf | `fix/p4-strip-perf` | F16, F17, F18 | S | none |

**Before phase 1:** nothing; F5 and F19 are decided. Do the F5 dashboard check first. **Before phase 3:** decide F15
(F11 and F12 are decided).

**Phone checks after each merge:**
1. Airplane mode: the Circle tab shows the offline state; type "1,250.5" and "٢٠"
   into a weight; sign in with a Hebrew username and read the message; run the F19
   lost-code reset end to end on two phones and cancel one from the signed-in phone.
2. Clear data, light theme: the welcome sheet; the notification centre empty;
   privacy and terms back links; a PR post date; a weekly summary line with a Latin lift.
3. Menu: no daily streak, weeks on target instead; Me from the menu signed out
   and signed in; tap every header icon; a calendar day with long names.
4. Sign in, react, receive a push; re-add the home-screen app and check the splash.
