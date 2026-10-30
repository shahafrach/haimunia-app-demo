# e2e user tests

Three scripts that drive the real app, as real people would, against a **local**
Supabase stack. They never touch production: every address must be loopback, and
the browser aborts any request that is not the local page or the local stack.

| Script | Who | What |
|---|---|---|
| `01-owner.mjs` | Dana | bootstrap link, sign-up, Friends circle, target, PR moment, PR card, week, notifications |
| `02-friend.mjs` | Yoav | WhatsApp invite, sign-up, reactions, trained together, leave, rejoin |
| `03-privacy.mjs` | Noa, Avi | couple limit, circle isolation, no weights or body weight on the wire, offline queue, account deletion |

CI runs them in `.github/workflows/e2e.yml`. Locally, with Docker:

```bash
supabase start
eval "$(supabase status -o env | sed 's/^/export /')"
cd scripts/e2e && npm ci && npx playwright install chromium
E2E_ANON_KEY="$ANON_KEY" E2E_API_URL="$API_URL" E2E_DB_URL="$DB_URL" node 01-owner.mjs
```

How it works:

- `lib/server.mjs` serves the repository root. It sends an override `cloud-config.js`
  (written to `.run/`, the tracked file is never edited; **CAPTCHA off**) and an
  `index.html` whose Content-Security-Policy names the stand-in host instead of the
  production project.
- The page is configured with `https://e2e-local.supabase.co`; `lib/harness.mjs`
  answers every request to it from the local stack. `cloud.js` is served as shipped.
- The first circle starts through `bootstrap_owner_invite()` run with `psql` as
  `postgres` (`lib/db.mjs`), the way `docs/ops/FIRST_CIRCLE.md` says.
- Every tap and typed field goes through `Person.tap` / `Person.type`, so the counts in
  the report are the script's own. Each step ends with a dark Classic and a light-palette
  screenshot in `artifacts/<test>/`, plus measured layout and contrast.

The report is `docs/qa/user-tests-2026-10.md`.
