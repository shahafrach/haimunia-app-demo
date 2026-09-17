# Session B — Client and product

Read `SHARED_CONTEXT.md` first, and `OWNER_ACTIONS.md` for what is waiting on
a human.

**You own:** `cloud.js`, `app.js`, `index.html`, `cloud-config.js`, `sw.js`,
`src/**`, `test/*.mjs`, `scripts/browser-check/**`, `scripts/owner-guide/**`.

**You do not edit** `supabase/**` or `.github/workflows/**`. If a client
change needs a migration, write up what it must do and hand it over.

## State on 2026-09-17

v4.72.0 · 1915 JS tests green · 3510 pgTAP assertions · 45 browser scenarios green.

**The board is empty.** B1 parked at the owner's word (one club); B2, B3 and B4
done. Do not invent a B5 - ask.

Session A is closed; its file is a record of what each item turned out to be,
and most were not what they looked like. Worth skimming once for the two
patterns in SHARED_CONTEXT — sibling drift, and checks that pass while doing
nothing. Both bit repeatedly.

---

## B1 — BoxLog: make a second club an hour, not an afternoon

**PARKED 2026-09-17, owner's call: "for now it's only 1 club."** The half
that was load-bearing is done and tested — the product name is configurable,
and the two traps below are pinned so a future session cannot "finish the
job" and lock every member out. The rest (palette, assets, setup doc) buys
nothing until a second box is real. Do not pick it up unasked.

**FIRST PASS DONE 2026-09-17.** The product name is configurable; read this
before continuing, because the brief below describes the job wrongly.

"Extract the branding" is not what this is. The ~190 `haimunia` references are
four different things, and only one of them is branding:

| | count | |
|---|---|---|
| `האימוניה` product name | 22 | configurable - done |
| `haimunia-demo:` localStorage prefix | 38 | **new clubs only.** Change it live and every phone silently starts empty, real data still on disk under the old prefix |
| `members.haimuniya.invalid` | 3 | **new clubs only.** Already in `auth.users`; change it and everyone is locked out, with no self-service reset |
| `window.haimunia*` | 6 | not branding - the interface between app.js and cloud.js |

**The club's own name is deliberately NOT configurable.** It lives in the
`clubs` table and is read at runtime. `inviteShareText()` already had this
right: `הצטרפות ל${club} באפליקציית ${brandName()}` - club from the database,
product name from config. A config value for it could only contradict the
database.

Accessors are `brandName()` / `brandWordmark()` / `brandChampionTitle()` in
`src/shared/safe-helpers.js` - **not** in `cloud-config.js`, and that is not a
style choice. Defining them there took down 1184 of 1858 tests: `app.js` builds
`ATHLETE_LEVELS` and `ACHIEVEMENTS` at module evaluation, so an undefined
helper there is a dead app, not a missing label - and the test harness does not
load `cloud-config.js` at all. They read config at CALL time, so a missing
config degrades to the default name instead of white-screening over a wordmark.

`test/brand-config.test.mjs` sets a DIFFERENT name and checks it comes back,
because a helper returning the hardcoded default is indistinguishable from a
working one when the default is the current value. It also pins both traps as
literal, so a future session "finishing the job" fails loudly.

Deliberately still literal: `sw.js` (a service worker cannot reach the page's
`window`, and `importScripts` would pull the Supabase keys into the worker for
one fallback string), and `manifest.json`, `index.html`, `terms.html`,
`privacy.html` - a buildless app cannot template its own manifest.

**Left to do on B1:** the palette (`:root` in `index.html` - the contrast
comments there are measured, not chosen, and must travel with the values), the
nine branded assets, and rewriting `PER_CLUB_SETUP.md` so it names the four
static files rather than sending someone searching.

<details>
<summary>The original brief</summary>


The owner wants to sell this to other boxes under the name **BoxLog**.
`docs/deploy/PER_CLUB_SETUP.md` is the current checklist and it is honest
about the cost: club name, colours, logo, copy and icons are scattered across
`index.html`, `cloud.js` and `app.js` rather than declared in one place.

`cloud-config.js` already exists and already ships as its own `<script>` tag
before `cloud.js`. It is the natural home. The job:

1. Inventory what is actually club-specific. Start with `האימוניה`,
   `הבית שלך לאימונים`, the palette in `index.html`'s inline CSS, the logo and
   icon assets, and the synthetic email domain `members.haimuniya.invalid`.
2. Move each into `cloud-config.js` behind a named key, reading through a
   single accessor so there is one place to look.
3. **Watch the email domain.** It is baked into existing `auth.users` rows;
   changing it for an existing club breaks sign-in. It is per-club for a NEW
   club only, and that distinction needs to be written down where somebody
   will read it.
4. Update `PER_CLUB_SETUP.md` to match what is actually true afterwards.

This is a refactor with no user-visible change, which makes it exactly the
kind of work that silently breaks something. Lean on `node --test` between
steps and on `scripts/browser-check/run-all.mjs` at the end.

Session A's **A4** is the server half of the same goal. Neither of you can
stand up a second club alone.

</details>

## B1a — DONE 2026-09-17: support reachable from the hamburger

Owner's call: "should be in the hamburger, so people will have easy access to
report." It was one row inside Settings under עזרה — three taps and a scroll,
and the moment a member most needs to report a fault is the moment they are
least inclined to go hunting.

Now in `renderNavSettingsRow()`, which the hamburger AND the desktop sidebar
share, so a desktop user with no hamburger gets it too. Still in Settings as
well: "something is broken right now" and "where do I get help" are different
questions. New `ICONS.helpIcon` rather than reusing the gear, which would have
put two identical glyphs on adjacent rows.

`test/support-in-nav-menu.test.mjs`. Note the comment on test 2 — I added a
`closeNavMenu()` "fix" with a confident explanation, reverted it to check the
test caught it, and watched all five pass, because `openSupport()` already
closes the menu on its first line. The assertion stayed; the dead code did not.

## B2 — DONE 2026-09-17: the staff toolbar breaks 3 + 1 on purpose

Made deliberate rather than made to fit. `מחיקה` now has its own row behind the
same hairline the post menu uses to fence destructive items — a pattern already
in the app. `הצמדה למעלה` was left alone: it is shared with the post menu and
the event toolbar, and shortening it in one place is the drift.

Measured, before and after, in the real dialog at both text settings:

| | needs | has | breaks |
|---|---|---|---|
| before, 390px | 347px | 328px | 3 + 1, `מחיקה` orphaned |
| before, 390px large text | 410px | 316px | 2 + 2 — **`מחיקה` beside `סיום`** |
| after, 390px | — | — | 3 + 1, separator above `מחיקה` |
| after, 390px large text | — | — | 3 lines, `מחיקה` still fenced |

The large-text case was the one nobody had looked at and the worse of the two:
delete-forever sitting next to the one action that preserves every
participant's progress.

**Read this before trusting your own measurement.** The first pass said the row
fits in 267px and does not wrap — i.e. that the report was wrong. It was the
measurement that was wrong: the harness took `<style>`…`</style>`, `index.html`
has two style blocks, and every token in the second was missing, so the chips
rendered at fallback sizes. The tell was `--text-scale` resolving to an empty
string. A correct fix was one step from being reverted on the strength of it.
That entry is now in SHARED_CONTEXT's table with the other seven.

## B3 — DONE 2026-09-17: web push delivers

Built after the owner answered the one question that decided it. The case
against was iOS: web push reaches an iPhone only for a PWA installed to the
home screen, and a member browsing in Safari gets nothing, silently. The
owner's answer — *"mostly will install, it's a brand new install and people
will import from the old one"* — removes that ceiling, so it was worth
building.

**More existed than the brief said.** The table, the `sw.js` handler, the
subscribe flow, a VAPID public key, and `streak_at_risk_notify()` already
running daily on cron. The gap was one Edge Function.

- `supabase/functions/notif_push_send` — fetch, encrypt, post. No policy in it.
- `supabase/functions/_shared/webPush.mjs` — RFC 8291 + 8292, WebCrypto only,
  so the file the function imports is the file `node --test` runs.
- `202609170002` — `notif_push_pending` / `notif_push_mark_sent` /
  `notif_push_revoke`, service_role only, plus the `notif-push-send` cron
  every three minutes.
- `supabase/tests/0114` — who gets a push, against a real Postgres.

**Why the selection is in SQL and not in the function.** Who receives a push
is a privacy decision, and this repo can test SQL far better than it can test
Deno talking to a push service. Falsified by rewriting the predicate as
`channel <> 'off'` — the version that pushes to the entire club — and watching
the `in_app` assertion go red.

**The crypto is verified against the RFC's own example, byte for byte,** then
decrypted back with the user agent's private key the way a browser does. This
is the one feature whose failure is completely silent: a wrong byte and the
push service returns 201 while the phone shows nothing.

**Two bugs caught while building it, both this repo's signature shapes.** The
payload emitted `url`; `sw.js` reads `deep_link` and falls back to `"./"`, so
every notification would have opened the home screen instead of its target,
with nothing erroring. And the function was written with no `deno.json` and no
`deno.lock`, which would have failed the deploy of all four functions, not
one — `deno cache --frozen` runs over every function before any deploy. Both
are now tests.

**Live as of 2026-09-17.** `notif_push_send` is deployed (gateway answers 401
where a control probe for a nonexistent function answers 404), `202609170002`
is applied, and `npm run check:drift` reports 172 migrations in agreement. The
`notif-push-send` cron fires every three minutes.

**Still off: `streak_risk_nudges`.** The delivery path is live but has not
been seen to put a notification on a real phone. Turning the nudges on before
that is confirmed would mean the first real use of this code is also its first
test. One migration flips it, once the owner confirms a test push arrived.

## B4 — DONE 2026-09-17: the drift class is now a test, not a habit

Two bugs on 2026-09-16 were the same bug: a row appears on two surfaces and a
mutation refreshed one of them.

- `renderMemberManagement()`'s search panel and `renderMemberRoster()` render
  the identical row via `memberManagementRowHtml()`. `adminRemoveMember` got
  the roster reload; `adminGrantCoach` / `adminSetRole` / `adminRevokeCoach`
  did not, in the same session, hours apart. Reported live as *"after giving
  coach permission, it's not changing"* — the RPC had always succeeded.
  `refreshMemberSurfaces()` now does both.
- Six dialogs carried the identical copied string
  `align-items:flex-start;padding:20px 12px`, pinning a card to the top of the
  screen with half the viewport empty below it. Reported as *"the challenge
  window is too high"*. All six moved together.

`test/sibling-drift-guard.test.mjs`, three assertions, ~1 ms.

It **derives** what to check from the source instead of listing it here, because
a list in a test file needs exactly the maintenance the bug class is made of.
The roster half reads the controls off `memberManagementRowHtml` /
`memberRoleButtonsHtml`, maps each to its handler through the confirm dispatch,
and requires `refreshMemberSurfaces()` in every one — so a *fifth* control added
tomorrow is checked the day it is added, without anybody editing this test.

One exemption, named with its reason in the file: `admin-reset-password` rotates
a secret and changes nothing the row renders.

The overlay half was not the assertion the brief asked for. "No two overlays
share an inline positioning string" would have been wrong — `.modal-overlay` is
`align-items:flex-end` (a bottom sheet) by default, so every centred card dialog
*must* override it inline, and sixteen of them legitimately carry the identical
string. The real invariant is the value: `center`, `stretch` or `flex-end`, never
`flex-start`. The test also asserts it parsed at least 20 overlay styles and
found at least 15 centred, because a guard whose regex stops matching passes
silently — the failure mode in SHARED_CONTEXT's table, six times over.

Falsified before committing, all red on purpose: removed
`refreshMemberSurfaces()` from `adminGrantCoach`, put one dialog back to
`flex-start`, dropped the `loadRoster` line, restored the duplicate dispatch
branch, put `מחיקה` back on the first row. Each failed with the message that
names the fix.

**Extended the same day, by a bug it found while being written.** A sixth
assertion now rejects any `else if (action === "X")` branch that repeats a test
made above it. That caught a live one: the challenge form's "delete draft"
button and the challenge view's "delete" button both fired `challenge-delete`,
and both branches tested for it, so the second was unreachable. A coach
deleting an unpublished draft was warned that "every registration, team and
progress entry will be deleted with it" — a draft has none — and told to end
the challenge instead, which an unpublished challenge cannot do. The copy
written for that exact case had never once been shown. The near-duplicate
`deleteChallengeDraft()` is gone; `deleteChallenge(id, wasDraft)` was already
the strict superset.

## What shipped on 2026-09-16, so you do not re-do it

- **Head coach can remove members.** `admin_remove_member` widened from
  `is_admin` to a permission plus a rank guard (you reach strictly below your
  own rank). The control lives on the roster row; `canRemoveMember()` mirrors
  both server gates so the button is never drawn onto a call that would be
  refused.
- **Challenges can be ended and deleted.** `archiveChallenge()` had existed
  since COMM-207 with one call site buried in the edit form; delete was never
  wired at all though RLS always allowed it. Both are on the challenge's own
  toolbar, and archiving asks first now.
- **Feed rerender storm.** Three per-item loaders each called `rerender()` per
  response — one scroll cost 11 full rebuilds, 8 from `loadReactionsFor`.
  `scheduleRerender()` coalesces arriving data into one frame; anything the
  member *did* still rerenders synchronously. Now 4 rebuilds.
  `scripts/browser-check/feed-rerender-storm.mjs` guards it (tripwire 6).
- **History/Calendar scans.** `entriesByExercise()` and `buildDayIndex()`
  build one Map per render and throw it away. At 2000 entries: History
  3.6→1.3 ms, calendar 1.2→0.6, streak 0.6→0.1.
  `test/scan-indexes.test.mjs` asserts the indexed and unindexed paths return
  *identical* answers, which is the property that matters.

## Two habits worth keeping, both of which earned it again on 2026-09-17

**Measure before you fix.** The rerender note said "21 rebuilds, ~289 ms per
tap". It did not reproduce. The real shape was different and more fixable, and
the fix would have been aimed at the wrong thing.

**Falsify your own tests.** Break the code on purpose and confirm the test goes
red. Doing that caught a day-index test passing while `wodEntries` was dropped
entirely — the fixture had put every WOD on a day that already had a lift — and
caught a timing assertion that was a genuine coin flip, passing twice and
failing twice, before it became somebody's intermittent red.
