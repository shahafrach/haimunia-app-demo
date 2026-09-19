# האימוניה — קהילה

> **This repository ships a LIVE app to real members.** Despite the `-demo`
> in the repository name, `cloud-config.js` points at a **production**
> Supabase project holding real profiles, posts and training logs, and the
> **Cloudflare Pages** site is what members actually install.
>
> **Never test against it.** Bring up a local stack instead —
> `supabase start && supabase db reset` builds the identical schema from the
> same migrations, and you can grant yourself any role there.
> `scripts/seed-local-personas.sql` fills it with members, roles and feed
> volume in one shot. See
> `docs/audit/REMEDIATION_STATUS.md` for what "production" means here.
>
> **The repository root is the website.** There is no build step — Cloudflare
> Pages serves the repo verbatim, so every committed file is a URL.
> `functions/_middleware.js` 404s the paths that should not be public
> (`/docs/`, `/supabase/`, `/test/`, `/scripts/` and top-level `.md`, `.sql`
> and `.mjs`). **The repository is also private**, which is a second layer
> and not a replacement for either that middleware or the rule that nothing
> secret is ever committed — git history is history.
>
> New here? Read [`CLAUDE.md`](CLAUDE.md) for the rules and
> [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the current state.

Live community layer for האימוניה: an installable, offline-first PWA with
its own IndexedDB store, plus an optional Supabase-backed social layer
(profiles, follows, a workout feed, reactions, streaks, coach
announcements, a weekly challenge). This is a real, working app, not a
mock-data preview — see [What this is not](#what-this-is-not) for the one
thing it still isn't.

## What this is

- The full offline-first app (log lifts, WODs, bodyweight, measurements,
  calendar, achievements) — everything `haimunia-app` has, plus a
  Community tab.
- The Community tab talks to a real Supabase project once one is
  configured in `cloud-config.js` (see `COMMUNITY_SETUP.md`): sign-in is
  invisible and instant (no email, no magic link — see "Sign-in has no
  email" in `COMMUNITY_SETUP.md` for the tradeoff), gated by a box invite
  code; a profile, following/blocking, a workout feed with reactions
  and comments, an optional photo on a shared result, sharing a strength/
  WOD PR or an achievement unlock, activity streaks, coach-posted
  announcements (with an optional "today's workout" pin), and a weekly
  box-wide challenge leaderboard. Row Level Security enforces every one
  of those boundaries at the database, not just in the UI. Organized into
  three sub-tabs — Feed, Boards, Account — instead of one long scroll.
- Fully usable offline with no backend configured at all — training data
  stays local in IndexedDB and nothing in the Community tab is required
  to log a workout.
- Deployed on **Cloudflare Pages** (GitHub Pages was the host until
  2026-09-16 and has been torn down). Its IndexedDB name, its localStorage
  key prefix and its Cache Storage cache name are all distinct from
  `haimunia-app`'s own, so an install of each can coexist on one device
  without either seeing or overwriting the other's data.

## What this is not

- Not connected to `haimunia-app`'s database: this is a separate Supabase
  project and a separate browser storage namespace. **It is not a sandbox
  either** — that separate project is production for this club and holds
  real member data. This bullet used to say "real database or member data",
  which read as though nothing here were live and flatly contradicted the
  warning at the top of this file. Bring up a local stack to experiment
  (`supabase start && supabase db reset`).
- Not scoped to a coach's specific classes or members — sign-up is gated
  behind a single shared invite code per role (member/coach), and a
  coach gets a fixed set of powers (announcements, the weekly challenge,
  the new/inactive member views), the same for every coach, not a
  per-coach roster. Class scheduling and "who's coming to class" are
  intentionally out of scope here — that's already handled by Arbox.
  Full admin stays a separate, manual, dashboard-only grant. See
  "Access tiers" in `COMMUNITY_SETUP.md`.

## Running it locally

Any static file server works, e.g.:

```
npx serve .
```

Open the printed URL. Without a configured `cloud-config.js` the app runs
fully offline; the Community tab shows a "connect Supabase" notice instead
of the feed.

## Setting up the backend

See `COMMUNITY_SETUP.md` for creating the Supabase project, running the
migrations in `supabase/migrations/`, and the required pre-launch checks.

## Development

Requires Node 22+ and npm (no other runtime dependency — the app itself
ships with zero build step; Node is only for the test suite and the
browser-check scripts).

```
npm ci                              # install test dependencies
npm test                            # 1940 unit/integration tests (jsdom), ~10 min
npm run sync-version                # keep APP_VERSION (app.js) and SW_VERSION (sw.js) in sync after a version bump
cd scripts/browser-check && npm ci && npx playwright install chromium
node run-all.mjs                    # full real-Chromium suite; same jobs CI runs
```

`npm test` and the browser-check suite both run in CI on every pull request,
and on a push to `main` (see `.github/workflows/test.yml`). A push to a
feature branch does not start a run — the PR run already covers it, and
Actions minutes are metered. A change that touches only documentation runs
nothing — with six markdown files excepted, because tests assert against
their text (see the `paths` list in that workflow).
