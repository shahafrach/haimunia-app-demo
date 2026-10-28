# CLAUDE.md — read this before touching anything

A Hebrew, RTL, offline-first PWA for training logs shared in small private
circles of friends. Free, no payments, no public sign-up. It is a personal
project, not a product.

**Every session reads [`docs/circles/decisions.md`](docs/circles/decisions.md)
first.** It holds the settled product and architecture decisions; the reasoning
and what would reverse each is in [`docs/journal.md`](docs/journal.md). The
work plan is [`docs/circles/audit.md`](docs/circles/audit.md). This file is the
rules; those are the decisions. Much of the code still reflects the earlier
gym app until the strip session removes it — where code and decisions.md
disagree, decisions.md wins.

---

## Stack

**Buildless vanilla JavaScript, Supabase, Cloudflare Pages, Hebrew RTL PWA.**

No framework. No bundler. No build step. No TypeScript, no JSX, no Sass, no
PostCSS. `index.html` carries the entire stylesheet inline, and `app.js`,
`cloud.js` and `src/*.js` are classic `<script>` tags that share one global
scope. **The repository root is the website** — Cloudflare Pages serves it
verbatim, which is why `functions/_middleware.js` exists to 404 the paths
that should not be public.

New circles modules start with `// @ts-check`; database types come from
`supabase gen types` into a `.d.ts` referenced from JSDoc. That is type
checking without a build step.

If a change seems to need a build step, it is the wrong change. If it seems
to need React, read the file you are about to edit first: it almost
certainly already does what you are about to add.

---

## Rules

These are the ones that have been broken before. Each has a guard.

**Colors live in one place: the token block.** `index.html` carries a single
`<style id="tokens">` with primitives (`--p-*`), semantic tokens (`--color-*`)
and component tokens (`--btn-*`, `--card-*`…). Theme-dependent values are
written once with `light-dark()`, derived ones with `color-mix()`; `data-theme`
(light, dark, or absent for the system) switches `color-scheme` and
`data-palette` picks one of five palettes. A rule outside the block uses
`var(--color-…)` only, never a hex, `rgb()`, `hsl()` or named color, in CSS, in
an inline `style`, or in JS. Canvas code (share cards) reads tokens through
`getComputedStyle` at render time. There are no per-theme color blocks to keep
in sync. `test/design-tokens-guard.test.mjs` fails on a color literal outside
the block, and `test/design-contrast.test.mjs` fails if a palette drops below
WCAG 2.2 AA (4.5:1 text, 3:1 UI parts).

**Migrations reach the database through `npm run push:prod`, never by hand.**
It refuses unless you are on a clean, in-sync `main`, both migration guards
pass, and the database has nothing the repository does not — then shows you
every schema-changing statement and waits for you to type `apply`. The full
procedure is **[`docs/ops/MIGRATIONS.md`](docs/ops/MIGRATIONS.md)**. Sessions
without an explicit instruction never run migrations or link to a database.

**Never edit an applied migration. Forward migrations only.** Supabase
tracks migrations by filename, so editing one that has already run is
invisible: a local `db reset` replays the edited file and passes while the
database still carries what the original did. Corrections go in a NEW
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

**Never store email addresses for members.** Sign-in is a username mapped to
a synthetic `<name>@members.haimuniya.invalid` address (`usernameToEmail`,
cloud.js) precisely so no real address exists to leak. No email, no SMTP.
Health, payment and phone data are banned too: there is no phone, payment or
health column in the schema, and there must not be one. Body weight never
leaves the device.

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

Several sessions may run against this repo at once. These rules are about
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
appear, and it can be lifted verbatim. A consolidation session (the closing
session after each wave) updates these four after merges, bumps the version
once, and runs `npm run sync-version`.

**A branch that ADDS a file to a directory something else enumerates can
break main while git reports no conflict.** The directories are
`.github/workflows/`, `supabase/migrations/`, `supabase/tests/`,
`scripts/browser-check/` and `src/` — each is read from disk by something
that then asserts about the whole set: `run-all.mjs` discovers every check in
its directory, `sw.js`'s precache list and `test/sw-precache.test.mjs` cover
every `src/*.js` in `index.html`, `supabase start` applies every migration in
order, `supabase test db` runs every file in `supabase/tests/`, and the
workflow tests read every file in `.github/workflows/`. Two branches adding
different files touch no common line, so git merges them silently, and the
suite that matters — the one run on the *merge result* — is the one neither
branch ran. **Before merging: update the branch from `main` and wait for all
checks to go green on that merge.** A green run on a branch that is behind
`main` proves nothing about either file's new neighbours.

---

## Automated review

**Every PR gets one Claude review when it is opened, and `@claude` in a PR
comment gets an answer.** `.github/workflows/claude-review.yml` runs
`anthropics/claude-code-action` on `opened`, and again on any PR comment
containing `@claude`. It walks the rules above: the Supabase security surface
(RLS policies, `SECURITY DEFINER` functions, `anon` grants), edits to applied
migrations, sibling drift, a CSS rule missing from a theme block, a new file
missing from the `sw.js` precache list, secrets in client files, member email,
health, payment or phone data, and cross-circle reads.

It comments; it does not gate. Every hard rule here should have a
deterministic guard that fails the build; a finding that keeps recurring means
that rule needs a guard, not a louder prompt. A push does NOT re-run the
checklist; comment `@claude` when a push is worth a second look. The workflow
needs the `CLAUDE_CODE_OAUTH_TOKEN` repository secret and skips without it.

---

## Verification

**Report only what you ran and the real result.** Paste the number the suite
printed. "Tests pass" is not a result; `1940 pass, 0 fail` is.

**If a suite could not run in this environment, name it and say so.** Several
genuinely cannot run in a sandbox — `supabase test db` needs Docker,
`npm run check:drift` needs a linked project and network, and the browser
checks need Chromium. An honest "I could not run the pgTAP suite here" is
worth more than silence, and far more than a claim that turns out to be
inferred. Never present reasoning as measurement.

The three suites, and what each is for:

```bash
npm test                              # ~10 min, jsdom, the real app.js/cloud.js
cd scripts/browser-check && node run-all.mjs   # real Chromium, layout and a11y
supabase test db                      # pgTAP, RLS enforced for real by Postgres
```

`npm test` cannot see layout — jsdom has none. A claim about geometry that
was not measured in Chromium is a guess.

---

## Budget rules

**The usage budget is limited. Work efficiently.** A session that spends its
budget re-running a green suite has no budget left for the change it was
asked to make.

**Skip `npm ci` if `node_modules` already exists.** Run it when `node_modules`
is missing, or when a change touches `package.json` or `package-lock.json`.

**While working, run only what relates to the change.** One test file, one
browser scenario — `node --test test/<the-one>.test.mjs`, or
`node scripts/browser-check/<the-one>.mjs`. The whole suite is a final check,
not a feedback loop.

**At the end of a code session, run the full `npm test` once and the browser
checks once,** both in the foreground, and wait for each to finish. A suite
that was started and not read is budget spent for no result. A docs-only
session runs only the tests that read the files it changed.

**Never start background watchers, sleep loops or repeated polling.**

**Never run the same suite twice unless a fix changed code.** A second
identical run cannot tell you anything the first did not.

**If `community-render-cost` fails, note it once and move on.** It is the one
check that reports differently on a loaded machine. Say it failed, say what it
printed, and do not re-run it hunting for a green.

**Keep the final report short.** The suite numbers, what changed, what you
could not run and why.
