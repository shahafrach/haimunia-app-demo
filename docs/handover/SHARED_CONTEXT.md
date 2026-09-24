# Shared context — read this first

Written 2026-09-17, end of a long day. Your own half is in
`SESSION_A_SERVER_AND_SAFETY.md` (closed, kept as a record) or
`SESSION_B_CLIENT_AND_PRODUCT.md` (in progress).

## What this is

**Haimunia / האימוניה** — a Hebrew/RTL PWA for one CrossFit club. Buildless
vanilla JS: `index.html` (inline CSS), `app.js` (~8,300 lines, the training
log), and the community half — `cloud.js` (6,756 lines: state, render, RPC,
the permission gates and the `window.*` surface) plus fourteen per-feature
modules under `src/community/` (~16,000 lines), split out in PR #15. No
bundler, no framework.
Supabase for auth and data, Cloudflare Pages for hosting.

Live: https://haimunia-app.pages.dev
Repo: `haimuniya/haimunia-app-demo` — **private** since 2026-09-17
Supabase: `jajmlyrjlkhclgphbfbb` (free tier)

**v4.79.0** · 197 migrations (all applied, drift clean 2026-09-24) · (recorded when `npm test` finishes) JS tests · 134 pgTAP files / 4,137 tests · 60 browser scenarios

The numbers in the paragraph below are the 2026-09-19 reconcile and are kept
as its record; `docs/PROJECT_STATUS.md` has the current ones.

Reconciled 2026-09-19 against `main` at `8ce9e5c`. Schema: **63 tables**, all
with RLS on, 137 policies, 235 functions (182 SECURITY DEFINER) — that
function count was read in PR #10 from a container built at 173 migrations and
**has not been re-measured since**. Two migrations have landed on top of it:
`202609180001` changes none of the four counts, and `202609190001` adds
`job_health_state` (RLS on, no policy — hence 63 tables and still 137
policies) plus five functions that no container has counted. Treat the table
row as arithmetic and the function row as stale; re-read all four rather than
trusting them. The pgTAP ASSERTION total is not restated here because it
cannot be measured without Docker — count it from `supabase test db` and put
the number in `docs/PROJECT_STATUS.md` when you have one.

## Read these two first

- **[`/CLAUDE.md`](../../CLAUDE.md)** — the rules every session works under:
  the stack, the theming rule, migration immutability, the precache list, the
  secrets and member-data rules, the desktop gate, sibling drift, how parallel
  branches stay out of each other's way, and what counts as verification.
- **[`docs/PROJECT_STATUS.md`](../PROJECT_STATUS.md)** — the current state:
  version, counts, host, what shipped most recently, what is deliberately
  open.

This file is the third: the hard-won specifics that are not rules and not
state, but the things that have bitten somebody here already.

## The rules that are not negotiable

1. **Nothing secret is ever committed.** There is no build step: Cloudflare
   Pages publishes the repo root verbatim, so every committed file is a live
   URL. `functions/_middleware.js` now 404s the internal paths, but that is
   disclosure control, not a secret store — the git history is what it is.
   This rule was broken twice on 2026-09-16/17. See A1.
   **`.github/workflows/backup-database.yml` still says "This repository is
   PUBLIC"** in its header comment and again in its runtime refusal message.
   That premise is stale — private since 2026-09-17 — but its conclusion is
   not: the dump stays encrypted. Do not "correct" that file by removing the
   encryption. Fix the reason, keep the control.
2. **Browser checks never touch production.** `installMockCloud(page, ...)`
   before `page.goto(...)`, and `resolveLocalOnlyTarget()` for the target.
   Never `TARGET_URL`.
3. **Migrations are immutable** once committed —
   `scripts/check-migration-immutability.mjs` enforces it. One documented
   exception (`202609150016`); read its header before considering a second.
4. **Bump `APP_VERSION` in app.js** on any shipped change (a hook mirrors it
   to `SW_VERSION`), or members keep the cached old app.
5. **Arbox owns class scheduling, bookings, payments and attendance.** This
   app reads attendance and does what happens *after* training. Do not build
   booking.
6. **The app is opened after training,** not during. No rest timer, no
   bar-side calculator.

## The desktop staff shell (2026-09-18)

The app is a phone app with one exception, and the exception is fenced with
two attributes on `<html>` written by `src/desktop-layout.js`:
`data-layout="desktop"` for `(min-width: 1024px) and (pointer: fine)`, and
`data-staff="1"` for that plus `is_staff()`.

Four things to know before touching it:

1. **Every staff-shell CSS rule carries BOTH attributes, and there is no rule
   on `data-layout` alone.** That absence is the entire guarantee that a
   member at a laptop is unaffected. A test walks the block and fails on a
   selector missing either half; a browser check measures a member's sidebar
   (248px at x=892) and logging column (560px at x=300) at 1440px.
2. **The shell adds no colours and no fonts.** Existing tokens only, so it
   themes itself through both dark mechanisms with no rule of its own. The
   first attempt at this feature shipped 23 hardcoded hex values and no dark
   half at all, and was reverted for it.
3. **No new tables, columns, policies or RPCs.** The columns are composed from
   section renderers and RPCs that already existed - `club_wod_boards()` takes
   a date range and always did, which is where the week strip comes from. The
   first attempt added a table and a migration; also reverted.
4. **The 560px logging column still never changes width.** Only the staff-home
   tab widens, through `#app:has(#content .staff-home)`.

## What the analytics cannot tell you (2026-09-19)

Before answering any "which modules do members use" question, read
`docs/audit/usage-queries.sql` — and read these two limits first, because both
look like a zero rather than like a gap:

1. **Eleven modules emit no event at all.** `announcements`, `member_of_week`,
   `welcome_flow`, `monthly_recap`, `club_wod`, `new_member_posts`,
   `post_photos`, `mentions`, `outward_share`, `streak_risk_nudges`,
   `engagement_alerts`. Each has a `club_features` row and nothing in
   `src/analytics.js`'s `EVENTS` mapped to it. Their usage is **unmeasured, not
   zero**, and query 5 gives them a separate verdict string precisely so nobody
   deletes a feature on the strength of a number that was never collected.
2. **Display mode is computed twice and sent nowhere.** `isStandalone()` in
   app.js and `isStandalonePwa()` in cloud.js both read
   `matchMedia('(display-mode: standalone)')`, and neither value reaches
   `analyticsTrack()` — `HAND_PROP_KEYS`/`BUS_PROP_KEYS` would drop it if a call
   site tried. There is also no app-session concept in `analytics_events`: the
   only session-shaped id is `post_impression`'s `feed_session_id`, minted per
   feed load. So install adoption is not answerable from that table. The
   nearest server-side reading, `bug_reports.diagnostics ->> 'standalone'`, is
   a self-selected sample of members who hit a problem and wrote in — it says
   "installed members exist", never "this fraction". The additive fix is one
   line: `standalone` on `club_tab_viewed`'s props.

## An automated reviewer now reads your PR (2026-09-19)

`.github/workflows/claude-review.yml` runs `anthropics/claude-code-action`
when a PR is **opened** — not on every push, since PR #17 — and on any comment
mentioning `@claude`, checking CLAUDE.md's seven rules. If a push is worth a
second look, ask for one in a comment. Three things to know: it **comments and
never gates**, so a green build is still the deterministic guards in
`test.yml` and not this; it holds
`contents: read`, so it cannot push a fix and will not; and it is **dormant
until the `CLAUDE_CODE_OAUTH_TOKEN` repository secret exists**, which as of
this writing it does not — every run skips with a `::notice`. A silent skip is
not a pass.

## The community layer is fourteen files now (2026-09-19)

`cloud.js` was 22,370 lines in one IIFE. PR #15 split it into fourteen
per-feature files under `src/community/` and left 6,756 lines behind. Four
things will bite you if you do not know them:

1. **The modules are classic `<script defer>` files, not ES modules, and
   `cloud.js` is no longer an IIFE.** That is what buys zero call-site
   changes: one shared global lexical scope. It is also why 82 test files
   still boot the layer through `window.eval()` — `import`/`export` in that
   text is a SyntaxError, and jsdom links no module graph. Do not "modernise"
   this without replacing the harness first.
2. **Modules load before `cloud.js`**, because `cloud.js` builds top-level
   `const`s out of direct references to module functions at evaluation time
   (`POST_CARD_RENDERERS` is the clearest). A moved `const` whose *initialiser*
   calls something left behind throws at load — `LOGIN_RECOVERY_NOTE` is why
   it stayed put.
3. **No two files may declare the same top-level name**, and jsdom cannot see
   a violation: `boot.mjs` gives the whole layer one `window.eval()` with its
   own scope, so only Chromium catches it. All three rules are pinned in
   `test/community-module-split.test.mjs`.
4. **Read the source through `cloudSource()`** (`test/helpers/community-src.mjs`),
   not through a path. A test that reads one file asserts a property of that
   file; what you almost always mean is a property of the *layer*. Six
   hand-maintained file lists had quietly stopped covering what they were
   written for — including two carrying the zero-`innerHTML` XSS guard for the
   surface that renders other members' data. And a bare `indexOf` over the
   concatenation finds the wrong occurrence: `const staffToolbar = (staff || pinBtn)`
   matched the event toolbar instead of the challenge one, inside
   `sibling-drift-guard` of all files.

`docs/community/CLOUD_JS_MAP.md` is the map, and its §5 lists the 139 code
lines now duplicated across modules and the five near-duplicate function pairs
— named on purpose, merged on purpose nowhere. Its §9 says where the map was
wrong.

## No CI minutes until 2026-10-01 (2026-09-19)

**The free GitHub Actions allowance ran out on 2026-09-19 and resets on
2026-10-01.**

- **Run `supabase test db` locally before merging anything with SQL in it.**
  In this window that is the only place the pgTAP suite runs — CI's
  `migration-check` job is not answering — so the person merging is the person
  who ran it. Say in the PR which suites you ran and where. `0116` and the
  amended `0113` from PR #14 have never been run by a runner.
- **A job that finishes in three seconds did not run.** During the outage
  every job on PR #15 completed in 2–4 seconds with `runner_id: 0`, no runner
  name and `HTTP 404` on the log download, including jobs its diff never
  touched. That is not a red build and it is not a green one; it is no build.
  This is the same class of mistake as the two instrument failures above —
  read the evidence before believing a total.
- **PR #17 halved the bill, which is not the same as refilling it.** `test.yml`
  had been running twice per push (`push` and `pull_request`, in two
  concurrency groups that could not cancel each other); `push` is `main` only
  now, docs-only changes skip the workflow entirely, and `claude-review` runs
  on `opened` rather than on every push. Those savings start mattering on
  2026-10-01.

## A stash worth reading before you re-find it (2026-09-19)

**`archive/ux-audit-stash`** (`0a43d34`) is a git stash from **2026-09-06**,
made on `fix/ux-audit-blockers` at `45b98fe` — a base that is **not an
ancestor of `main`**. It is on a branch rather than in a stash entry so it
survives the machine it was made on. **Nobody has reviewed it. None of it is
merged.**

It touches `PRIVACY.md`, `app.js`, `cloud.js`, `index.html` and
`privacy.html`, and it is UX-audit work — three findings that three separate
reviewers raised:

- The all-time-records headline showed `bestEst1RM()`, a formula output nobody
  has ever lifted, while the row underneath said `5RM 60`. The stash separates
  the estimate from the heaviest set actually put on the bar, with separate
  labels everywhere both appear.
- The welcome dialog asks when you started at the box, and a date typed there
  was on its own enough to earn every tenure badge it cleared — three
  full-screen celebrations inside ninety seconds, before a single set was
  logged. The stash gates them behind at least one logged session.
- A celebration rendered on top of the five-screen onboarding explainer and
  hid it — both are `.modal-overlay` at `z-index: 50`, so two open at once
  stack by DOM order. The stash defers the celebration and replays it on
  close, because the badge is already marked seen by then and dropping it
  would swallow it silently.

**It will not replay cleanly.** `cloud.js` has been split since, so its
`cloud.js` half needs re-targeting at `src/community/`, and the `PRIVACY.md`
half predates the sub-processor correction in PR #10. Read it before deriving
any of those three findings from scratch; do not apply it blind.

## Hebrew, because it has bitten this codebase repeatedly

- `אחד/ת` is **not a word** — the feminine is irregular (`אחת`). Write it out.
- **Second-person past-tense verbs are homographs.** Never `רשמת/ה`.
- **Third-person past does differ,** so `נכנס/ה` is correct.


## The migration ledger has two blind spots (2026-09-23)

Both were found by walking into them, four days apart, and both cost a
production migration that everyone believed had shipped.

**A version prefix used twice is invisible.** `202609220007` was taken by two
different branches — the technical-account migration and the announcement
feed-card migration. Supabase keys `schema_migrations` on the version, so the
second file was treated as already applied and **never ran in production**,
silently, while every local `db reset` that happened to apply one of them
looked fine. It surfaced only when a branch carrying both hit
`duplicate key value violates unique constraint "schema_migrations_pkey"`.
The rename to `202609220008` is #54. The same shape was live again within
hours: PR #57 added a second `202609230001` while main already had one.

**A deleted or renamed migration is invisible too.** `check-migration-
immutability.mjs` iterates the files *present on disk* and diffs each against
the merge base, so a migration that vanished has nothing to iterate over. That
is exactly why the #54 rename passed it.

Until the guards for both land, two habits are worth keeping: before writing a
migration, `ls supabase/migrations/ | cut -c1-12 | sort | uniq -d` on the
**merge result**, not on your branch — on a branch alone the prefix appears
once and looks fine; and treat a rename as a delete, because nothing else does.

## Production has a gate and a log now (2026-09-24)

**`npm run push:prod` is the only way a migration reaches production**
(`docs/ops/MIGRATIONS.md`). It applies **everything pending**, not just yours —
read the plan it prints, and anything in it that is not yours needs its
author's user to have said yes. Then add a row to the push log in the same
file, at the time: the 2026-09-24 row had to be written afterwards from the
owner's account and has three columns reading `not recorded`, which is the
exact gap the log exists to close.

The two ledger guards from #58 are in `test.yml` and in `push:prod`, so the
"until the guards land" habits in the section above are now enforced, not
just advised.

**Three things that read wrong and are right:**

- The scheduled-job board is **red** until the `edge_functions_*` Vault
  secrets are set (#74). The jobs were always inert; the board stopped
  agreeing they were fine.
- The live smoke test reports four roles as **SKIP** (#81). That is not a
  pass; those boundaries are proven locally by pgTAP only.
- `training_log_usage` (#83) is the one table `anon` may insert into. It is
  deliberate, capped at 1,000 rows a day, and readable by no one — staff get
  totals through `training_log_usage_report()`.

**Backups:** the database *and* the photos (#78), restorable only into a
Supabase project, never bare Postgres (#77). A restore under the new
passphrase was verified 2026-09-24; nothing from before the 2026-09-23
rotation decrypts. `docs/ops/MONITORING.md` §7 is the drill.

## The working tree is shared, and it will move under you (2026-09-23)

Several sessions run against this checkout at once, and this cost real work
twice in one afternoon. One session's `git checkout main` landed another
session's commit on local `main` instead of its own branch, because HEAD moved
between its `checkout -b` and its `commit`. A `git worktree` created by one
session was pruned by another mid-run.

If you are going to run anything long — a suite, a `db reset`, a merge — take
your own worktree (`git worktree add -f /tmp/... <branch>`), run `npm ci` in it,
and re-read `git rev-parse --abbrev-ref HEAD` immediately before you trust a
result. The local Supabase stack cannot be isolated this way: there is one, and
`supabase db reset --local` from any session invalidates every other session's
pgTAP run. Say so in the other session before you reset it — `ListAgents` and
`SendMessage` reach the other local sessions directly, and that is faster than
routing it through a human.

## How to verify anything

```
npm ci                        # FIRST. See below — the suite lies without it
node --test                   # 1970 JS tests, jsdom, ~10 min
supabase start                # docker is on this machine
supabase db reset --local     # replays all 197 migrations from empty, ~3 min
supabase test db --local      # 134 pgTAP files, 4,137 tests
node scripts/browser-check/run-all.mjs   # 60 scenarios, real Chromium
```

**`npm ci` before `node --test`, in any fresh sandbox.** With `node_modules`
missing or incomplete the suite does not error — it reports a plausible
partial result (**525 pass / 140 fail** was the observed figure), and every
one of those failures is `Cannot find package 'jsdom'`, identical with and
without your change. A session that reports that number as a regression has
measured its own container. Found in PR #12 and hit again during the
2026-09-19 consolidation, which is why it is now the first line of the block.

**The browser suite has its own `package.json`, and its own way of lying.**
`scripts/browser-check/` is a separate npm project (`playwright`, `axe-core`);
the root `npm ci` does not install it. Skip that and all 47 scenarios fail
with `Cannot find package 'playwright'` — a total-failure result that looks
catastrophic and means nothing.

Then there is the second layer, which is worse because it survives the
install: **playwright must match the Chromium build present on the machine.**
`"playwright": "^1.48.0"` floats, so a plain `npm install` in that directory
resolved to **1.62.1**, which wants Chromium build **1234**; the image ships
**1194**. Result: all 47 fail again, this time with
`Executable doesn't exist at .../chromium_headless_shell-1234/...` and a
cheerful suggestion to run `npx playwright install` — which on a sandbox with
no browser download is not the fix. Pin to the version whose bundled revision
matches instead:

```
node -p "JSON.parse(require('fs').readFileSync('node_modules/playwright-core/browsers.json','utf8')).browsers.find(x=>x.name==='chromium').revision"
```

On 2026-09-19 that meant `playwright@1.56.0` → chromium 1194, inside the
declared `^1.48.0` range, so nothing in the repository needed changing. **Two
consecutive "47 scenario(s) failed" results on this consolidation were both
the instrument**, and the tell was the same each time: a suite where
*everything* fails has usually not run at all. Read the first scenario's
actual error before believing a total.

`node --test` and `db reset` exceed a 2-minute foreground timeout — background
them. `run-all.mjs` kills any scenario over 8 minutes and reports HUNG
separately from FAIL.

**A green suite is not a deploy.** Nothing in CI applies migrations to
production; `supabase db push --linked --yes` does, by hand. Confirm with
`npm run check:drift`, never with a doc — it runs that same CLI call, names any
migration that is committed-but-unapplied, and exits 2 rather than 0 if it
could not check at all. On 2026-09-17 a security migration had been sitting
committed, tested and unapplied for a day, and was found on a hunch.

## Two green branches can merge into a red main (2026-09-19)

It happened on this consolidation, and no rule in `CLAUDE.md` would have
caught it. PR #13 added `test/workflow-action-pinning.test.mjs`, which walks
**every** file in `.github/workflows/` and asserts each action's pinned
version runs on Node 24. PR #11 added `.github/workflows/claude-review.yml`,
using `anthropics/claude-code-action`. Both were green against `main` at
`18c9172`. Neither branch contained the other's file, so there was no textual
conflict and nothing to resolve — and `main` went red the moment the second
one merged, because a directory-walking test acquires new inputs it has never
seen from a branch that never ran it.

**`CLAUDE.md`'s "only one open branch adds a migration at a time" is the same
hazard with a narrower scope.** The general form: *a branch that adds a file
to a directory something else enumerates is in conflict with that something
else, even though git says it is not.* The enumerated directories here are
`.github/workflows/`, `supabase/migrations/`, `supabase/tests/`,
`scripts/browser-check/` and `src/` (the `sw.js` precache guard).

The practical habit, which costs one command: before merging a branch that
**adds** a file under any of those, run the suite on the merge result rather
than on the branch. A branch being green is a statement about the branch.

## The defect pattern this codebase actually has

**Sibling drift** — a rule fixed in one place and not carried to its twin.
Roughly half of every finding across ten hunt rounds, and it produced five
separate bugs on 2026-09-16/17 alone, three of them written by the session
that had just fixed the first one. Before finishing any fix, grep for the
other call sites. If a rule has N places and you changed one, you have not
finished.

It held again on 2026-09-19: the dead first-set weight guard in `saveSet()`
had an exact twin in `saveWod()`, and the twin existed only because a previous
round had fixed one copy and not carried it across. The fix collapsed both
into one shared predicate rather than editing two — **the durable repair for
drift is deleting the second copy, not synchronising it.** The counter-example
from the same day is worth the same weight: `admin_member_roster` returned a
different value than it sorted on, and every other cursor-paged function in the
schema was checked before that was called a class. All seven already did the
right thing. Sometimes the grep comes back clean, and saying so is the finished
change.

## The second pattern, learned the hard way on 2026-09-17

**Seven things reported success while doing nothing.** All of them passed
review. All were caught by running them for real:

| | looked like | did |
|---|---|---|
| `_redirects` | blocking internal paths | nothing — Pages serves an existing file first |
| `grep "CREATE TABLE public.profiles"` | verifying the dump | failed a perfect backup; pg_dump writes `CREATE TABLE IF NOT EXISTS "public"."profiles"` |
| `tar \| grep -q` under `pipefail` | proving decryption | SIGPIPE — passes on a small archive, dies on a real one |
| `inputs.drill` | gating the restore drill | skipped it; run still green |
| `closeNavMenu()` in open-support | preventing stacked overlays | nothing — `openSupport()` already did it |
| `ALTER DEFAULT PRIVILEGES … FROM public` | closing the anon EXECUTE gap | narrowed it; PUBLIC still grants EXECUTE |
| a CSS reconstruction taking `<style>` … `</style>` | measuring a real layout | took the FIRST of two style blocks. Chips measured 267px against a real 347px, so the measurement said "fits fine" about a row that visibly wraps — and nearly reverted a correct fix (2026-09-17) |

**Falsify your own tests.** Break the code on purpose and confirm the test
goes red. That caught a day-index test passing while `wodEntries` was dropped
entirely, a timing assertion that was a genuine coin flip, and a "fix" for a
bug that did not exist.

**Measure before fixing** — and check the instrument before believing it. A
recorded "21 rebuilds, 289 ms per tap" did not reproduce and pointed at the
wrong code. The opposite also happened: a measurement said a reported wrap did
not reproduce, and the measurement was broken, not the report. The tell was a
CSS variable resolving to empty. If a measurement contradicts something a human
watched happen, suspect the measurement first.

## Declined by the owner — do not re-propose

Streak consolidation · streak nudge redesign · opt-in board ranking ·
finishing `lang="en"` · removing the welcome-modal name field.

## Permanently open, by plan

**Leaked-password protection** will show as a WARN in Supabase's security
advisor forever: it is Pro-plan only, confirmed by trying it. Not fixable on
the free tier and not worth looking at again. Generated passwords achieve the
same thing.
