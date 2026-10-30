# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules, and
[`docs/circles/decisions.md`](circles/decisions.md), which holds the decisions.
This file holds the state, and it is the one a session should distrust first: if
a number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-10-29, against `main` after Pilot readiness (#134), in the
5.0.0 consolidation; version bumped to 5.0.1 on 2026-10-30 after #136 to #138.** Everything before 2026-10-25 (the gym app, project
`jajmlyrjlkhclgphbfbb`, 70 tables) is history; git keeps the old version of this file.

---

## The numbers

| | |
|---|---|
| App version | **5.0.1** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **208** files in `supabase/migrations/`, latest `202610290003_signup_claim_and_deletion_leaves_circles`. Applied to production by the Supabase GitHub integration on each merge to `main`; `check:drift` not run at this consolidation (no linked project here) |
| pgTAP suites | **47** files in `supabase/tests/`, run by CI in `migration-check` on every PR (green on #138) |
| JS tests | **1448 tests, 1448 pass, 0 fail** (`npm test`, 2026-10-29, this consolidation) |
| Browser scenarios | **41** files in `scripts/browser-check/`; 40 of 41 passed at this consolidation (2026-10-29); `community-render-cost` read 22.4 ms against its 16 ms trip-wire on a loaded machine, not re-run |
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
- Not set yet: `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` for backups
  (`docs/ops/BACKUPS.md`).

## Scheduled workflows

- `keepalive`: on, every two days.
- `scheduled-job-alert`: on.
- `backup-database`: schedule commented out until the backup secrets exist.

---

## Open, deliberately

- **First circle:** the owner runs `select public.bootstrap_owner_invite();` in the
  Supabase SQL editor (`docs/ops/FIRST_CIRCLE.md`), then walks
  `docs/ops/PILOT_CHECKLIST.md` with two phones.
- **Backups are off** until the two secrets above exist. No restore drill on the new
  project yet.
- **Friend conversations** (the validation gate in `docs/circles/audit.md`) have not
  happened.
- **Dependabot:** Playwright 1.64 stays out on purpose (the pinned Chromium build is
  what the layout numbers were measured on); claude-code-action is behind by one patch.

## Stale in the repository, flagged not fixed

- **`downloadJsonFile()` in cloud.js duplicates `downloadBackup()` in app.js** (Blob,
  anchor, revoke). Merge them in a change allowed to touch both.
- **`README1.md` at the root** is an old design-direction handoff that `index.html`
  used to cite. Check whether anything still cites it before moving or deleting it.
- **The synthetic sign-in domain is still `members.haimuniya.invalid`.** SQL and
  migrations reference it, so it stays until a migration changes both sides together.
- **The backup workflow's comment says the repository is public.** True again since
  2026-10-25; keep the encryption either way.

## Declined by the owner — do not re-propose

Daily streaks · absolute leaderboards · text comments in circles · email or phone for
members or for support · payments of any kind.
