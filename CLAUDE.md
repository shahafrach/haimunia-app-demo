# CLAUDE.md — read this before touching anything

האימוניה: a Hebrew, RTL, offline-first PWA for one CrossFit gym, with an
opt-in Supabase community layer. **It ships to real members.** Despite the
`-demo` in the repository name, `cloud-config.js` points at a production
project holding real profiles, posts and training logs.

For what is true *right now* — version, counts, what is in flight, what is
deliberately open — read **[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)**.
This file is the rules; that one is the state.

---

## Stack

**Buildless vanilla JavaScript, Supabase, Cloudflare Pages, Hebrew RTL PWA.**

No framework. No bundler. No build step. No TypeScript, no JSX, no Sass, no
PostCSS. `index.html` carries the entire stylesheet inline, and `app.js`,
`cloud.js` and `src/*.js` are classic `<script>` tags that share one global
scope. **The repository root is the website** — Cloudflare Pages serves it
verbatim, which is why `functions/_middleware.js` exists to 404 the paths
that should not be public.

If a change seems to need a build step, it is the wrong change. If it seems
to need React, read the file you are about to edit first: it almost
certainly already does what you are about to add.

---

## Rules

These are the ones that have been broken before. Each has a guard.

**Every new CSS rule goes in both dark-theme blocks.** The app ships light
and dark, and the theme is declared three times: `:root{…}` for light,
`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){…} }`
for the OS default, and `:root[data-theme="dark"]{…}` so an explicit choice
wins. A rule that sets a colour in only one of the last two renders one
theme's text on the other theme's background. *Prefer existing tokens*
(`--surface`, `--border`, `--steel`, `--chalk`, `--brass`…) — a rule built
from tokens themes itself and needs no duplicate at all.

**Never edit an applied migration. Forward migrations only.** Supabase
tracks migrations by filename, so editing one that has already run is
invisible: a local `db reset` replays the edited file and passes while
production still carries what the original did. Corrections go in a NEW
migration. `scripts/check-migration-immutability.mjs` enforces this against
the merge base and runs in CI.

**Any new file the app loads goes into the `sw.js` precache list.** Add the
`<script>`/asset and forget the precache entry and the app breaks offline
with no signal. Core files app.js cannot run without go in `REQUIRED_ASSETS`;
anything the app degrades gracefully without (cloud.js and its `src/*` deps,
fonts, icons) goes in `OPTIONAL_ASSETS`. `test/sw-precache.test.mjs` fails on
a `src/*.js` file that is in `index.html` and in neither list.

**No secrets in client files.** Every committed file is served. The
publishable Supabase key and the VAPID *public* key belong in
`cloud-config.js`; a service-role key, a database password or a VAPID
private key never appear in this repository at all. `functions/_middleware.js`
is disclosure control, not a secret store — and git history is history.

**Never store health, payment, phone or email data for members.** Sign-in is
a username mapped to a synthetic `<name>@members.haimuniya.invalid` address
(`usernameToEmail`, cloud.js) precisely so no real address exists to leak.
There is no phone column, no payment column and no health column in the
schema, and there must not be one. Arbox owns bookings and payments; this app
is what happens *after* training.

---

## Desktop

**The staff desktop shell exists, and it is gated on `is_staff()`.**
`src/desktop-layout.js` writes two attributes on `<html>`:
`data-layout="desktop"` when `(min-width: 1024px) and (pointer: fine)`
matches, and `data-staff="1"` when that *and* the viewer is staff. Every
shell rule is prefixed with **both**, and there is deliberately **no rule
keyed on `data-layout` alone**.

**Member layouts on desktop must not change.** That absence above is the
whole mechanism: a member at a laptop matches nothing. The numbers are
measured, not asserted — sidebar 248px at x=892, logging column 560px at
x=300, no context column — by
`scripts/browser-check/desktop-staff-shell.mjs` and `desktop-layout.mjs`.
The 560px logging column never changes width at any breakpoint; only the
staff-home tab widens. If you are about to widen a member surface, read the
argument in the `WIDE DESKTOP` comment block in `index.html` first, and if
you still disagree, raise it rather than changing it.

---

## Sibling drift

**When you fix a rule, search for every twin of it and list them in the PR.**

This codebase's characteristic defect is not a wrong line — it is a right
line with three copies, one of which was missed. A run-detection algorithm in
two files. An expiry predicate in a policy and again in the client. A cap
applied at one call site of three.

So: after the fix, `grep` for the pattern, not for the symptom. Say in the PR
which twins you found, which you fixed and which you deliberately left, with
the reason. "I fixed the one I was shown" is not a finished change.

---

## Parallel work

Several sessions run against this repo at once. These rules are about
merge conflicts, not about style.

**Only one open branch adds a migration at a time.** Two branches each adding
`2026MMDD0001_*.sql` merge cleanly and then apply in an order neither author
intended. Check open PRs before writing one.

**Branches do not edit these files:**

- `CHANGES.md`
- `docs/PROJECT_STATUS.md`
- `docs/handover/SHARED_CONTEXT.md`
- `APP_VERSION` in `app.js` (and therefore `SW_VERSION` in `sw.js`)

Every branch touches them, so every branch conflicts on them. **Put the
changelog entry in the PR description instead** — write it as it should
appear, and it can be lifted verbatim. A consolidation session updates these
four after merges, bumps the version once, and runs `npm run sync-version`.

---

## Automated review

**Every PR gets a Claude review, and `@claude` in a PR comment gets an
answer.** `.github/workflows/claude-review.yml` runs
`anthropics/claude-code-action` on `opened` and `synchronize`, and again on any
PR comment containing `@claude` — the conversation tab or pinned to a line of
the diff. It walks the rules above: the Supabase security surface (RLS
policies, `SECURITY DEFINER` functions, `anon` grants), edits to applied
migrations, sibling drift, a CSS rule missing from a theme block, a new file
missing from the `sw.js` precache list, secrets in client files, and member
health, payment, phone or email data.

To trigger one by hand, comment `@claude` on the PR saying what you want looked
at; a push to the branch re-runs the whole checklist. The workflow needs the
`CLAUDE_CODE_OAUTH_TOKEN` repository secret — without it the job skips with a
notice rather than failing. PRs from forks are skipped. It holds
`contents: read`, so it reads, reviews and comments, but cannot push a fix:
ask it what to change, not to change it.

**It comments; it does not gate.** Every hard rule in this file already has a
deterministic guard that fails the build in `test.yml`. A review finding is a
second reader, not a verdict — and a finding that keeps recurring is a sign
that rule needs a guard, not a louder prompt.

---

## Verification

**Report only what you ran and the real result.** Paste the number the suite
printed. "Tests pass" is not a result; `1940 pass, 0 fail` is.

**If a suite could not run in this environment, name it and say so.** Several
genuinely cannot run in a sandbox — `supabase test db` needs Docker,
`npm run check:drift` needs a linked project and network to the Supabase
project, and the browser checks need Chromium. An honest "I could not run
the pgTAP suite here" is worth more than silence, and far more than a claim
that turns out to be inferred. Never present reasoning as measurement.

The three suites, and what each is for:

```bash
npm test                              # ~10 min, jsdom, the real app.js/cloud.js
cd scripts/browser-check && node run-all.mjs   # real Chromium, layout and a11y
supabase test db                      # pgTAP, RLS enforced for real by Postgres
```

`npm test` cannot see layout — jsdom has none. A claim about geometry that
was not measured in Chromium is a guess.
