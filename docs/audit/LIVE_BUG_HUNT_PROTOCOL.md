# Live Bug Hunt Protocol — 5 rounds, fresh agents, fix-then-advance

Reusable instruction set for finding and fixing real, reproducible, LIVE bugs across
the whole Haimunia app — not a code review, actual hands-on interaction with the
rendered app in a real browser. Built from two rounds already run this way (see
CHANGES.md, entries "A full site-wide live bug hunt..." and "A second live bug hunt
round..." — 15 confirmed bugs found and fixed across those two rounds alone). This
document is the reusable prompt: paste the block below (or the whole file) to an
orchestrating Claude Code session to run the next round(s).

---

## THE PROMPT (copy from here down)

Run 5 rounds of live bug hunting against this app. Each round: spawn 3 parallel
fresh agents (no memory of prior rounds — new `Agent` calls, `subagent_type:
"general-purpose"`, never `"fork"`), each assigned one area from the round's list
below. Wait for all 3 to report. Consolidate the findings into one prioritized list.
Fix every confirmed bug directly, each with its own regression test. Run the full
verification pass. Commit and push. Only then start the next round. Do not run two
rounds' agents concurrently — round N+1's areas may depend on round N's fixes
already being live.

Before round 1 of THIS invocation, check `CHANGES.md` and `git log` for prior "live
bug hunt" entries — if rounds have already run in this repo, skip their areas and
continue from the next unused round in the assignment list below. Do not re-hunt an
area that already has a dedicated fix + regression test on `main`.

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

### Per-round process (repeat for each of the 5 rounds)

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
     explaining what was live-reported, the root cause, and why this shape of fix —
     matching the existing comments already in the codebase from rounds 1-2.
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
   voice: what was reported/found, root cause, why this fix shape, verification
   numbers) and commit with a message following the same structure, ending with the
   `Co-Authored-By`/`Claude-Session` trailer this repo's commits already use.
8. `git fetch origin main` again immediately before pushing (concurrent sessions may
   have pushed since step 6) and push. If `origin/main` has moved, reconcile
   (re-verify no conflicting changes) before pushing, don't force.
9. Report the round's findings and fixes back to the user in a short summary, then
   proceed to the next round's agents.

After round 5, give one final consolidated summary: total confirmed bugs found and
fixed across all 5 rounds, and which areas (if any) were only lightly covered and
would benefit from a future round.

### Agent prompt template (fill in `{AREA}`, `{SCOPE}`, `{EXISTING_COVERAGE}` per area)

```
You are hunting for REAL, REPRODUCIBLE, LIVE bugs in a buildless vanilla-JS
Hebrew/RTL offline-first PWA called "Haimunia" (האימוניה) — a gym training-log app
with an opt-in "Community" social layer backed by Supabase. Repo root:
<absolute path>. Main files: app.js (offline training log), cloud.js (opt-in
Community/Supabase layer, its own IIFE), index.html, sw.js.

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

---

## Round assignments

**Rounds 1-2: already run.** See `CHANGES.md` for the full findings/fixes (15 bugs):
- Round 1: core training log (Add/Log, History, Progress, WOD/Library, achievements,
  notifications, back-button); Community member-facing surfaces (Feed, challenges,
  events, directory, privacy, onboarding); Community coach/admin surfaces (Manage,
  moderation, audit log, roster, pins, coach dashboard, recaps).
- Round 2: offline-first sync/service-worker lifecycle (outbox, remote-record apply,
  data migration, update handshake, offline mid-action, import/export, multi-device
  conflict); settings/accessibility/keyboard navigation; lightly-covered admin areas
  (Club WOD board, invite management) + desktop (≥900px) layout.

**Round 3 — gamification, workout data depth, and search/discovery.**
- Agent A: **Achievements & streaks deep-dive.** Badge-unlock edge cases across all
  six categories, streak calculation around timezone/DST/midnight boundaries, PR
  detection edge cases (a tie, a unit/weight-increment boundary, editing a PR down
  vs. up), the "next up" nudge's own math, celebration/animation timing when two
  achievements unlock from one save. Read `test/achievements.test.mjs`,
  `test/community-achievement-engine.test.mjs`, `test/community-pr-share-prompt.test.mjs`
  first.
- Agent B: **WOD/benchmark catalogue depth.** EMOM builder edge cases (0 rounds,
  a movement removed mid-build), superset/ladder edge cases (ending a ladder
  mid-rung, switching exercise mid-superset), editing vs. deleting a custom WOD
  that already has logged history, the WOD glossary, benchmark-history comparison
  view. Read `test/duration-entries.test.mjs`, `test/superset-blocks.test.mjs`,
  `scripts/browser-check/emom.mjs`, `scripts/browser-check/ladder.mjs`,
  `scripts/browser-check/superset.mjs`, `scripts/browser-check/benchmarks.mjs` first.
- Agent C: **Search & discovery.** Movement-picker search/autocomplete edge cases,
  WOD picker search, Community's member/post search (`community-search.mjs`), the
  member directory's search-vs-empty-state distinction (already partly fixed for
  roster — check whether the same class of bug exists elsewhere search is used).
  Read `scripts/browser-check/community-search.mjs`,
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
  someone mid-conversation, a blocked user's older content), report escalation
  and re-reporting the same content, comment edit/delete cascades (deleting a
  parent comment with live replies), mention notifications after a block. Read
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

---

## What "done" looks like

Every round ends with: 3 agent reports consolidated, every confirmed bug fixed with
its own regression test, full suite + browser-check green, version bumped, committed,
and pushed to `origin/main` — before the next round's agents are even launched. The
whole 5-round run ends with one final summary covering all rounds' totals.
