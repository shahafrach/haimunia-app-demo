# Shared context — read this first

Rewritten 2026-10-29 in the 5.0.0 consolidation. The version before this one
described the gym app; git history keeps it.

## What this is

**BOX-LOG** — a free, Hebrew/RTL, offline-first PWA where small private circles
of friends (a couple, or up to 20 friends) log training and cheer each other on.
A personal project by Shahaf Rachmany, not a product: no payments, no public
sign-up, no email or phone.

Buildless vanilla JS: `index.html` (inline app stylesheet, linking `tokens.css`),
`app.js` (the training log, on the device), `cloud.js` plus `src/community/*.js`
(circles, sharing, notifications), `src/share-cards.js` (canvas cards). Supabase
for auth and data, Cloudflare Pages for hosting.

Live: https://box-log.pages.dev
Repo: `shahafrach/haimunia-app-demo` — public
Supabase: `box-log`, ref `hvwakffluwvegedefoth` (free tier)

**v5.0.0** · 206 migrations · 45 pgTAP files (CI) · 41 browser scenarios ·
current JS test count in `docs/PROJECT_STATUS.md`

## Read these first

- **[`/CLAUDE.md`](../../CLAUDE.md)** — the rules: stack, the single token block,
  migrations, precache, secrets, member data, sibling drift, parallel work,
  verification and budget.
- **[`docs/circles/decisions.md`](../circles/decisions.md)** — the product and
  architecture decisions. Wins over code.
- **[`docs/design/decisions.md`](../design/decisions.md)** — the design system
  decisions (Classic default, six palettes, Heebo, four tabs).
- **[`docs/PROJECT_STATUS.md`](../PROJECT_STATUS.md)** — the current state: version,
  counts, what is set on production, what is open.
- **[`docs/circles/rpcs.md`](../circles/rpcs.md)** — every circle function and what
  the client calls.

## How work happens

- One Claude Code cloud session per change, each ending in one PR. The owner approves
  every merge.
- **Every merge to `main` applies new migrations to production** (Supabase GitHub
  integration). Merge only when `migration-check` is green on a branch updated from
  `main`.
- Secrets are never typed into a session, a prompt or a file. Keys are made and stored
  by workflows that never print them: `rotate-vapid`, `set-vault-secrets`.
- Changelog entries go in PR descriptions; a consolidation session writes
  `CHANGES.md`, this file and `PROJECT_STATUS.md` and bumps the version once.

## Ops runbooks

`docs/ops/`: `MIGRATIONS.md`, `FIRST_CIRCLE.md`, `PILOT_CHECKLIST.md`, `BACKUPS.md`,
`SUPPORT.md`, `VAULT_SECRETS.md`, `INVITE_MESSAGE.md`.
