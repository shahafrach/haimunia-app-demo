# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules. This file
holds the state, and it is the one a session should distrust first: if a
number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-09-24, against `main` at `a956ef4` (#83).**

---

## The numbers

| | |
|---|---|
| App version | **4.79.0** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **197** files in `supabase/migrations/` — all applied to production, `check:drift` clean at 197 (2026-09-24) |
| pgTAP suites | **134 files, 4,137 tests, PASS** (`supabase test db`, run locally 2026-09-24) |
| JS tests | **(recorded when `npm test` finishes)** (`npm test`, 2026-09-24 on `a956ef4` plus this consolidation) |
| Browser scenarios | **60** files in `scripts/browser-check/` — not run at this consolidation; last full run 59 of 60 on #83 (`community-render-cost` over its trip-wire under load) |
| Community layer | `cloud.js` **7,950** lines plus **16** files in `src/community/`; `app.js` **9,234** lines |
| Tables in `public` | **67** measured at 185 migrations, every one with RLS enabled — **not re-measured since** |
| RLS policies | **142** measured at 185 migrations — not re-measured since |
| Functions in `public` | **273**, of which **215** SECURITY DEFINER, measured at 185 migrations — not re-measured since |

**The schema rows are a measurement at 185 migrations, and twelve have landed
since.** At least three add a `public` table — `storage_erasure_queue`
(`202609230002`), `edge_function_invocations` (`202609230008`) and
`training_log_usage` (`202609230013`) — and several add functions, so treat
those three rows as a floor. Re-read them from `pg_tables`, `pg_policies`,
`pg_proc` and `pg_class.relrowsecurity` after a `supabase db reset --local`,
and replace this paragraph when you do.

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
  **`202609230013_training_log_usage_counts`, applied to production on
  2026-09-24.** It matches the repository — 197 files committed, 197 applied.
  **No drift** (`check:drift`, 2026-09-24). Every push is logged in
  `docs/ops/MIGRATIONS.md`'s push log. Confirm with `npm run check:drift`, never
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

**Twenty-five branches merged between 2026-09-23 and 2026-09-24** (#57,
#60–#83), consolidated in CHANGES.md under *"The audit gets worked off,
production gets a gate, and the backups get restored"*. The short version:

- **The launch-readiness audit is mostly closed.** 5 of 6 blockers outright
  and B6 but for one hint; 16 of 20 should-fix. The per-item table is at the
  top of `docs/audit/launch-readiness.md`.
- **Module switches reach the whole server** (#60, #65, #67, #73) — every
  definer path gated, search and suggestions gated at the slot, Engage on the
  club switch, and module `config` no longer readable by members.
- **<span dir="rtl">מסך תצוגה במועדון</span>** (#68) — a read-only wall screen
  signed in as its own `gym_display` role. Off by default; see below.
- **Account deletion reaches photos, telemetry and the audit note** (#57).
- **Operations** — `npm run push:prod` and its push log (#62, #63, #75, #76);
  the restore drill run (#77) and photos backed up (#78); the keep-awake
  heartbeat (#61); the anonymous half of the live smoke test (#81); the job
  board reads HTTP responses (#74).
- **Standalone training-log edition, server half** (#82, #83) — the old app's
  EMOM model, and `training_log_usage`, the first table `anon` can write to.

## Open, deliberately

**The multi-role smoke test has run against production — one role of five.**
Launch-readiness **S9**. `npm run smoke-test-multi-role` (the script existed;
the npm entry did not) checks each real role's boundary over the network
against the live project. The **anonymous** role passes: a fresh anonymous
session reads zero `profiles` rows, zero `private_records` rows, and is
refused `admin_grant_coach`.

The other four — member, coach, admin, and a posting-restricted member — are
**SKIP, not pass**, and the script says so in as many words. Each needs a
throwaway account provisioned in whatever project it points at, and the script
warns "never a real club's real data". Our production *is* the real club, so
creating four accounts in it is the owner's call, not a step to take quietly.
Until then those four boundaries have been proven by pgTAP against a local
database and never against the live project.


**The restore drill has been run — 2026-09-23, and a restore verified under the
new passphrase on 2026-09-24.** Launch-readiness **S19** is closed. `haimunia-db-backup-20260923T045538Z`
was decrypted with the current passphrase and restored into a scratch database:
schema 0 errors, all 30 `public` and all 5 `auth` inserts loaded, and **all 138
foreign keys in `public` checked individually for orphan rows — 0 violations**.
The procedure is `docs/ops/MONITORING.md` §7.

Two things it found. **The backup is not self-contained**: it restores into a
Supabase project, never a bare Postgres, because `schema.sql` carries no `auth`
or `storage` schema while `data.sql` writes into both and 17 `public` foreign
keys point at `auth.users`. And uploaded photos were not backed up at all —
`storage.objects` rows are metadata and the bytes live in the Storage backend.
**That is closed as of the same day**: `scripts/backup-storage.mjs` downloads
both photo buckets into the encrypted archive with a sha256 manifest, and its
own restore drill has been run — both objects restored into the local stack
and re-downloaded byte-identical. It costs about 2.5 MB today and grows at one
byte of archive per byte of photo, since JPEG does not compress.


**The backup passphrase was lost and rotated on 2026-09-23.** A new
`BACKUP_PASSPHRASE` repository secret is set; the old one is gone. Every
database backup artifact produced before that date is encrypted under the old
passphrase and **cannot be decrypted** — treat them as lost, not as a restore
path. The first backup taken under the new passphrase is the oldest restorable
one, and **a restore under the new passphrase has been verified (2026-09-24)**.
`backup-database.yml` now also needs `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_PROJECT_REF` (#78) and will fail, deliberately, without them when
the minutes return on 2026-10-01. Nothing else about
the passphrase handling changed, and no passphrase is recorded in this
repository.

**The gym display is built, server-enforced and off.** `gym_display` was
seeded `false` by `202609190002` (whose own guard refuses a replay that turns
it on), and no later migration touches its row. `gym_display_board()` — the
only thing the display role can call — raises unless
`club_feature_enabled('gym_display')` *and* `is_gym_display()`. Two things are
out of step with that: the module panel row in `cloud.js`
(`CLUB_MODULE_TOGGLES`) still carries `clientOnly: true, planned: true`, so it
reads <span dir="rtl">בפיתוח</span> and "display only" for a feature that is
built and enforced on the server; and `?display=1` mounts the full-screen page
on any device whatever the switch says — harmless, since it gets no data and
shows <span dir="rtl">אין חיבור כרגע</span>, but it is not gated client-side.

**The job board reads red on purpose** until the two `edge_functions_*`
Vault secrets are set (#74): the three Edge-Function cron jobs have never
actually run.



- **Leaked-password protection** shows as a permanent WARN in Supabase's
  security advisor. It is Pro-plan only, confirmed by trying it. Generated
  passwords achieve the same thing. Not worth looking at again.
- **Coach "engage" signals** answer to the `engagement_alerts` club module
  since #67 (the per-device flag is gone). The decline/attendance half is
  scaffolded rather than finished — it waits on attendance data the app does
  not own.
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

- **`test/settings-backup-export.test.mjs` is an empty file**, added at 0
  bytes by #71. It runs as a file with no tests; either fill it or delete it.

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
