# COMM-329 Add heading elements and landmark regions to the app shell

Phase: Design sync & audit remediation (2026-09-02)
Agent: cross-cutting (UI/design)
Status: done
Priority: P0
Attendance-blocked: no

## Problem / user outcome

Neither app has a single `<h1>`-`<h3>`, `<header>`, `<nav>`, `<main>`,
`<footer>`, or `role="main"|"navigation"|"banner"` anywhere — confirmed by
exhaustive grep across `index.html`, `app.js`, and `cloud.js` in both repos.
Screen-reader heading/landmark navigation returns nothing on every screen of
both apps, including all of Community's community layer.

## Acceptance criteria

- [x] Real `<h1>`/`<h2>` elements introduced for page and section titles (replacing
  plain `<div class="page-title">` / section-title divs) with no visual change
  for sighted users.
- [x] `<header>`/`<nav>`/`<main>` landmarks added to the app shell; exactly one
  `<main>` landmark per screen.
- [x] An axe or heading-outline scan of every top-level tab and every community
  screen (feed, profile, challenges, admin) shows a non-empty, logically nested
  heading list.

## Location / evidence

- Confirmed absent via grep across `index.html`, `app.js` (both repos) and
  `cloud.js`
- `app.js:149` (`.page-title` div), `app.js:536-561` / `cloud.js:3355` (section
  titles as plain divs/spans)

## Shipped 2026-09-02 (Community repo only — partial)

- Heading reset added (`h1, h2, h3 { margin: 0; font: inherit; }`,
  `index.html`) so semantic elements inherit their existing class's
  size/weight/margin instead of picking up the UA default heading margin on
  top of it.
- `renderTabHeader()` (`app.js`) now emits `<h1 class="page-title">` — covers
  all 4 core tabs (add/history/calendar/wod), one shared function.
- `sectionHead()` (`cloud.js`, 30 call sites across feed/challenges/events/
  moderation/admin/etc.) and the 4 inline achievements-panel section headers
  (`app.js`) now emit `<h2 class="ach-section-title">` instead of `<span>`.
- App shell landmarks: `.header` div → `<header>`; `#content` wrapped in
  `<main>` (kept `role="tabpanel"` on the inner div rather than on `<main>`
  itself — an explicit `role` on the landmark element would override its
  implicit main-landmark semantics for assistive tech); `#desktopSidebar`
  and `#navMenuList` → `<nav aria-label="ניווט ראשי">`.
- Verified: `node --test` full suite green (941 tests, 940 pass / 1 skip / 0
  fail) after these changes: no test asserted a tag name or `span`/`div`
  selector for any element touched here.

## Shipped 2026-09-03 (closes the h1 gap below)

- `renderCommunityApp()`'s main tabbed shell (feed/boards/directory/account/
  coach) now opens with `renderTabHeader("community")`, the same shared
  function the other 4 solo tabs already use — reads "קהילה" from the one
  `getNavItems()` registry entry rather than inventing a second name (the
  per-club name stays the club-strip card's own identity, not this screen's).
  The pre-membership gate screens above it in the same function (login,
  invite code, profile completion, recovery) are unchanged — they're
  one-off setup cards, not "the Community tab" this gap was about.
- Verified via the existing community test suite (feed-client, nav-exports)
  booting `renderCommunityApp()` for real; no ReferenceError from calling an
  app.js-defined function from cloud.js (cloud.js loads first in
  `index.html`, but this call only executes on an actual render, well after
  both scripts have run).

## Shipped 2026-09-04 (further remaining-scope closure, this repo only)

- `adminAnalyticsCard(title, bodyHtml)` (`cloud.js`) — the one shared
  function behind all 27 metric cards inside the admin analytics dashboard
  (`renderAdminAnalyticsDashboard()` and its own nested groups) — now emits
  `<h3 class="field-label">` instead of `<div class="field-label">`. This is
  a real "admin panel sub-header not going through `sectionHead()`" gap, the
  exact category the "Not done" note below named; converting the one shared
  function fixes all 27 call sites at once, the same leverage the original
  pass used for `sectionHead()`/`ach-section-title`. Nests correctly: every
  caller of `adminAnalyticsCard()` already renders inside a `sectionHead()`
  h2 (verified: `renderAdminAnalyticsDashboard`, `renderRegistrationFunnel`,
  `renderMemberSegments` — all reached from the h2 "לוח בקרה: אנליטיקת
  קהילה" section), so h3 is the correct next level, not a skip.
  `test/community-retention-correlation-views.test.mjs:176` already
  selects `.chart-card .field-label` by class, not tag, so it needed no
  change.
- New `test/heading-outline.test.mjs`: a real automated heading-outline
  scan (not a scanner dependency, but a genuine DOM heading-list check) for
  the 4 solo top-level tabs (add/history/calendar/wod), using the existing
  `bootApp()` jsdom harness. Asserts, per tab, exactly one `<h1>` inside
  `<main>` and that the heading list never skips a level going deeper (no
  h3 with no ancestor h2, etc.) — the real substance of acceptance
  criterion #3. This is real, if partial, closure of the "no automated
  scan was run" gap below: it covers the 4 solo tabs for real, but not the
  four community screens the criterion also names (see below).

## Shipped 2026-09-22 — closes this ticket

Everything the "Not done" list below named, plus the tab/tabpanel and
icon-label halves the audit never separated out. **No visual change**, with
one deliberate exception noted at the end.

### 1. One `<h1>`, then h2/h3 in order, on every screen

- **The training log** had exactly one heading per screen — its `<h1>` — and
  nothing under it. Ten of its eleven `.section-label` blocks were plain `<div>`s (the
  eleventh, the calendar list view's per-date title, was already an `<h2>`
  inside a `<section aria-label>` — that one was the model). All eleven are
  now real headings:
  `<h2>` for a section of a screen ("סיכום האימון", "משקל גוף", "מדדי גוף",
  "נפח ותדירות לפי קטגוריה", "בנצ'מרקים", "שיאים כלל-זמנים" ×2, the calendar
  day), `<h3>` for the two that sit inside one of those ("איך היה האימון
  היום" inside the day card, "כל הניסיונות" inside an expanded benchmark).
- **`.cat-name`** — the category head above each movement/WOD group, 4 call
  sites — is now a heading, at the level its mount point dictates: `<h2>` in
  the WOD catalogue sub-tab (directly under that screen's `<h1>`), `<h3>` in
  the three pickers (under the dialog's own `<h2>` title). Same class, two
  levels, because the level is a property of where the list is, not of the
  list.
- **The 8 `index.html` dialog titles** (`.modal-title`) were `<span>`s that
  were already each a `role="dialog"`'s `aria-labelledby` target — they named
  their dialog and were invisible to heading navigation. Now `<h2>`. This is
  the app.js half of what the 2026-09-02 pass did for cloud.js's dialogs.
- **The 48 one-off `<div class="field-label">` sub-headers** the "Not done"
  list named as the blocker were audited one at a time. **33 became `<h3>`**
  — every one that heads a list or a multi-part block (invite panels, ended
  challenges/events, team management, challenge rules/leaderboard/
  participants/progress, the weekly recap's five lists, the admin analytics
  groups, onboarding and intro-carousel step editors, monthly-recap months,
  directory search groups, coach picker). **15 stayed `<div>`** on purpose,
  and this is the finding the original "~40 sub-headers" count missed: they
  are not sub-headers. Eight are captions over a single value ("אימונים
  השבוע" above one number, "האירוע הקרוב" above one link, "לפי scope" /
  "לפי מקור" above one breakdown row), five are one-off result banners
  ("הקוד נוצר — זו הפעם היחידה…", "הסיסמה של X"), and two label a form
  control ("מי רואה את הפוסט" over a radio group, "הטקסט שילווה את התמונה"
  over a textarea). Promoting those would have added ~15 headings that name
  no section, which makes heading navigation worse, not better.
- Two screens genuinely have a section with no visible title — the Add tab's
  logging form and the WOD "רישום" sub-tab. Each gets a clipped
  `<h2 class="sr-only">`, so the outline is complete without anything
  appearing on screen.

### 2. Landmarks

`<main aria-label="תוכן ראשי">`, `<header aria-label="כותרת האפליקציה">`, and
the two existing `<nav aria-label="ניווט ראשי">`s. Five named `role="region"`
landmarks on the training log's own mount points (`#historyListArea`,
`#bodyweightArea`, `#measureArea`, `#wodHistoryListArea`, `#calDetail`), plus
`#benchmarkArea`, whose role goes on and off with its content because that
section is gated on a club feature flag and an empty named landmark is noise
a reader still has to step through. All attributes — no element is added,
moved or wrapped.

`#contextCol` is deliberately still unnamed. index.html carries a comment
explaining why (a landmark's name has to describe what is mounted in it, and
that file does not know), and this pass agrees with it rather than overriding
it.

### 3. The tab pattern, completed on all six tab strips

Before this pass, three of the six strips were half-declared. Now every
`role="tablist"` has a Hebrew `aria-label`, every `role="tab"` carries
`aria-selected` and an `aria-controls` that resolves, and every panel it
points at is a `role="tabpanel"` with an `aria-labelledby` that resolves:

- `#bottomTabBar` — gained `aria-label="מסכים ראשיים"`; its tabs already had
  `aria-controls="content"`, and `#content` is now named by the active tab
  from `render()`.
- The nav-menu / desktop-sidebar `.nav-destinations` strips — gained
  `aria-controls="content"`.
- The WOD `.subtabbar` — gained `aria-label`, per-tab ids, and `#wodContent`
  is now a `role="tabpanel"` named by the selected sub-tab (kept in sync by
  the `switch-wod-subtab` handler, which only swaps innerHTML).
- The feed scope chips — declared `role="tab"` with nothing to control: the
  list they swap renders under three different ids depending on state and the
  empty state has no container at all. One stable `#communityFeedPanel`
  wrapper now completes the pair.
- The Community and Manage sub-tab bars were already complete (2026-09-10).

### 4. Icon-only buttons

A DOM sweep of every screen for an interactive element with no visible text
and no accessible name found exactly one live case: `#userGreeting`, which is
empty until a member has a name and dropped its `aria-label` in that same
state. It now keeps one either way. The sweep is now a test, so the next one
fails the build instead of shipping.

### 5. Focus rings

Already correct and now guarded: all three focus rules
(`:focus-visible`, `.search-box:focus-within`, `.term-mark:focus-visible`)
draw `outline:2px solid var(--brass)`, and a new test asserts both that no
focus ring uses a hardcoded colour and that every token one does use is
defined in all three theme blocks CLAUDE.md describes.

### The one visual change

`.sr-only` was **in use and had no CSS rule anywhere** — cloud.js's staff
context column spells the moderation count out for a reader beside an
`aria-hidden` numeral, and that sentence was simply painting on screen next
to the badge it was meant to replace. The rule now exists (same clip
technique as the existing `.file-input-hidden`, and it sets no colour, so it
needs no dark-theme entry). Found while auditing, not reported.

### Verification

- `npm test` — **2116 pass, 0 fail**, 13 of them from the new file below.
- `test/a11y-screen-structure.test.mjs` (new) — 13 tests. Heading order,
  landmarks, the full tab/tabpanel contract and the icon-label sweep, applied
  to all four training-log screens, the three WOD sub-tabs, all four
  community screens the acceptance criterion names, the staff Manage screen,
  the feed scope strip, and the challenge detail dialog. Plus the focus-ring
  token check.
- `scripts/browser-check/run-all.mjs` — **49 checks, all passed**, including
  `a11y-axe-scan.mjs` (no serious/critical WCAG violations on any of its
  seven screens). Run on Chromium 141.0.7390.37, which is the build this
  sandbox has, NOT the 151/rev-1234 build `scripts/browser-check/
  package.json` pins and which CLAUDE.md's measured desktop numbers come
  from. The geometry checks (`desktop-layout`, `desktop-staff-shell`,
  `desktop-column-widths`) passed on it, but CI's pinned build is the one
  that settles those.
- `supabase test db` — not run: needs Docker, and this branch adds no
  migration and touches no SQL.

## Superseded — what the "Not done" list said before this pass

One item on it is NOT superseded and cannot be from here: applying the same
conversion to `crossfit-pwa-Noam`. That repository is not in this workspace,
so this ticket is `done` for **this** repo and the cross-repo half stays with
COMM-351/353/354, which is where every other "needs the other checkout" item
already lives. Nothing about it is claimed either way here.


- The admin-analytics sub-headers are fixed, but `cloud.js` still has
  roughly 40 other one-off `<div class="field-label">` sub-headers acting
  as section/panel titles outside any shared function (invite management's
  two panels, challenge/event "ended" list headers, team management,
  monthly-recap card labels, profile-completion sub-labels, etc. — see
  `grep -n 'class="field-label"' cloud.js`). Converting those is a
  file-wide audit, one heading-shaped element at a time, in a 10,000+ line
  file — explicitly out of scope for this pass too, same reasoning as the
  original 2026-09-02 pass's own scope boundary. This is what a real
  heading-outline/axe scan across every screen (next bullet) would surface
  systematically instead of by manual grep.
- Not applied to `crossfit-pwa-Noam` — confirmed by actually reading
  `crossfit-pwa-Noam/index.html:155` (`.page-title`, still a plain
  `<div id="pageTitle">`) and `crossfit-pwa-Noam/app.js:1287`
  (`.ach-section-title`, still a plain `<span>`) — not out-of-date
  guesswork, read directly from that checkout. Cannot be changed from here
  (see repo-access constraints); whoever owns that repo needs to apply the
  same `<h1>`/`<h2>` conversion this repo already shipped 2026-09-02.
- No automated scan covers the four **community** screens (feed, profile,
  challenges, admin) acceptance criterion #3 also names. Reaching them in
  a test needs `bootCommunity()` with a mock Supabase project and, for the
  admin screen specifically, an admin/coach fixture plus in-app navigation
  to each community sub-view — real, separate harness work, not a small
  addition to `test/heading-outline.test.mjs`.
- No axe-core (or any other accessibility-scanner) dependency exists
  anywhere in this repo — checked `package.json`, `node_modules`, and
  `scripts/browser-check/package.json` (only `playwright`, no
  axe/a11y-named script in that directory). Adding real axe-core coverage
  is new tooling (a new devDependency plus a Playwright-driven scan
  script), not a fix-in-place; `test/heading-outline.test.mjs` above covers
  the "logically nested, non-empty heading list" half of criterion #3
  without that dependency, but does not replace a full WCAG-rule scan.

## Source

Filed from `2026-09-02-design-sync-and-cross-repo-audit.md` (cross-repo design sync and improvement audit against `crossfit-pwa-Noam`).
