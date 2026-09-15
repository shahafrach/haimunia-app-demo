# Live Security Hunt Protocol — 5 rounds, fresh agents, fix-then-advance

Reusable instruction set for finding and fixing real, reproducible SECURITY defects
across the whole Haimunia app — defensive security testing of the team's own
application, by hands-on exploitation attempts against a local mock backend and/or a
local real Postgres instance, never the live production Supabase project. Same
fix-then-advance shape as `LIVE_BUG_HUNT_PROTOCOL.md`, adapted for a security lens:
authorization boundaries, injection, data exposure, and abuse of business logic
instead of UX/functional correctness.

---

## THE PROMPT (copy from here down)

Run 5 rounds of live security hunting against this app. Each round: spawn 3 parallel
fresh agents (no memory of prior rounds — new `Agent` calls, `subagent_type:
"general-purpose"`), each assigned one area from the round's list below. Wait for all
3 to report. Consolidate the findings into one prioritized list (by real-world
impact, not by how interesting the finding sounds). Fix every confirmed vulnerability
directly, each with its own regression test that fails against the vulnerable code
and passes against the fix. Run the full verification pass. Commit and push. Only
then start the next round.

Before round 1 of THIS invocation, check `CHANGES.md` and `git log` for prior
"security hunt" entries — if rounds have already run, skip their areas and continue
from the next unused round below. Do not re-hunt an area that already has a dedicated
fix + regression test on `main`.

### Non-negotiable rules for every agent — read this section twice

1. **NEVER touch the real production Supabase project. Not read-only, not "just
   checking," not even a single request.** `cloud-config.js` points at a live,
   real club's data — testing security against it is not authorized under any
   framing, including "it's the team's own app." Every single scenario in every
   round runs against `installMockCloud(page)` (local mock backend,
   `scripts/browser-check/lib/mockCloud.mjs`) and/or a **local** Postgres instance
   reached via `supabase test db` / the Supabase CLI's local stack — never
   `cloud-config.js`'s real URL, never a real anon/service key. If an agent is ever
   unsure whether a request would reach production, it must stop and ask rather than
   guess.
2. **This is authorized, defensive testing of the team's own application**, run to
   find and close real gaps before anyone else does — not a pentest of a third
   party, not for any offensive purpose. Every agent should reason from that footing:
   the goal is "what would a real attacker try against this exact app," not "how
   creative can the exploit be."
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
   both over- and under-restrict compared to the real thing (this repo has hit both
   directions before — see `test/helpers/mockSupabase.mjs`'s own gap-fix history in
   `CHANGES.md`). A finding about real authorization enforcement is only trustworthy
   once reproduced against a **local real Postgres** instance (`supabase test db`,
   or a local `supabase start` stack with real RLS policies loaded) — prefer that
   path for anything in the "authorization/RLS," "IDOR," or "privilege escalation"
   rounds below, and say explicitly in the report which layer each finding was
   confirmed against.
6. **Read what already exists first** — the specific existing test/audit files named
   per area below, plus `scripts/audit-role-coverage.mjs` (a static permission-gate
   mismatch checker already built this session) and `supabase/tests/*.sql` (pgTAP
   coverage) — so nothing gets re-reported, and so the agent learns this app's own
   conventions (SECURITY DEFINER functions, `has_perm()`, the permission tiers in
   `AUTHORIZATION_MATRIX.md`).
7. **Report only confirmed, reproducible vulnerabilities and do not fix.** For each:
   exact repro (the actual request/payload/sequence), what it should have done vs.
   what it actually did, the verification layer (mock vs. real local Postgres), and
   a severity using impact × exploitability reasoning (not just a label) — e.g.
   "Critical: unauthenticated user can read any other member's private training
   history by guessing a UUID, no rate limit, no auth required" vs. "Low: an admin
   action's confirm-dialog wording could be clearer about scope, no actual
   unauthorized action possible." List areas checked and found clean too, one line
   each.

### Per-round process (repeat for each of the 5 rounds)

1. Launch the round's 3 agents in parallel (single message, 3 `Agent` tool calls),
   using the template below filled in with that round's area description.
2. Wait for all 3 completion notifications. Do not guess or predict findings before
   they land.
3. Consolidate: list every confirmed vulnerability across all 3 reports, prioritized
   by real-world impact — an authorization bypass or data exposure outranks a
   defense-in-depth gap that a second control already prevents in practice.
4. Fix each one directly:
   - **Client-only bugs** (missing/wrong `hasPerm()` gate, sensitive data rendered
     when it shouldn't be, a secret sitting in localStorage/URL/console) get fixed
     in `app.js`/`cloud.js`/`index.html` directly, same conventions as the UX
     protocol's fixes.
   - **Authorization/RLS findings** need a real schema fix — a new/corrected RLS
     policy or SECURITY DEFINER check in a new migration under `supabase/migrations/`
     (never edit an already-applied migration in place — this repo treats migrations
     as immutable once shipped, see `migration-immutability` checks). Write the
     matching pgTAP test in `supabase/tests/` and confirm it fails against the old
     policy and passes against the new one, run via `supabase test db` against real
     local Postgres — a mock-level test alone does not prove an RLS fix works.
   - Match the codebase's own established patterns (the same in-flight-guard,
     confirm+undo, and permission-check shapes referenced in the UX protocol still
     apply where relevant — e.g. a business-logic-abuse fix for a missing rate limit
     may be the exact same "busy guard" shape as the UX bugs, just motivated by
     abuse resistance instead of double-tap UX).
   - Add a short, dated code comment at the fix site
     (`// Security hunt (<date>): ...`) explaining what was found, the impact, and
     why this fix shape — matching the `// Live bug hunt (<date>): ...` comment
     convention already in the codebase.
5. Run the full verification pass, in order:
   - `npm test` (100% green)
   - `node scripts/browser-check/run-all.mjs` (100% green; re-run a lone flaky
     failure standalone once before treating it as real)
   - If any migration/schema file changed this round: `supabase test db` (100% green
     against real local Postgres) and a migration-immutability check
   - `npm run check-version && npm run check-vendor-version`
6. Bump `APP_VERSION`, `npm run sync-version`, re-run `npm test` once more.
7. Add a `CHANGES.md` entry (newest-first) describing the finding class and fix
   *without* publishing exploit-ready detail beyond what's needed to understand the
   fix (this file is public repo history) — describe the vulnerability class and the
   defensive change, not a step-by-step exploit walkthrough. Commit with the same
   `Co-Authored-By`/`Claude-Session` trailer convention.
8. `git fetch origin main` before pushing (shared working tree); reconcile if it
   moved, then push.
9. Report the round's findings and fixes back to the user in a short summary before
   proceeding to the next round's agents.

After round 5, give one final consolidated summary: total confirmed vulnerabilities
found and fixed by severity, which findings were verified against real local
Postgres vs. mock-only, and which areas would benefit from a follow-up round.

### Agent prompt template (fill in `{AREA}`, `{SCOPE}`, `{EXISTING_COVERAGE}` per area)

```
You are doing AUTHORIZED, DEFENSIVE security testing of "Haimunia" (האימוניה), a
buildless vanilla-JS Hebrew/RTL offline-first PWA gym training-log app with an
opt-in "Community" social layer backed by Supabase (Postgres + RLS). This is the
team's own application, tested to find and close real gaps before anyone else
does. Repo root: <absolute path>. Main files: app.js (offline log), cloud.js
(Community layer, its own IIFE, ~19000 lines), index.html, sw.js,
supabase/migrations/ (schema + RLS), supabase/tests/ (pgTAP).

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
  over the mock — the mock is a hand-written JS approximation of RLS, not real
  enforcement, and has had real gaps in both directions before. If you only have
  time to test via mock, say so explicitly and flag the finding as needing real-DB
  confirmation before it's trusted.
- {EXISTING_COVERAGE — name the specific existing test/audit files to read first}
- Try both the "obvious" attack (wrong role attempts the gated action) and the
  "sideways" one (right role, but for someone ELSE's data/club/record - the
  classic IDOR shape: does swapping an id in the request scope to a different
  target succeed when it shouldn't).

Report only CONFIRMED vulnerabilities (an actual unauthorized read/write/action
that happened), not suspicions. For each: exact repro (the real request/payload),
expected vs. actual, which layer you verified it against (mock vs. real local
Postgres), and severity (impact × exploitability, in a sentence, not just a label).
List areas checked and found clean too. Do not attempt fixes.
```

---

## Round assignments

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
  find a NEW sink or a bypass of `esc()` (a value that survives escaping and still
  executes), not just re-confirm the existing pin. Read that file and
  `src/shared/safe-helpers.js`'s `esc()` first.
- Agent C: **Sensitive-data exposure.** Credentials/tokens/invite-codes/session
  data in the URL bar, browser history, localStorage/IndexedDB (unencrypted?),
  console.log output, or error messages surfaced to the UI (a stack trace, a raw
  Postgres error naming a column/table). Check the existing credential-scrubbing
  pattern (`captureInviteDeepLink()`, the `?notif=` cleanup, this session's own
  history-anchor fix) for anywhere else the same class of leak might still exist.

**Round 2 — business-logic abuse and object-reference integrity.**
- Agent D: **Business-logic abuse / rate-limit bypass.** For every action that has
  a stated limit or cooldown (pin cap of 3, invite-code max_uses, PR-share
  cooldown, achievement congratulate-once, moderation action rate limits) - fire
  the underlying RPC directly and rapidly (concurrent/looped calls, not one click)
  and see whether the limit is enforced server-side or only by a client-side
  in-flight guard that a raw script trivially skips.
- Agent E: **IDOR / direct-object-reference integrity.** Take every RPC/table read
  or write that accepts an id (a record id, a post id, a user id, a club id) and
  try swapping it for one that belongs to someone else, testing whether the server
  actually scopes the operation to the caller or trusts the client-supplied id.
- Agent F: **File-upload security.** Avatar/photo upload paths: file-type
  validation (upload a disguised executable/script with an image extension and
  matching/mismatched content-type), oversized files, EXIF/metadata leakage,
  filename-based path traversal or stored-XSS-via-filename, whether an uploaded
  file is served from a properly scoped/randomized path rather than something
  guessable.

**Round 3 — authentication, privilege escalation, and client posture.**
- Agent G: **Authentication & account-recovery abuse.** Account enumeration via
  differing error messages (login/signup/password-reset), timing differences that
  reveal whether an email/handle exists, invite-code brute-forcing (rate limiting,
  code entropy), the anonymous-to-real-account upgrade path (can it be hijacked or
  replayed), session fixation across sign-out/sign-in.
- Agent H: **SECURITY DEFINER / privilege-escalation testing.** Every
  SECURITY DEFINER Postgres function this app calls (grep `supabase/migrations/`
  for `SECURITY DEFINER`) - does it re-validate the caller's actual permission for
  EVERY code path it can take, not just the one the client UI happens to drive it
  down? (This exact shape - a server function trusting a client-chosen branch -
  is what `scripts/audit-role-coverage.mjs`'s "permission-gate mismatch" check
  already looks for on the client side; this agent's job is the server side of
  the same question.)
- Agent I: **Client-side security posture.** CSP effectiveness (what does the
  current policy actually block vs. allow — test with a real injected inline
  script/external fetch attempt), any secret that shouldn't be client-visible
  (the anon key is expected to be public for Supabase — confirm RLS is what
  actually protects data, not key secrecy), verbose error messages leaking schema
  or internals, service-worker cache-poisoning surface (can a cached response be
  substituted to serve stale/malicious content after a legitimate update).

**Round 4 — moderation-bypass, data-tampering, and resource exhaustion.**
- Agent J: **Moderation/abuse-bypass.** Can a blocked user still reach the person
  who blocked them through some overlooked path (mentions, notifications, a shared
  challenge/event roster, a cached feed)? Does removed/moderated content still
  leak through a notification's stored text, a cache, or a search index after
  removal? Can a restricted member still perform the restricted action via a
  direct RPC call the UI no longer offers them?
- Agent K: **Client-side data tampering.** Fields the SERVER should compute
  (isPR, is_admin/role, achievement-unlock state, timestamps, permission-derived
  flags) — does any write path accept a client-supplied value for one of these
  instead of deriving it server-side? Try sending a forged value in an
  RPC/insert payload and see whether it's accepted or silently overridden by real
  server logic.
- Agent L: **Resource exhaustion from malicious input.** Oversized payloads
  (a multi-MB comment/note field bypassing client-side length caps by calling
  the RPC directly), a deeply nested/huge imported backup JSON, a decompression-
  bomb-shaped import, an input crafted to trigger a pathological/slow code path
  client-side (a regex, a sort, a recursive render) — does anything hang the tab
  or the server request with no size/complexity limit at all.

**Round 5 — third-party surface, PWA-specific attack surface, and defense-in-depth.**
- Agent M: **Third-party & supply-chain review.** The vendored `vendor/supabase.js`
  (already integrity-pinned — confirm that check is real and would actually catch
  a tampered file), any CDN/external script or font load, any `postMessage`/iframe
  surface, whether any dependency version has a known CVE relevant to how it's
  used here.
- Agent N: **PWA/service-worker attack surface.** Cache poisoning (can a
  man-in-the-middle-shaped test substitute a cached asset), service-worker scope
  confusion, the update mechanism (this session's own update-banner fix — confirm
  a malicious/corrupted update can't silently install without the same safeguards),
  offline-queued-write tampering (can a queued outbox record be modified before
  it flushes, and does the server re-validate it on arrival rather than trusting
  the queue).
- Agent O: **Defense-in-depth / assume-breach review.** Deliberately disable or
  bypass EVERY client-side check one at a time (via the console, editing
  `state`/module variables directly) for a sample of the most sensitive actions
  found across rounds 1-4, and confirm the server (RLS + RPC checks) is what
  actually stops the action in each case — not just the client UI. Any action
  where disabling the client check alone is enough to succeed is a critical
  finding, regardless of how "unlikely" a user is to do it manually — the point of
  this agent is proving the client is not the security boundary anywhere it
  matters.

---

## What "done" looks like

Every round ends with: 3 agent reports consolidated by real-world impact, every
confirmed vulnerability fixed (client fix, or a new migration + pgTAP test verified
against real local Postgres for anything RLS/authorization-shaped), full suite +
browser-check green, `supabase test db` green for any schema round, version bumped,
committed, and pushed — before the next round's agents are launched. The whole
5-round run ends with one final summary by severity, noting which findings still
need real-Postgres confirmation if any round only had mock access.
