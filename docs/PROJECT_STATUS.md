# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules. This file
holds the state, and it is the one a session should distrust first: if a
number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-09-19, against `main` at `2ba871c`.**

---

## The numbers

| | |
|---|---|
| App version | **4.76.0** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **174** files in `supabase/migrations/` |
| pgTAP suites | **116** files in `supabase/tests/` — assertion total **not measured here** (`supabase test db` needs Docker) |
| JS tests | **1954 passing, 0 failing** (`npm test`, run 2026-09-19 on this branch) |
| Browser scenarios | **47**, all passing (`scripts/browser-check/run-all.mjs`, real Chromium, run 2026-09-19) |
| Tables in `public` | **62**, every one with RLS enabled |
| RLS policies | **137** |
| Functions in `public` | **235**, of which **182** are SECURITY DEFINER |

The schema figures were read from a Postgres 16 instance built by applying
all 173 migrations in filename order, in PR #10. Five of them could not
apply in that container — `202609050005`, `202609060016`, `202609060018`, `202609080003`
(all pg_cron) and `202609120008` (needs PG17's `MAINTAIN` privilege). None of
the five creates a table or a policy, so the table and policy counts are
complete; the function count may be short by the handful those five declare.

**Those four schema rows have not been re-measured since.** `202609180001` has
landed and applied since that read; it drops and recreates
`admin_member_roster` at the same argument list, so it adds no table and no
policy and changes no count above — but the next session to stand up a
container should re-read all four rather than trust these.

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
  **`202609180001_the_roster_returns_what_it_sorts_on`, applied to production
  on 2026-09-19** by the owner, alongside the merge of PR #13. It matches the
  repository — 174 files committed, 174 applied. **No drift**
  (owner-confirmed, 2026-09-19). Confirm with `npm run check:drift`, never
  with this line: it is a record of what was true at reconcile time, and the
  command is the measurement.

---

## What shipped most recently

**Four branches merged 2026-09-19 (PRs #8, #11, #12, #13)**, plus **PR #10**,
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
