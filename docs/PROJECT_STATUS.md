# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules, and
[`docs/circles/decisions.md`](circles/decisions.md), which holds the decisions.
This file holds the state, and it is the one a session should distrust first: if
a number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-10-29, against `main` after Pilot readiness (#134), in the
5.0.0 consolidation; version bumped to 5.0.1 on 2026-10-30 after #136 to #138, to 5.0.2 on 2026-11-01 after #141 and #142, and to 5.0.3 on 2026-11-07 after #145.** Everything before 2026-10-25 (the gym app, project
`jajmlyrjlkhclgphbfbb`, 70 tables) is history; git keeps the old version of this file.

---

## The numbers

| | |
|---|---|
| App version | **5.0.3** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **210** files in `supabase/migrations/`, latest `202611070001_per_circle_targets`. Applied to production by the Supabase GitHub integration on each merge to `main`; `check:drift` not run at this consolidation (no linked project here) |
| pgTAP suites | **48** files in `supabase/tests/`, run by CI in `migration-check` on every PR (green on #145) |
| JS tests | **1512 tests, 1512 pass, 0 fail** (`npm test`, 2026-11-07, on #145 before merge) |
| Browser scenarios | **44** scenarios in `scripts/browser-check/`; 44 of 44 passed (2026-11-07), run one by one on a different Chromium build than the pinned one, so pixel numbers are approximate; green in CI on #145 |
| Community layer | `cloud.js` **2,775** lines plus **13** files in `src/community/`; `app.js` **8,938** lines |
| Schema | Not re-measured here. After Circles schema: 24 tables before the circle tables were added, every one with RLS (guarded by `0136`); every SECURITY DEFINER function reviewed in `tests.definer_reviewed` (guarded by `0135`) |

---

## Where it runs

- **Site: `https://box-log.pages.dev`** (Cloudflare Pages project `box-log`). The
  repository root is the site root, no build step, so every committed file is a URL.
  `functions/_middleware.js` 404s `/docs/`, `/supabase/`, `/test/`, `/scripts/`,
  `/design/`, `/.github/`, `/.githooks/`, `/.claude/`, `/mockups/`, `/workers/`,
  `/photos/` and top-level `.md`, `.sql` and `.mjs` files.
- **Supabase project `box-log`, ref `hvwakffluwvegedefoth`** (`supabase/PROJECT_REF`),
  free tier. Created 2026-10-25. No members yet at this reconcile.
- **Repository: `shahafrach/haimunia-app-demo`, public** since 2026-10-25 (secret scan
  over all history was clean). Public means free Actions minutes and that every
  committed file and every workflow artifact is readable by anyone.
- **The old Cloudflare project `haimunia-app` still exists** and should be deleted by
  the owner.

## Secrets and keys set on production

- Edge Function secrets `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: set by
  `rotate-vapid` run #2, 2026-10-28. The public key is in `cloud-config.js`.
- Vault secrets `edge_functions_base_url` and `edge_functions_service_role_key`: set
  by `set-vault-secrets`, 2026-10-28, both verified not placeholders.
- Turnstile: site key in `cloud-config.js`; the secret key goes in Supabase,
  Authentication, Attack Protection. The owner was setting it on 2026-10-28; confirm the
  switch is on there. The first real check is the first sign-up.
- `BACKUP_PASSPHRASE` (pre-existing) for backups; `RECOVERY_CODE_HMAC_SECRET` Edge Function secret, set by `rotate-recovery-secret` on 2026-11-01.

## Scheduled workflows

- `keepalive`: on, every two days.
- `scheduled-job-alert`: on.
- `backup-database`: on since 2026-10-30, daily at 02:17 UTC with a Sunday restore drill; no database password stored (it links with SUPABASE_ACCESS_TOKEN).

---

## Open, deliberately

- **First circle:** the owner runs `select public.bootstrap_owner_invite();` in the
  Supabase SQL editor (`docs/ops/FIRST_CIRCLE.md`), then walks
  `docs/ops/PILOT_CHECKLIST.md` with two phones.
- **Friend conversations** (the validation gate in `docs/circles/audit.md`) have not
  happened.
- **Scheduled jobs failing on production.** `scheduled-job-alert` has failed on every run since at least 2026-11-06 (#169 to #172): "2 scheduled job(s) are failing". Which two is unknown from the repository; the owner runs `select * from public.scheduled_job_health() where not healthy;`. `ALERT_WEBHOOK_URL` is not set, so the alert only prints in the run log (`docs/ops/MONITORING.md`).
- **Dependabot:** Playwright 1.64 (#107) stays out on purpose (the pinned Chromium build is
  what the layout numbers were measured on); the claude-code-action bump (#143) was asked to rebase.

## Stale in the repository, flagged not fixed

- **The synthetic sign-in domain is still `members.haimuniya.invalid`.** SQL and
  migrations reference it, so it stays until a migration changes both sides together.
- **The backup workflow's comment says the repository is public.** True again since
  2026-10-25; keep the encryption either way.

## Declined by the owner — do not re-propose

Daily streaks · absolute leaderboards · text comments in circles · email or phone for
members or for support · payments of any kind.
