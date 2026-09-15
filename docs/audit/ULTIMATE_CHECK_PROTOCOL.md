# The Ultimate Check — 10 QA rounds, then 10 security rounds

One combined protocol: Part 1 runs 10 rounds of live functional/UX bug hunting to
completion (fix-then-advance, every round), THEN Part 2 runs 10 rounds of live
security hunting to completion, the same way. Do not interleave the two parts, and
do not run this alongside another session doing the same thing on the same working
tree (git conflicts, shared local Postgres contention, resource contention — see
prior discussion in this project's own history). 20 rounds total, 3 fresh agents per
round, 60 agent-areas in all.

---

# PART 1 — QA / LIVE BUG HUNT (10 ROUNDS)

## THE PROMPT (Part 1 — copy from here down to start QA rounds)

Run 10 rounds of live bug hunting against this app. Each round: spawn 3 parallel
fresh agents (no memory of prior rounds — new `Agent` calls, `subagent_type:
"general-purpose"`, never `"fork"`), each assigned one area from the round's list
below. Wait for all 3 to report. Consolidate the findings into one prioritized list.
Fix every confirmed bug directly, each with its own regression test. Run the full
verification pass. Commit and push. Only then start the next round.

Before round 1 of THIS invocation, check `CHANGES.md` and `git log` for prior "live
bug hunt" entries — if rounds have already run in this repo, skip their areas and
continue from the next unused round in the assignment list below. Rounds 1-2 below
have already run in this project (see `CHANGES.md` — 15 confirmed bugs found and
fixed); start at round 3 unless a fresh check of `git log`/`CHANGES.md` shows
otherwise.

### Non-negotiable rules for every agent

1. **Actually load pages and interact with them in a real rendered browser
   (Playwright/Chromium).** Do not just read source code and guess. An agent that
   reports a "bug" it did not personally reproduce live is not useful — reject and
   respawn instead of trusting it.
2. **Never let anything reach the real production Supabase project.** Always
   `installMockCloud(page)` (from `scripts/browser-check/lib/mockCloud.mjs`) before
   `page.goto(...)`, and use `resolveLocalOnlyTarget()`/`resolveTarget()` (from
   `scripts/browser-check/lib/target.mjs`) for a throwaway local static server. No
   exceptions, not even read-only checks.
3. **Read what already exists first.** Each agent's prompt must name the specific
   existing `scripts/browser-check/*.mjs` and `test/*.mjs` files most relevant to its
   area, with an instruction to read them before testing — so it doesn't re-report
   something already covered and passing, and so it learns the app's own conventions
   (helpers in `scripts/browser-check/lib/actions.mjs`, seeding patterns in
   `test/helpers/mockSupabase.mjs`).
4. **Write only throwaway scratch scripts, and report — do not fix.** Fixing is the
   orchestrator's job, done with full context across all 3 agents' reports at once
   (duplicate root causes across agents get one fix, not three).
5. **Report only confirmed, reproducible bugs**, each with exact repro steps,
   expected vs. actual behavior, and a severity. Explicitly list areas checked and
   found clean, in one line each — silence about an area is not the same as "checked
   and clean." Do not report design opinions, code-style nitpicks, or unverified
   suspicions.

### Per-round process (repeat for each of the 10 rounds)

1. Launch the round's 3 agents in parallel (single message, 3 `Agent` tool calls),
   using the template below filled in with that round's area description.
2. Wait for all 3 completion notifications. Do not guess or predict findings before
   they land.
3. Consolidate: list every confirmed bug across all 3 reports, prioritized by
   severity (data loss / silent corruption first, then broken core flows, then
   accessibility, then cosmetic).
4. Fix each one directly in the source. For each fix:
   - Find the actual root cause (read the surrounding code, check git blame/history
     if a comment implies this was already considered once).
   - Match the codebase's own established patterns for the same class of bug
     (in-flight guards look like `reactionBusy`/`followBusy`; live-synced draft
     fields look like `inviteCodeDraft`; persisted disclosure state looks like
     `state.admin.openAreas`; confirm+undo looks like `askDeleteEntry`/
     `restoreEntry`) rather than inventing a new shape.
   - Write a regression test for it — prefer a node-level test (`test/*.test.mjs`,
     via `bootApp()`/`bootCommunity()` + `createMockSupabase()`) when the bug is
     about state/logic; write or extend a `scripts/browser-check/*.mjs` script when
     the bug is about real rendering, geometry, or gesture-level behavior jsdom
     cannot see. Pair every fix-proving assertion with a control that shows the
     check would have failed before the fix, wherever that's cheap to add.
   - Add a short, dated code comment at the fix site (`// Live bug hunt (<date>): ...`)
     explaining what was live-reported, the root cause, and why this shape of fix.
5. Run the full verification pass, in order, fixing anything that regresses before
   proceeding:
   - `npm test` (must be 100% green; note the before/after test count)
   - `node scripts/browser-check/run-all.mjs` (must be 100% green; a single flaky
     failure — typically `community-render-cost.mjs`'s CPU-throttled timing check —
     should be re-run standalone once before treating it as real)
   - `npm run check-version && npm run check-vendor-version`
6. Bump `APP_VERSION` in `app.js` past whatever is currently on `origin/main` (check
   via `git fetch origin main` first — this is a shared working tree with other
   concurrent sessions), run `npm run sync-version`, then re-run `npm test` once more
   since the version bump touches `app.js`/`sw.js`.
7. Add a `CHANGES.md` entry (prepended, newest-first, matching the existing entries'
   voice) and commit with a message following the same structure, ending with the
   `Co-Authored-By`/`Claude-Session` trailer this repo's commits already use.
8. `git fetch origin main` again immediately before pushing (concurrent sessions may
   have pushed since step 6) and push. If `origin/main` has moved, reconcile
   (re-verify no conflicting changes) before pushing, don't force.
9. Report the round's findings and fixes back to the user in a short summary, then
   proceed to the next round's agents.

After round 10, give one final consolidated summary covering all of Part 1: total
confirmed bugs found and fixed, by round and by severity, and which areas (if any)
were only lightly covered and would benefit from yet another round. Then move to
Part 2.

### Agent prompt template (fill in `{AREA}`, `{SCOPE}`, `{EXISTING_COVERAGE}` per area)

```
You are hunting for REAL, REPRODUCIBLE, LIVE bugs in a buildless vanilla-JS
Hebrew/RTL offline-first PWA called "Haimunia" (האימוניה) — a gym training-log app
with an opt-in "Community" social layer backed by Supabase. Repo root:
/home/shahafrachmany/Desktop/Project/haimunia-app-demo-publish. Main files: app.js
(offline training log), cloud.js (opt-in Community/Supabase layer, its own IIFE),
index.html, sw.js.

Several earlier rounds of agents already found and fixed real bugs elsewhere in
this app this session (see CHANGES.md's "live bug hunt" entries and recent git
log for what's already been covered — do not re-test those areas). Your job is:
{AREA}.

YOUR SCOPE:
{SCOPE}

HOW TO RUN THE APP:
{EXISTING_COVERAGE — name the specific existing browser-check/test files to read
first for conventions and to avoid duplicate reports}
- `resolveLocalOnlyTarget()` / `resolveTarget()` from scripts/browser-check/lib/target.mjs
  for a throwaway local static server.
- `installMockCloud(page)` from scripts/browser-check/lib/mockCloud.mjs is MANDATORY
  before `page.goto(...)` — NEVER let anything reach the real production Supabase
  project, no exceptions.
- scripts/browser-check/lib/actions.mjs has shared helpers (dismissWelcomeModal,
  switchTab, openSettings, clickOverlayBackdrop, etc.) — reuse them.
- Playwright/chromium already installed; write throwaway scratch scripts to drive
  the app live.

Actually load pages and interact with them in a real rendered browser — do not
just read source and guess. Try normal paths AND edge cases (empty states, very
long text, RTL+number+English mixed strings, rapid double-taps, opening a dialog
while another is open, offline transitions, viewport/zoom changes, keyboard-only
navigation where relevant to your area). Do not report design opinions or
unverified suspicions, and do not attempt fixes.

For each CONFIRMED bug: exact repro steps, expected vs actual behavior, file/line
if you found the root cause, and severity (blocks a core flow / silent data loss /
annoying-but-workaroundable / cosmetic). If an area checks out clean, say so
briefly rather than inventing something. Report a prioritized, evidence-based list.
```

## Round assignments (Part 1)

**Rounds 1-2: already run.** See `CHANGES.md` for the full findings/fixes (15 bugs):
core training log, achievements, notifications, back-button; Community member-facing
surfaces (Feed, challenges, events, directory, privacy, onboarding); Community
coach/admin surfaces (Manage, moderation, audit log, roster, pins, coach dashboard,
recaps); offline-first sync/service-worker lifecycle; settings/accessibility/
keyboard navigation; Club WOD board + invite management + desktop layout.

**Round 3 — gamification, workout data depth, and search/discovery.**
- Agent A: **Achievements & streaks deep-dive.** Badge-unlock edge cases across all
  six categories, streak calculation around timezone/DST/midnight boundaries, PR
  detection edge cases (a tie, a unit/weight-increment boundary, editing a PR down
  vs. up), the "next up" nudge's own math, celebration/animation timing when two
  achievements unlock from one save. Read `test/achievements.test.mjs`,
  `test/community-achievement-engine.test.mjs`, `test/community-pr-share-prompt.test.mjs`
  first.
- Agent B: **WOD/benchmark catalogue depth.** EMOM builder edge cases (0 rounds, a
  movement removed mid-build), superset/ladder edge cases (ending a ladder
  mid-rung, switching exercise mid-superset), editing vs. deleting a custom WOD
  that already has logged history, the WOD glossary, benchmark-history comparison
  view. Read `test/duration-entries.test.mjs`, `test/superset-blocks.test.mjs`,
  `scripts/browser-check/emom.mjs`, `scripts/browser-check/ladder.mjs`,
  `scripts/browser-check/superset.mjs`, `scripts/browser-check/benchmarks.mjs` first.
- Agent C: **Search & discovery.** Movement-picker search/autocomplete edge cases,
  WOD picker search, Community's member/post search, the member directory's
  search-vs-empty-state distinction (already partly fixed for roster — check
  whether the same class of bug exists elsewhere search is used). Read
  `scripts/browser-check/community-search.mjs`,
  `test/community-members-directory.test.mjs` first.

**Round 4 — notifications, moderation depth, and data-integrity edges.**
- Agent D: **Notifications deep-dive.** Push-notification permission flow, in-app
  notification center batching rules under real timing (not just mocked-instant),
  deep-link resolution for every notification type, per-type preference toggles
  actually suppressing the right things, the header bell vs. Community bell
  routing under rapid unread-count changes. Read
  `scripts/browser-check/community-notification-center.mjs`,
  `test/community-notifications.test.mjs` first.
- Agent E: **Moderation & blocking depth.** Block/unblock edge cases (blocking
  someone mid-conversation, a blocked user's older content), report escalation and
  re-reporting the same content, comment edit/delete cascades (deleting a parent
  comment with live replies), mention notifications after a block. Read
  `scripts/browser-check/community-report-moderation.mjs`,
  `test/community-moderation.test.mjs`, `test/community-engagement-cluster.test.mjs`
  first.
- Agent F: **Data-integrity edges.** Import of a malformed/huge/special-character
  backup file (beyond what `test/import.test.mjs` already covers — go further:
  concurrent edits from two tabs of the SAME device/session, rapid tab-switching
  mid-save, a render throwing mid-frame). Read `test/import.test.mjs` first.

**Round 5 — visual/theme regressions, onboarding depth, and resilience.**
- Agent G: **Theme & visual regression across the whole app.** Light/dark theme
  switching mid-session on every major screen and open dialog, RTL+LTR mixed
  content beyond what `bidi-rtl-geometry.mjs` covers, tablet-width viewports
  (between the mobile and 900px/1280px breakpoints — an under-tested gap), print
  styles if any exist. Read `scripts/browser-check/bidi-rtl-geometry.mjs`,
  `scripts/browser-check/chart-rtl-orientation.mjs`,
  `scripts/browser-check/desktop-layout.mjs` first.
- Agent H: **Onboarding & account-recovery depth.** Fresh-install edge cases beyond
  `first-run-sequence.mjs`/`roadmap.mjs`, invite-code edge cases (malformed,
  whitespace, already-used, wrong club), anonymous-to-real-account upgrade, account
  recovery/re-verification flows. Read `scripts/browser-check/first-run-sequence.mjs`,
  `scripts/browser-check/community-person-invite-lifecycle.mjs`,
  `test/community-rls-boundaries-phase1.test.mjs` first.
- Agent I: **Resilience under stress.** Rapid repeated dialog open/close (memory/
  listener leaks, not just the single-open-close cases already tested), a slow/
  flaky network simulated via Playwright route interception, console errors under
  sustained interaction (50+ actions in one session), the app's own error-boundary
  behavior when a render function throws mid-frame. No specific existing file to
  read first — this agent's job is explicitly to go where the others haven't.

**Round 6 — internationalization, content edge cases, and units.**
- Agent J: **Hebrew grammar & RTL content depth.** Plural/dual forms in every
  generated string (1 vs. 2 vs. many — the "1 יום ברצף" class of bug already fixed
  once), gender agreement in generated sentences (coach/member names combined with
  Hebrew verb conjugation), number formatting (thousands separators, negative
  numbers, decimals) rendered inside RTL text. Read `test/fresh-eyes-ux-fixes.test.mjs`
  (the streak-grammar fix) and grep app.js/cloud.js for every template literal that
  pluralizes a count first.
- Agent K: **Extreme content values.** Emoji-only display names, zero-width/
  combining Unicode characters in any text field, a single "word" thousands of
  characters long with no spaces (overflow), RTL+emoji+English all mixed in one
  string, control characters pasted into a text input. Read `src/sanitize.js`'s
  `cleanStr` and its length caps first.
- Agent L: **Units, dates, and locale formatting.** Every date/time display for
  timezone correctness (a workout logged just before/after local midnight, DST
  transition days), weight units consistency (kg only, or is there a toggle
  anywhere it could desync), any place a raw ISO string leaks into the UI
  unformatted.

**Round 7 — cross-tab, multi-window, and concurrent-session behavior.**
- Agent M: **Same account, two tabs.** Open the same signed-in session in two
  Playwright pages sharing the same storage; perform an action in one (log a set,
  post to the feed) and check whether the other tab's UI goes stale, shows a
  conflicting state, or actually needs a manual refresh to be safe.
- Agent N: **Interrupted async operations.** Close/navigate away from a tab mid-save
  (a set being saved, a photo mid-upload, an RPC in flight) and reopen — is the
  operation cleanly lost, cleanly completed, or left in a half-done, confusing
  state (a queued outbox row with no way to see it succeeded, a photo stuck
  "uploading" forever).
- Agent O: **Storage-quota and IndexedDB edge cases.** Simulate IndexedDB write
  failures (quota exceeded, a blocked/blocked-by-another-tab upgrade) and confirm
  the app surfaces a real error rather than silently losing the write or hanging.

**Round 8 — analytics, dashboards, and numeric accuracy.**
- Agent P: **Admin analytics dashboard accuracy.** Cross-check every displayed
  aggregate (active members, engagement rate, whatever the dashboard shows)
  against the actual underlying seeded data, not just that a number renders —
  construct a known dataset and verify the math, including edge cases (zero
  activity, a single outlier skewing an average).
- Agent Q: **Recap content accuracy.** Weekly/monthly recap generation for a
  period with zero activity, partial-week/partial-month boundary dates, a member
  who joined mid-period, DST-boundary weeks.
- Agent R: **Leaderboard/ranking accuracy.** Tie-breaking rules when two members
  have identical scores, a member who opts out of leaderboards mid-period, a
  removed/moderated result still counting toward a ranking it shouldn't.

**Round 9 — long-term data lifecycle.**
- Agent S: **Multi-year history performance and correctness.** Seed several
  thousand entries spanning years; check chart rendering (does it mislabel/
  misorder anything at scale), calendar navigation across many years, and that
  the newest-entries-first sort stays correct at volume.
- Agent T: **Data completeness on export/deletion.** Export a backup for an
  account with data in every feature area and verify nothing is silently missing;
  confirm "delete all data" (already partly fixed this session) truly removes
  everything it claims to, including any Community-side mirrored data if
  applicable.
- Agent U: **Multi-version upgrade paths.** Simulate a very old cached app version
  jumping straight to current (skipping intermediate versions) — do any one-time
  migrations/flags that assume sequential version bumps break when versions are
  skipped.

**Round 10 — cross-feature interaction and final full-app sweep.**
- Agent V: **Feature-interaction matrix.** Combinations that individually work but
  might conflict: editing a set while a celebration overlay is animating,
  achievements unlocking while offline (does the celebration fire on reconnect or
  get lost), opening the WOD builder while a save toast is still showing, switching
  tabs mid-ladder.
- Agent W: **Throttled-network full walkthrough.** Every screen, network throttled
  to slow-3G via Playwright, watching specifically for a spinner-forever or
  dead-click state with no timeout/error feedback.
- Agent X: **Final fresh-eyes sweep.** One full walkthrough as a brand-new user
  with zero data, and one as a multi-year power user with heavy data, back to
  back in the same report — catch anything the 27 specialized agents before it
  missed by simply using the app end to end, the way persona reviews earlier this
  project did.

---

# PART 2 — SECURITY HUNT (10 ROUNDS)

Do not start Part 2 until Part 1's 10 rounds are fully committed and pushed.

## THE PROMPT (Part 2 — copy from here down to start security rounds)

Run 10 rounds of live security hunting against this app. Each round: spawn 3
parallel fresh agents (no memory of prior rounds — new `Agent` calls, `subagent_type:
"general-purpose"`), each assigned one area from the round's list below. Wait for all
3 to report. Consolidate the findings into one prioritized list (by real-world
impact, not by how interesting the finding sounds). Fix every confirmed
vulnerability directly, each with its own regression test that fails against the
vulnerable code and passes against the fix. Run the full verification pass. Commit
and push. Only then start the next round.

Before round 1, check `CHANGES.md` and `git log` for prior "security hunt" entries —
if rounds have already run, skip their areas and continue from the next unused round
below.

### Non-negotiable rules for every agent — read this section twice

1. **NEVER touch the real production Supabase project. Not read-only, not "just
   checking," not even a single request.** `cloud-config.js` points at a live,
   real club's data — testing security against it is not authorized under any
   framing, including "it's the team's own app." Every single scenario in every
   round runs against `installMockCloud(page)` (local mock backend,
   `scripts/browser-check/lib/mockCloud.mjs`) and/or a **local** Postgres instance
   reached via `supabase test db` / the Supabase CLI's local stack (`supabase
   start` — DB_URL `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) —
   never `cloud-config.js`'s real URL, never a real anon/service key. If an agent is
   ever unsure whether a request would reach production, it must stop and ask
   rather than guess.
2. **This is authorized, defensive testing of the team's own application**, run to
   find and close real gaps before anyone else does — not a pentest of a third
   party, not for any offensive purpose. Every agent should reason from that
   footing: the goal is "what would a real attacker try against this exact app,"
   not "how creative can the exploit be."
3. **A finding is not confirmed until it's actually reproduced** — a real request
   made, a real response observed, a real unauthorized read/write/action that
   happened. "The code looks like it might allow X" is a lead, not a finding; chase
   it to an actual repro or drop it.
4. **Client-side checks are not the security boundary — RLS and RPC-side checks
   are.** A client-side `hasPerm()` gate hiding a button is a UX nicety; the finding
   that matters is whether the underlying RPC/table actually refuses the action when
   called directly (via `client.rpc(...)`/`client.from(...).select()` etc. from the
   page console or a scratch script), bypassing the UI entirely. Every agent should
   test at that level, not just "does the button show."
5. **State clearly which layer a finding was verified against.** Testing against
   `installMockCloud`'s mock only proves CLIENT behavior — the mock's RLS/RPC
   approximations are hand-written JS, not real Postgres policy enforcement, and can
   both over- and under-restrict compared to the real thing. A finding about real
   authorization enforcement is only trustworthy once reproduced against a **local
   real Postgres** instance — prefer that path for anything in the "authorization/
   RLS," "IDOR," or "privilege escalation" areas below, and say explicitly in the
   report which layer each finding was confirmed against.
6. **Read what already exists first** — the specific existing test/audit files named
   per area below, plus `scripts/audit-role-coverage.mjs` and `supabase/tests/*.sql`
   — so nothing gets re-reported, and so the agent learns this app's own conventions
   (SECURITY DEFINER functions, `has_perm()`, the permission tiers in
   `AUTHORIZATION_MATRIX.md`).
7. **Report only confirmed, reproducible vulnerabilities and do not fix.** For each:
   exact repro (the actual request/payload/sequence), what it should have done vs.
   what it actually did, the verification layer (mock vs. real local Postgres), and
   a severity using impact × exploitability reasoning (not just a label). List areas
   checked and found clean too, one line each.

### Per-round process (repeat for each of the 10 rounds)

1. Launch the round's 3 agents in parallel. Wait for all 3. Do not predict findings.
2. Consolidate every confirmed vulnerability, prioritized by real-world impact.
3. Fix each one:
   - **Client-only issues** (missing/wrong permission gate, sensitive data rendered
     when it shouldn't be, a secret in localStorage/URL/console) get fixed directly
     in `app.js`/`cloud.js`/`index.html`.
   - **Authorization/RLS findings** need a real schema fix — a new migration under
     `supabase/migrations/` (never edit an already-applied migration in place) with
     a matching pgTAP test in `supabase/tests/` that fails against the old policy
     and passes against the new one, confirmed via `supabase test db` against real
     local Postgres.
   - Match the codebase's own established patterns where relevant.
   - Add a short dated comment at the fix site: `// Security hunt (<date>): ...`.
4. Verification: `npm test` (100% green), `node scripts/browser-check/run-all.mjs`
   (100% green), `supabase test db` if any migration changed this round (100%
   green against real local Postgres, plus a migration-immutability check), `npm
   run check-version && npm run check-vendor-version`.
5. Bump `APP_VERSION`, `npm run sync-version`, re-run `npm test` once more.
6. `CHANGES.md` entry describing the vulnerability CLASS and the defensive fix —
   not a step-by-step exploit walkthrough (public repo history). Commit with the
   `Co-Authored-By`/`Claude-Session` trailer.
7. `git fetch origin main` before pushing; reconcile if it moved, then push.
8. Report the round's findings back to the user, then proceed to the next round.

After round 10, give one final consolidated summary covering all of Part 2: total
confirmed vulnerabilities by severity across all 10 rounds, which findings were
verified against real local Postgres vs. mock-only, and a closing statement on
overall security posture with anything that would benefit from a follow-up round or
an eventual authorized check against a staging environment.

### Agent prompt template (fill in `{AREA}`, `{SCOPE}`, `{EXISTING_COVERAGE}` per area)

```
You are doing AUTHORIZED, DEFENSIVE security testing of "Haimunia" (האימוניה), a
buildless vanilla-JS Hebrew/RTL offline-first PWA gym training-log app with an
opt-in "Community" social layer backed by Supabase (Postgres + RLS). This is the
team's own application, tested to find and close real gaps before anyone else
does. Repo root: /home/shahafrachmany/Desktop/Project/haimunia-app-demo-publish.
Main files: app.js (offline log), cloud.js (Community layer, its own IIFE, ~19000
lines), index.html, sw.js, supabase/migrations/ (schema + RLS), supabase/tests/
(pgTAP).

ABSOLUTE RULE, NO EXCEPTIONS: NEVER send any request to the real production
Supabase project. cloud-config.js points at a live club's real data. Every
scenario you run uses installMockCloud(page) (scripts/browser-check/lib/mockCloud.mjs)
for client-behavior testing, and/or a LOCAL Postgres instance via `supabase test
db` / a local `supabase start` stack for real RLS/policy testing. If you are ever
unsure whether something would reach production, STOP and say so instead of
proceeding.

Several earlier rounds already covered other areas this session (see CHANGES.md's
"security hunt" entries and recent git log) — do not re-test those.

YOUR SCOPE: {AREA}
{SCOPE}

METHODOLOGY:
- Test at the level that actually matters: not just "is the button hidden" but
  "does calling the underlying client.rpc(...)/client.from(...) call directly
  (bypassing the UI) still get refused." Use the browser console or a throwaway
  Playwright/node scratch script to fire these calls directly, with a signed-in
  session at whatever permission level is relevant (a plain member, a coach, an
  unauthenticated/anonymous session) trying to do something above that level.
- For anything about authorization, RLS, IDOR, or privilege escalation: prefer
  testing against real local Postgres (`supabase test db`, or read
  supabase/tests/*.sql for how existing pgTAP scenarios set up real JWTs per role)
  over the mock. If you only have time to test via mock, say so explicitly and
  flag the finding as needing real-DB confirmation before it's trusted.
- {EXISTING_COVERAGE — name the specific existing test/audit files to read first}
- Try both the "obvious" attack (wrong role attempts the gated action) and the
  "sideways" one (right role, but for someone ELSE's data/club/record).

Report only CONFIRMED vulnerabilities (an actual unauthorized read/write/action
that happened), not suspicions. For each: exact repro (the real request/payload),
expected vs. actual, which layer you verified it against (mock vs. real local
Postgres), and severity (impact × exploitability, in a sentence, not just a label).
List areas checked and found clean too. Do not attempt fixes.
```

## Round assignments (Part 2)

**Round 1 — authorization boundaries, injection, and data exposure.**
- Agent A: **Authorization / RLS boundary testing.** For every table and RPC a
  member-tier session can reach, try reaching it as a lower role, as a different
  club's member (if multi-club data exists anywhere), and as an anonymous/
  unauthenticated session — direct `client.from(...)`/`client.rpc(...)` calls, not
  just UI clicks. Read `AUTHORIZATION_MATRIX.md`, `test/community-rls-boundaries-phase1.test.mjs`,
  and `supabase/tests/*.sql` first; use `supabase test db` for anything this mock
  can't faithfully represent.
- Agent B: **XSS / injection surface.** Every point user- or attacker-controlled
  text reaches the DOM — display names, bios, post/comment bodies, WOD/movement
  names, note fields, URL query params consumed at boot (`?notif=`, `?invite=`),
  imported backup file contents. `test/app-innerhtml-sinks.test.mjs` already pins
  "cloud.js has zero innerHTML sinks" and "every app.js sink is escaped" — try to
  find a NEW sink or a bypass of `esc()`. Read that file and
  `src/shared/safe-helpers.js`'s `esc()` first.
- Agent C: **Sensitive-data exposure.** Credentials/tokens/invite-codes/session
  data in the URL bar, browser history, localStorage/IndexedDB, console.log
  output, or error messages surfaced to the UI. Check the existing
  credential-scrubbing pattern (`captureInviteDeepLink()`, the `?notif=` cleanup,
  the history-anchor fix) for anywhere else the same class of leak might exist.

**Round 2 — business-logic abuse and object-reference integrity.**
- Agent D: **Business-logic abuse / rate-limit bypass.** For every action with a
  stated limit or cooldown (pin cap of 3, invite-code max_uses, PR-share cooldown,
  achievement congratulate-once, moderation rate limits) — fire the underlying
  RPC directly and rapidly (concurrent/looped calls, not one click) and see
  whether the limit is enforced server-side or only by a client-side in-flight
  guard a raw script trivially skips.
- Agent E: **IDOR / direct-object-reference integrity.** Take every RPC/table read
  or write that accepts an id (record, post, user, club) and try swapping it for
  one belonging to someone else — does the server actually scope the operation to
  the caller, or trust the client-supplied id?
- Agent F: **File-upload security.** Avatar/photo upload: file-type validation
  (disguised executable/script with an image extension), oversized files, EXIF/
  metadata leakage, filename-based path traversal or stored-XSS-via-filename,
  whether uploaded files are served from a properly scoped/randomized path.

**Round 3 — authentication, privilege escalation, and client posture.**
- Agent G: **Authentication & account-recovery abuse.** Account enumeration via
  differing error messages (login/signup/password-reset), timing differences
  revealing whether an email/handle exists, invite-code brute-forcing (rate
  limiting, code entropy), the anonymous-to-real-account upgrade path (hijack/
  replay risk), session fixation across sign-out/sign-in.
- Agent H: **SECURITY DEFINER / privilege-escalation testing.** Every
  SECURITY DEFINER Postgres function this app calls (grep `supabase/migrations/`
  for `SECURITY DEFINER`) — does it re-validate the caller's actual permission for
  EVERY code path it can take, not just the one the client UI happens to drive it
  down?
- Agent I: **Client-side security posture.** CSP effectiveness (test with a real
  injected inline script/external fetch attempt), confirm RLS — not key secrecy —
  is what protects data, verbose error messages leaking schema/internals,
  service-worker cache-poisoning surface.

**Round 4 — moderation-bypass, data-tampering, and resource exhaustion.**
- Agent J: **Moderation/abuse-bypass.** Can a blocked user still reach the person
  who blocked them through mentions, notifications, a shared challenge/event
  roster, or a cached feed? Does removed/moderated content leak through a
  notification's stored text, a cache, or search after removal? Can a restricted
  member still perform the restricted action via a direct RPC call?
- Agent K: **Client-side data tampering.** Fields the SERVER should compute
  (isPR, is_admin/role, achievement-unlock state, timestamps, permission-derived
  flags) — does any write path accept a client-supplied value instead of deriving
  it server-side? Send a forged value in an RPC/insert payload and see if it's
  accepted.
- Agent L: **Resource exhaustion from malicious input.** Oversized payloads
  (multi-MB comment/note bypassing client-side caps via direct RPC calls), a
  deeply nested/huge imported backup JSON, a decompression-bomb-shaped import, an
  input crafted to trigger a pathological/slow client-side code path.

**Round 5 — third-party surface, PWA-specific attack surface, and defense-in-depth.**
- Agent M: **Third-party & supply-chain review.** The vendored
  `vendor/supabase.js` (already integrity-pinned — confirm the check would
  actually catch a tampered file), any CDN/external script or font load, any
  `postMessage`/iframe surface, known-CVE relevance of dependency versions.
- Agent N: **PWA/service-worker attack surface.** Cache poisoning, service-worker
  scope confusion, the update mechanism (confirm a malicious/corrupted update
  can't silently install), offline-queued-write tampering.
- Agent O: **Defense-in-depth / assume-breach review.** Deliberately disable or
  bypass EVERY client-side check one at a time (via console, editing state/module
  variables directly) for the most sensitive actions found across rounds 1-4, and
  confirm the server actually stops each action, not just the client UI.

**Round 6 — cryptography and secrets handling.**
- Agent P: **Password/credential handling.** Confirm the client never logs,
  transmits, or stores plaintext credentials insecurely; review password-reset
  token handling for reuse/expiry/leakage in the URL; check that any
  "remember me"-style persistence doesn't store a raw reusable credential.
- Agent Q: **Client-side "security theater" review.** Any localStorage/IndexedDB
  value that looks obfuscated/encoded but isn't actually protecting anything
  (base64 is not encryption) — confirm nothing sensitive relies on that as its
  only protection.
- Agent R: **Session/JWT handling.** Expiry enforcement (does an expired session
  token get silently accepted anywhere), refresh-token security, whether a
  tampered/malformed JWT is cleanly rejected rather than causing undefined
  behavior client-side.

**Round 7 — API/RPC contract abuse.**
- Agent S: **Malformed/unexpected-type RPC parameters.** Send a string where a
  number is expected, an array where a scalar is expected, `null` where required,
  extra unexpected fields, deeply nested objects — for every RPC this app calls,
  does the server reject cleanly, crash, or leak an internal error?
- Agent T: **Race conditions in multi-step operations.** Any flow where RPC A must
  logically precede RPC B (e.g. redeem-then-profile-setup, create-then-publish) —
  call B first, or both concurrently, and see whether server-side ordering is
  actually enforced or just assumed from client sequencing.
- Agent U: **Webhook/Edge Function security**, if any exist in this project
  (check for Supabase Edge Functions / webhooks) — signature verification, replay
  protection, whether an unauthenticated request can trigger one.

**Round 8 — social-engineering-adjacent and UI-redressing risks.**
- Agent V: **Clickjacking / UI-redressing.** Test whether the app can be framed
  by an external page (X-Frame-Options/frame-ancestors effectiveness) and whether
  a transparent overlay could plausibly trick a click.
- Agent W: **Impersonation via attacker-controlled content.** Can a display name,
  post, or announcement be crafted (via allowed characters/formatting) to
  convincingly impersonate system UI, an official announcement, or another real
  member?
- Agent X: **Open-redirect surfaces.** Every place a redirect or navigation
  depends on user-controlled input (deep links, invite links, notification
  `deep_link` values, the `?notif=`/`?invite=` boot params) — can any of them be
  crafted to navigate somewhere unintended?

**Round 9 — infrastructure-adjacent configuration review.**
- Agent Y: **HTTP security headers.** What does the actually-served response
  carry (HSTS, X-Content-Type-Options, Referrer-Policy, CSP) versus what
  `index.html`'s own meta tags/comments claim — check both the local static
  server's real response headers and whatever hosting config exists in the repo
  (`docs/deploy/`).
- Agent Z: **Service worker / manifest scope review.** Is `sw.js`'s registration
  scope broader than it needs to be; does `manifest.json` request any permission
  it doesn't use; can the SW be tricked into caching or serving something outside
  its intended scope.
- Agent AA: **Telemetry/analytics data review.** Every `track()` call site — does
  any event payload capture something it shouldn't (a raw name, a message body, a
  precise location, anything PII-shaped) that wouldn't survive a "what does our
  analytics provider actually receive" audit?

**Round 10 — final full-application penetration-style sweep.**
- Agent BB: **Finding-chaining review.** Take every finding confirmed across
  rounds 1-9 (read the accumulated `CHANGES.md` "security hunt" entries) and
  check whether any two lower-severity issues compose into something higher —
  e.g., a data-exposure finding plus a session-handling gap chaining into account
  takeover.
- Agent CC: **Structured OWASP Top 10 pass.** Go through A01–A10 (Broken Access
  Control, Cryptographic Failures, Injection, Insecure Design, Security
  Misconfiguration, Vulnerable/Outdated Components, Identification & Auth
  Failures, Software & Data Integrity Failures, Logging & Monitoring Failures,
  SSRF) one at a time against this specific app, and for each category state
  explicitly whether it applies here, what was checked, and the verdict — even
  where "not applicable" is the honest answer, say why.
- Agent DD: **Unconstrained adversarial pass.** Given everything found in rounds
  1-9, spend this round trying to build ONE actual account-takeover or
  full-data-exposure chain end to end, not constrained to any single category —
  the closest thing to "how would a real, motivated attacker actually try to
  break this app."

---

## What "done" looks like

Part 1 ends with 10 rounds of confirmed functional/UX bugs, each fixed and
regression-tested, fully committed and pushed. Part 2 then runs the same way for
security. The whole 20-round run ends with two final summaries (one per part) and,
if Part 2 surfaces anything that genuinely needs production-representative
verification, a clear note on that rather than testing it against the real project.
