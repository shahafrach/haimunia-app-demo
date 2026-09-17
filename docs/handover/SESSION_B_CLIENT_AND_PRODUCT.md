# Session B — Client and product

Read `SHARED_CONTEXT.md` first.

**You own:** `cloud.js`, `app.js`, `index.html`, `cloud-config.js`, `sw.js`,
`src/**`, `test/*.mjs`, `scripts/browser-check/**`.

**You do not touch** `supabase/**` or `.github/workflows/**` — Session A is
there. If a client change needs a migration, write the migration's *intent*
into a note and hand it over; do not add the file.

---

## B1 — BoxLog: make a second club an hour, not an afternoon

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

## B2 — The staff toolbar wraps 3 + 1

On a 390px phone the challenge dialog's staff row is `עריכה │ הצמדה למעלה │
סיום` on one line and `מחיקה` alone on the next. It reads as an accident.

Either make it deliberate (a destructive control on its own row is a
defensible pattern — but then it should look chosen, with a separator or a
label, not orphaned) or make four fit. Do **not** just shorten
`הצמדה למעלה` here: that string appears in four places (`cloud.js` 12117,
12295, 14423, 15090) and changing one is the drift this codebase is made of.

Low priority. Cosmetic, on a coach-only surface.

## B3 — Web push, which blocks a real feature

`streak_risk_nudges` is switched off and stays off because there is no
delivery channel: an in-app-only nudge reaches people who already opened the
app, who are exactly the ones not at risk. The client half (subscription,
`push_subscriptions`, permission prompt) is scaffolded; the sending half does
not exist.

Deferred at the owner's explicit choice. **Confirm he still wants it before
building it** — it is the largest single piece of work left, and it is a
notification feature for a club of a few dozen people.

## B4 — Make the drift class visible instead of re-fixing it

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

Worth one structural test rather than a third fix: assert that every mutation
which changes a roster row refreshes both surfaces, and that no two dialog
overlays carry the same inline positioning string. A grep-level test in the
style of the existing `hunt-round10-drift-and-personas.test.mjs` is enough and
costs nothing to run.

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

## Two habits worth keeping

**Measure before you fix.** The rerender note said "21 rebuilds, ~289 ms per
tap". It did not reproduce. The real shape was different and more fixable, and
the fix would have been aimed at the wrong thing.

**Falsify your own tests.** Break the code on purpose and confirm the test goes
red. Doing that caught a day-index test passing while `wodEntries` was dropped
entirely — the fixture had put every WOD on a day that already had a lift — and
caught a timing assertion that was a genuine coin flip, passing twice and
failing twice, before it became somebody's intermittent red.
