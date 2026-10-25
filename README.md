# BOX-LOG

A free app of private training circles for friends. Log your training on your
own phone, and share what you choose with a small circle of people you know.
Hebrew, right-to-left, installable, and it works offline. No payments, no public
sign-up, no ads. It is a personal project, not a product.

> **This repository ships a live app to real members** once a Supabase project is
> configured in `cloud-config.js`. Never test against it: bring up a local stack
> with `supabase start && supabase db reset`.
>
> **Read first:** [`CLAUDE.md`](CLAUDE.md) holds the rules and
> [`docs/circles/decisions.md`](docs/circles/decisions.md) holds the settled
> product and architecture decisions. Where code and `decisions.md` disagree,
> `decisions.md` wins.

## What it is

- A private training log that lives on the device (IndexedDB): lifts, workouts,
  body weight, measurements, calendar, achievements. It is fully usable with no
  account and no network.
- Optional circles: small private groups of friends, joined by invite link.
  Members share what they choose (PRs, a weekly count) and react to each other.
  A member's privacy setting always wins.
- Sign-in is a username, with no email address stored anywhere.

## Stack

Buildless vanilla JavaScript, Supabase, Cloudflare Pages. No framework, no
bundler, no build step. `index.html` carries the stylesheet inline; `app.js`,
`cloud.js` and `src/*.js` are classic `<script>` tags sharing one global scope.
**The repository root is the website**: Cloudflare Pages serves it verbatim, and
`functions/_middleware.js` 404s the paths that should not be public.

The database lives in `supabase/` (migrations and pgTAP tests). See
`COMMUNITY_SETUP.md` and `docs/ops/MIGRATIONS.md`; migrations go to the database
only through `npm run push:prod`.

## Run it locally

Any static file server works:

```
npx serve .
```

Without a configured `cloud-config.js` the app runs fully offline.

## Tests

Node 22+ and npm. Node is only for the tests; the app itself has no build.

```
npm ci                                          # once, when node_modules is missing
npm test                                        # jsdom, runs the real app.js and cloud.js
cd scripts/browser-check && node run-all.mjs    # real Chromium: layout and accessibility
supabase test db                                # pgTAP, needs Docker
```

`npm test` cannot see layout; a claim about geometry needs the browser checks.
After changing the icon artwork in `assets/app-icon.svg`, regenerate the PNGs with
`node scripts/render-icons.mjs` (uses an installed Playwright, adds no dependency).

## Credit

&copy; Shahaf Rachmany, all rights reserved.
