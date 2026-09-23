# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules. This file
holds the state, and it is the one a session should distrust first: if a
number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-09-23, against `main` at `926326c`.**

---

## The numbers

| | |
|---|---|
| App version | **4.78.0** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **185** files in `supabase/migrations/` |
| pgTAP suites | **125** test files in `supabase/tests/` (126 with `rls_helpers.sql`) — **3955 assertions, 0 failing** (`supabase test db`, Docker, 2026-09-23) |
| JS tests | **2322 passing, 0 failing** (`npm test`, 2026-09-23 on the #56 merge result) |
| Browser scenarios | **60** files in `scripts/browser-check/` — `run-all.mjs` green 2026-09-23 on the #45 merge result (#56 adds no scenario) |
| Community layer | `cloud.js` **7,855** lines plus **15** files in `src/community/`; `app.js` **9,173** lines |
| Tables in `public` | **67**, every one with RLS enabled (67 of 67 measured) |
| RLS policies | **142** |
| Functions in `public` | **273**, of which **215** are SECURITY DEFINER |

**The schema rows above are a real measurement again.** They were read on
2026-09-23 out of the local Supabase container after `supabase db reset --local`
applied all 185 migrations cleanly — `pg_tables`, `pg_policies`, `pg_proc` and
`pg_class.relrowsecurity` in the `public` schema. That closes the caveat this
table carried since 2026-09-19, when the figures came from a Postgres 16
instance in which five migrations could not apply and the function count was
known to be short. Nothing is estimated or carried forward by arithmetic now,
and "every table has RLS enabled" is counted rather than asserted: 67 tables,
67 with `relrowsecurity`.

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

**Thirty-three branches merged between 2026-09-19 and 2026-09-23**, consolidated
in CHANGES.md under *"The community becomes a feed, the switches reach the
server, and the phone gets a real pass"*. The short version:

- **The community feed became a feed** (#33, #35, #36, #37, #49/#54) — one card
  layout for every post type, chronological by default with the ranked order a
  switch away, a post-workout share prompt, training-partner tagging, and
  announcements that actually reach the feed.
- **Five of 202609190002's seven pre-seeded switches grew their features**
  (#24, #30, #31, #38) — strength percentages and Rx+, benchmark tracking,
  coach tasks and the onboarding challenge, and the monthly owner report. Two
  remain <span dir="rtl">בפיתוח</span>: `gym_display` and `arbox_attendance`.
- **Module switches reach the server** (#53) — six modules now refuse the
  matching server calls rather than only hiding the control. Four of them are
  marked <span dir="rtl">נאכף בשרת חלקית</span> until the rest of their paths
  are gated.
- **The first real-phone pass at 390px** (#39, #40, #41, #43, #44, #45) — the
  save toast no longer covers the save button, never-logged stopped wearing
  overdue's red, `.mono` stopped reversing every number beside a Hebrew unit,
  the ⋯ menu opens inside the card, deletes are undoable, and the hero photo
  came down from half the screen to a third.
- **Security** (#52, #55, #56) — management login hardened, five more paths off
  the public surface, and `admin_reset_password` redeployed without the retired
  github.io origin.
- **The launch-readiness audit landed** (#46): 6 blockers, 20 should-fix, 15
  nice-to-have. Working it off is the current thread.

---

## Open, deliberately

**The restore drill has been run — 2026-09-23.** Launch-readiness **S19** is
closed for the database and open for Storage. `haimunia-db-backup-20260923T045538Z`
was decrypted with the current passphrase and restored into a scratch database:
schema 0 errors, all 30 `public` and all 5 `auth` inserts loaded, and **all 138
foreign keys in `public` checked individually for orphan rows — 0 violations**.
The procedure is `docs/ops/MONITORING.md` §7.

Two things it found. **The backup is not self-contained**: it restores into a
Supabase project, never a bare Postgres, because `schema.sql` carries no `auth`
or `storage` schema while `data.sql` writes into both and 17 `public` foreign
keys point at `auth.users`. And **uploaded photos are not backed up at all** —
`storage.objects` rows are metadata; the bytes live in the Storage backend and
are in no archive. A project loss would lose every member photo permanently,
which is a promise `PRIVACY.md` makes. That is now the largest unhandled
recovery risk and it has no owner yet.


**The backup passphrase was lost and rotated on 2026-09-23.** A new
`BACKUP_PASSPHRASE` repository secret is set; the old one is gone. Every
database backup artifact produced before that date is encrypted under the old
passphrase and **cannot be decrypted** — treat them as lost, not as a restore
path. The first backup taken under the new passphrase is the oldest restorable
one, and the restore drill in `docs/audit/ROUND_10_AND_KNOWN_LIMITATIONS.md`
has not yet been re-run against it. Nothing about
`.github/workflows/backup-database.yml` changed, and no passphrase is recorded
in this repository.


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
