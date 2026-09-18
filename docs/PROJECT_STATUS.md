# Project status — what is true right now

Companion to [`/CLAUDE.md`](../CLAUDE.md), which holds the rules. This file
holds the state, and it is the one a session should distrust first: if a
number here disagrees with the repository, the repository is right and this
file is stale. Say so in your PR.

**Last reconciled: 2026-09-18, against `main` at `7f30823`.**

---

## The numbers

| | |
|---|---|
| App version | **4.75.0** (`APP_VERSION` in app.js, mirrored to `SW_VERSION` in sw.js) |
| Migrations | **173** files in `supabase/migrations/` |
| pgTAP suites | **115** files in `supabase/tests/` — assertion total **not measured here** (`supabase test db` needs Docker) |
| JS tests | **1940 passing, 0 failing** (`npm test`, run 2026-09-18 on this branch) |
| Browser scenarios | **47**, all passing (`scripts/browser-check/run-all.mjs`, run 2026-09-18) |
| Tables in `public` | **62**, every one with RLS enabled |
| RLS policies | **137** |
| Functions in `public` | **235**, of which **182** are SECURITY DEFINER |

The schema figures were read from a Postgres 16 instance built by applying
all 173 migrations in filename order. Five of them could not apply in that
container — `202609050005`, `202609060016`, `202609060018`, `202609080003`
(all pg_cron) and `202609120008` (needs PG17's `MAINTAIN` privilege). None of
the five creates a table or a policy, so the table and policy counts are
complete; the function count may be short by the handful those five declare.

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
  Latest applied migration: `202609170003_the_admin_can_switch_push_off`,
  matching the repository. **No drift** (owner-confirmed, 2026-09-18).

---

## What shipped most recently

**Desktop staff shell (2026-09-18, PR #9).** Three columns for staff at
≥1024px with a fine pointer, gated on `is_staff()`, added no table, column,
policy, RPC or migration. Members at a laptop are byte-identical to before —
enforced by a stylesheet in which no rule is keyed on `data-layout` alone.
See the entry in `CHANGES.md` and the section in `docs/DESIGN_HANDOFF.md`.

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

## Declined by the owner — do not re-propose

Streak consolidation · streak nudge redesign · opt-in board ranking ·
finishing `lang="en"` · removing the welcome-modal name field · booking or
payments of any kind (Arbox owns those).
