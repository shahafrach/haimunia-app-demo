# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules. This file
holds the state, and it is the one a session should distrust first: if a
number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-09-19, against `main` at `8ce9e5c`.**

---

## The numbers

| | |
|---|---|
| App version | **4.77.0** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **175** files in `supabase/migrations/` |
| pgTAP suites | **116** files in `supabase/tests/` (117 with `rls_helpers.sql`) — assertion total **not measured here** (`supabase test db` needs Docker) |
| JS tests | **1970 passing, 0 failing** (`npm test`, run 2026-09-19 on this branch) |
| Browser scenarios | **47**, all passing (`scripts/browser-check/run-all.mjs`, real Chromium, run 2026-09-19) |
| Community layer | `cloud.js` **6,756** lines plus **14** files in `src/community/` |
| Tables in `public` | **63**, every one with RLS enabled |
| RLS policies | **137** |
| Functions in `public` | **235 measured**, of which **182** are SECURITY DEFINER — plus **five** declared by `202609190001` and never counted in a container |

The schema figures were read from a Postgres 16 instance built by applying
all 173 migrations in filename order, in PR #10. Five of them could not
apply in that container — `202609050005`, `202609060016`, `202609060018`, `202609080003`
(all pg_cron) and `202609120008` (needs PG17's `MAINTAIN` privilege). None of
the five creates a table or a policy, so the table and policy counts are
complete; the function count may be short by the handful those five declare.

**Those rows have still not been re-measured in a container, and two of them
have since been adjusted by hand.** Two migrations have landed and applied
since that read. `202609180001` drops and recreates `admin_member_roster` at
the same argument list, so it adds no table, no policy and no function.
`202609190001` adds **`job_health_state`** — hence 63 tables, and it has RLS
enabled with **no policy at all**, so the policy count is genuinely unchanged
at 137 — and declares five functions (`job_health_check()`,
`job_health_status()`, `cron_cadence_window()`, `admin_alert_recipients()`,
and a re-declared `scheduled_job_health()`). The table row is arithmetic on a
measurement; the function row is not a measurement at all. The next session to
stand up a container should re-read all four rather than trust any of this.

---

## Where it runs

- **Host: Cloudflare Pages.** The repository root is the site root — there is
  no build step, so every committed file is a URL.
  `functions/_middleware.js` 404s `/docs/`, `/supabase/`, `/test/`,
  `/scripts/`, `/design/`, `/.github/`, `/.githooks/` and top-level `.md`,
  `.sql` and `.mjs` files.
- **GitHub Pages is gone.** It was the host until 2026-09-16 and was torn
  down. A doc that still says GitHub Pages is out of date.
- **The repository is private.** That is disclosure control layered on the
  middleware, not a reason to relax either it or the no-secrets rule.
- **Supabase project `jajmlyrjlkhclgphbfbb`** — production, real member data.
  Latest applied migration:
  **`202609190001_job_health_without_a_service_key`, applied to production on
  2026-09-19** by the owner, after the merge of PR #14. It matches the
  repository — 175 files committed, 175 applied. **No drift**
  (owner-confirmed, 2026-09-19). Confirm with `npm run check:drift`, never
  with this line: it is a record of what was true at reconcile time, and the
  command is the measurement.

---

## CI, until the quota resets on 2026-10-01

**The free GitHub Actions allowance ran out on 2026-09-19.** It resets on
**2026-10-01**. Until then there are no minutes to spend, so:

- **Database tests run locally before merge, not in CI.** `supabase test db`
  against a local stack is the only place the pgTAP suite runs in this window —
  including `0116` and the amended `0113` from PR #14, which have never been
  run by a runner. The person merging is the one who ran them, so a PR merged
  before 2026-10-01 should say in its description which suites it ran and
  where. `migration-check` is the job that is not answering.
- **A run that looks instantaneous is not a pass.** During the outage every
  job on PR #15 finished in 2–4 seconds with `runner_id: 0`, no runner name
  and `HTTP 404` on the log download — including jobs that branch's diff never
  touched. That is a job that never got a runner, and it is not a code result
  in either direction.
- **PR #17 halved the bill; it did not refill it.** PR-side cost is down from
  ~375 to ~186 minutes for a five-push PR, and a docs-only PR now queues
  nothing at all. That is what the allowance buys from 2026-10-01 onward.

---

## What shipped most recently

**Three branches merged 2026-09-19, after the consolidation in #16 (PRs #15,
#17, #14).** None of them changes what a member sees:

- **The community layer is fourteen files.** `cloud.js` went from 22,370 lines
  in one IIFE to 6,756 plus fourteen per-feature modules under
  `src/community/` — auth, feed, comments, boards, challenges, events,
  notifications, directory, coach tools, club management, admin, posts,
  outward sharing, achievements. Classic `<script>` files sharing one global
  scope, so **no call site moved**; all fourteen are in `sw.js`'s
  `OPTIONAL_ASSETS`, and the app was confirmed to still boot offline in real
  Chromium with the server stopped. Giving up the IIFE exposed five names that
  collided with `app.js`/`src/constants.js`; four are now declared compatibly,
  and `isIOSDevice` is two *visibly* drifted copies instead of one silently
  winning. Read `docs/community/CLOUD_JS_MAP.md` before the next module moves
  — its §5 lists the 139 duplicated lines and five near-duplicate function
  pairs the split exposed and deliberately did not merge (PR #15).
- **The Actions bill, roughly halved.** `test.yml` was running the whole
  37-minute suite twice per push — once as `push`, once as `pull_request` — in
  two concurrency groups that could not cancel each other. `push` is now
  `main` only, the group is keyed on `head_ref`, docs-only changes skip the
  workflow, and `claude-review` runs on `opened` and on `@claude` rather than
  on every push. The `paths-ignore` list names **only paths no test reads**;
  `test/workflow-minutes.test.mjs` derives the read set by scanning `test/*.mjs`
  for `.md` reads and fails if one of those six files ever lands inside the
  ignore list (PR #17).
- **The pg_cron jobs are watched without a service-role key in GitHub.**
  `job_health_check()` runs hourly, flags any job that failed, stalled or never
  ran, and notifies admins in-app as `job_health_alert` (rate-limited to the
  first problem, any change in the failing set, then at most every six hours).
  `job_health_status()` returns only `ok`, `failing_count` and
  `last_checked_at` and is **the one function in `public` deliberately granted
  to `anon`** — `supabase/tests/0113` now pins the anon-executable set to
  exactly that one, zero-argument function. `SUPABASE_SERVICE_ROLE_KEY` and
  `SUPABASE_URL` are no longer read by anything and **should be deleted from
  Settings → Secrets → Actions**. Migration `202609190001` (PR #14).

**Earlier on 2026-09-19 (PRs #8, #11, #12, #13)**, plus **PR #10**,
which merged late on 2026-09-18 — after the reconcile this file last carried —
and so appears here for the first time. Two of the five changed what a member
experiences:

- **The admin roster reaches its end.** `admin_member_roster` now returns the
  coalesced `sort_key` it orders and pages on, so a member with no
  `invite_redemptions` row no longer carries an invisible cursor that stopped
  paging at the club's pre-invite-gate tail. Migration `202609180001`, applied
  to production the same day.
- **The first set of a new movement is sanity-checked.** The 3×-your-own-best
  guard was dead on a movement with no history, so a 400-for-40 typo founded
  the record in silence. A per-category ceiling now covers exactly that case,
  and `saveWod()`'s identical twin was fixed in the same commit through one
  shared predicate.
- **The served privacy policy names the right sub-processor.** `PRIVACY.md`
  and `privacy.html` both named GitHub Pages, in Hebrew and English, in a
  document members read. Corrected in both — they are twins and must not
  drift (PR #10).

Three changed what the next session knows:

- **`.github/workflows/claude-review.yml`** reviews every PR against CLAUDE.md's
  seven rules. Advisory — it comments, it never gates, and it runs with
  `contents: read` so it cannot push. **Dormant until the
  `CLAUDE_CODE_OAUTH_TOKEN` repository secret is set**, which it is not; every
  run skips with a notice until then.
- **`docs/audit/usage-queries.sql`** — ten read-only blocks answering which
  modules members actually use, with all 28 analytics events mapped to a
  module. Its two findings are under *Open, deliberately* below.
- **`docs/audit/AUTHORIZATION_MATRIX.md`** section 1 caught up with the 72
  migrations that had landed since it was written, the largest correction being
  `202609060011`'s re-gating of sixteen policies on `is_community_member()`.
  `/CLAUDE.md` and this file were themselves added in PR #10, so that the rules
  and the numbers stopped being maintained in one document.

**Merging #11 and #13 together turned `main` red, and this consolidation fixed
it.** #13's new `test/workflow-action-pinning.test.mjs` walks every file in
`.github/workflows/`; #11 added one. Both branches were green against
`18c9172`, there was no textual conflict, and the second merge broke the
build — `anthropics/claude-code-action` was not in the test's runtime map.
It is a **composite** action (`runs.using: "composite"`, read from `action.yml`
at the pinned SHA `4036a180`, not from a changelog), so it joins
`supabase/setup-cli` in `NO_NODE_RUNTIME`. The general hazard is written up in
`docs/handover/SHARED_CONTEXT.md`; `CLAUDE.md`'s *Parallel work* section
currently names only migrations, and could reasonably name the other
enumerated directories too — left as the owner's call rather than taken here.

**Before that (2026-09-18, PR #9):** the desktop staff shell. Three columns for
staff at ≥1024px with a fine pointer, gated on `is_staff()`, adding no table,
column, policy, RPC or migration. Members at a laptop are byte-identical to
before — enforced by a stylesheet in which no rule is keyed on `data-layout`
alone. See `docs/DESIGN_HANDOFF.md`.

**Before that (2026-09-17):** web push built, deployed and scheduled, with an
admin switch; `npm run check:drift` added after a security migration sat
committed-but-unapplied for a day; the anon `EXECUTE` grant class closed;
Turnstile captcha turned on for anonymous sign-ins; the deploy workflow fixed
after it turned out never to have run on a merge.

**Before that (2026-09-16):** Cloudflare Pages became the host; a weekly
restore drill that proved the backups restorable; the head coach gained
member removal with an audit trail; two rounds of live bug hunting.

---

## Open, deliberately

- **Leaked-password protection** shows as a permanent WARN in Supabase's
  security advisor. It is Pro-plan only, confirmed by trying it. Generated
  passwords achieve the same thing. Not worth looking at again.
- **Coach "engage" signals** are flag-gated (`featureFlags.coachEngage`) and
  the decline/attendance half is scaffolded rather than finished — it waits
  on attendance data the app does not own.
- **`docs/audit/`** is a launch-era snapshot, not a live description. Several
  files there still describe GitHub Pages and a public repository. They are
  historical records of an audit that happened; treat them as dated. The
  live picture is this file, `CLAUDE.md` and
  `docs/handover/SHARED_CONTEXT.md`.
- **Eleven modules emit no analytics event at all** (PR #12).
  `announcements`, `member_of_week`, `welcome_flow`, `monthly_recap`,
  `club_wod`, `new_member_posts`, `post_photos`, `mentions`, `outward_share`,
  `streak_risk_nudges` and `engagement_alerts` each have a `club_features` row
  and nothing in `src/analytics.js`'s `EVENTS` mapped to them. They are not
  unused — they are **unmeasured**, and query 5 of
  `docs/audit/usage-queries.sql` deliberately gives them their own verdict
  string rather than letting them sort to the bottom of a "least used" list.
  **Do not remove one on the strength of its zero**; that is removing it on no
  evidence. Query 7 recovers a partial signal for two of them from
  `post_created.has_media` and `comment_created.mention_count`.
- **Display mode is computed and never sent** (PR #12). The client knows
  whether it is running as an installed app — `isStandalone()` in app.js and
  `isStandalonePwa()` in cloud.js, both reading
  `matchMedia('(display-mode: standalone)')` — but neither value ever reaches
  `analyticsTrack()`, and `HAND_PROP_KEYS`/`BUS_PROP_KEYS` would drop it if a
  call site tried. So "share of sessions opened as an installed app" is **not
  answerable from `analytics_events`**, and there is no app-session concept in
  the table either: the only session-shaped id is `post_impression`'s
  `feed_session_id`, minted per feed load. The nearest server-side reading is
  `bug_reports.diagnostics ->> 'standalone'`, which is a self-selected sample
  of members who hit a problem and wrote in — never an adoption rate. The
  one-line additive fix is `standalone` on `club_tab_viewed`'s props.

- **`archive/ux-audit-stash` is preserved and unreviewed.** The branch holds a
  git stash commit (`0a43d34`) made on 2026-09-06 on `fix/ux-audit-blockers` at
  `45b98fe` — a base that is **not an ancestor of `main`**. It touches
  `PRIVACY.md`, `app.js`, `cloud.js`, `index.html` and `privacy.html`, and its
  substance is UX-audit work: separating the estimated 1RM from the heaviest
  set actually lifted in the all-time-records headline, gating the tenure
  badges behind at least one logged session so a self-typed signup date cannot
  earn three celebrations in ninety seconds, and holding a celebration that
  would otherwise render on top of the first-run onboarding overlay. **Nobody
  has reviewed it and none of it is merged.** It lives on a branch rather than
  in a stash entry so it survives the machine it was made on. It will not
  replay cleanly — `cloud.js` has been split since, so its `cloud.js` half
  needs re-targeting at `src/community/`. Read it before re-deriving any of
  those three findings from scratch.
- **The service-role key is still in the repository's Actions secrets**, and
  nothing reads it any more (PR #14). Deleting `SUPABASE_SERVICE_ROLE_KEY` and
  `SUPABASE_URL` is an owner action; leaving a service-role key in a store
  nothing uses is the worst of both.

## Stale in the repository, flagged not fixed

Small, harmless, and left for a pass that is allowed to touch code — listed
here so they are not rediscovered as findings:

- **`_headers` carries its own out-of-date comment.** It still explains that
  "GitHub Pages cannot set response headers", that the app therefore has "NO
  clickjacking protection in production today", and that the file "is inert on
  GitHub Pages". All three stopped being true on 2026-09-16. The header block
  *below* the comment is correct and live — `docs/deploy/HEADERS.md` was
  marked superseded in PR #10 and this file is its twin, so the drift is
  between a comment and its own contents.
- **`README1.md` sits at the repository root** under a name that reads like a
  duplicate README. It is a design-direction handoff (Direction 06, "Club
  Balance"), and `index.html` cites it **by name in three token comments**, so
  it cannot simply be deleted or renamed — moving it under `docs/` means
  updating those citations in the same change.
- **`.github/workflows/backup-database.yml` still reasons from the repository
  being public.** Its header comment says *"THE ENCRYPTION IS NOT OPTIONAL, AND
  HERE IS WHY. This repository is PUBLIC. Workflow artifacts on a public
  repository are readable by anyone who can reach the Actions API"*, and the
  job echoes the same premise at runtime when it refuses to run without a
  passphrase: *"this repository is public and its artifacts are
  world-readable."* The repository has been **private since 2026-09-17**. The
  conclusion is still right — encrypt the dump before it leaves the runner,
  because an artifact is readable by everyone with repository access and a
  passphrase in a password manager is the control that survives the repository
  changing visibility again — which is exactly why this has survived two passes
  over the file. PR #13 edited this workflow (the Node 24 artifact-action pins)
  and left both lines. Fixing it means rewriting the *reason*, not deleting it;
  a future session that reads the premise, checks it, and silently drops the
  encryption would be the bad outcome here.

## Declined by the owner — do not re-propose

Streak consolidation · streak nudge redesign · opt-in board ranking ·
finishing `lang="en"` · removing the welcome-modal name field · booking or
payments of any kind (Arbox owns those).
