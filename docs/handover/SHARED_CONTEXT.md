# Shared context — read this first

Written 2026-09-17, end of a long day. Your own half is in
`SESSION_A_SERVER_AND_SAFETY.md` (closed, kept as a record) or
`SESSION_B_CLIENT_AND_PRODUCT.md` (in progress).

## What this is

**Haimunia / האימוניה** — a Hebrew/RTL PWA for one CrossFit club. Buildless
vanilla JS: `index.html` (inline CSS), `app.js` (~7,900 lines, the training
log), `cloud.js` (~21,800, the community half). No bundler, no framework.
Supabase for auth and data, Cloudflare Pages for hosting.

Live: https://haimunia-app.pages.dev
Repo: `haimuniya/haimunia-app-demo` — **private** since 2026-09-17
Supabase: `jajmlyrjlkhclgphbfbb` (free tier)

**v4.72.0** · 171 migrations · 1915 JS tests · 114 pgTAP files, 3510 assertions

## The rules that are not negotiable

1. **Nothing secret is ever committed.** There is no build step: Cloudflare
   Pages publishes the repo root verbatim, so every committed file is a live
   URL. `functions/_middleware.js` now 404s the internal paths, but that is
   disclosure control, not a secret store — the git history is what it is.
   This rule was broken twice on 2026-09-16/17. See A1.
2. **Browser checks never touch production.** `installMockCloud(page, ...)`
   before `page.goto(...)`, and `resolveLocalOnlyTarget()` for the target.
   Never `TARGET_URL`.
3. **Migrations are immutable** once committed —
   `scripts/check-migration-immutability.mjs` enforces it. One documented
   exception (`202609150016`); read its header before considering a second.
4. **Bump `APP_VERSION` in app.js** on any shipped change (a hook mirrors it
   to `SW_VERSION`), or members keep the cached old app.
5. **Arbox owns class scheduling, bookings, payments and attendance.** This
   app reads attendance and does what happens *after* training. Do not build
   booking.
6. **The app is opened after training,** not during. No rest timer, no
   bar-side calculator.

## Hebrew, because it has bitten this codebase repeatedly

- `אחד/ת` is **not a word** — the feminine is irregular (`אחת`). Write it out.
- **Second-person past-tense verbs are homographs.** Never `רשמת/ה`.
- **Third-person past does differ,** so `נכנס/ה` is correct.

## How to verify anything

```
node --test                   # 1915 JS tests, jsdom, ~4 min
supabase start                # docker is on this machine
supabase db reset --local     # replays all 171 migrations from empty, ~3 min
supabase test db --local      # 115 files, 3510 pgTAP assertions, ~10 s
node scripts/browser-check/run-all.mjs   # 45 scenarios, real Chromium
```

`node --test` and `db reset` exceed a 2-minute foreground timeout — background
them. `run-all.mjs` kills any scenario over 8 minutes and reports HUNG
separately from FAIL.

**A green suite is not a deploy.** Nothing in CI applies migrations to
production; `supabase db push --linked --yes` does, by hand. Confirm with
`npm run check:drift`, never with a doc — it runs that same CLI call, names any
migration that is committed-but-unapplied, and exits 2 rather than 0 if it
could not check at all. On 2026-09-17 a security migration had been sitting
committed, tested and unapplied for a day, and was found on a hunch.

## The defect pattern this codebase actually has

**Sibling drift** — a rule fixed in one place and not carried to its twin.
Roughly half of every finding across ten hunt rounds, and it produced five
separate bugs on 2026-09-16/17 alone, three of them written by the session
that had just fixed the first one. Before finishing any fix, grep for the
other call sites. If a rule has N places and you changed one, you have not
finished.

## The second pattern, learned the hard way on 2026-09-17

**Seven things reported success while doing nothing.** All of them passed
review. All were caught by running them for real:

| | looked like | did |
|---|---|---|
| `_redirects` | blocking internal paths | nothing — Pages serves an existing file first |
| `grep "CREATE TABLE public.profiles"` | verifying the dump | failed a perfect backup; pg_dump writes `CREATE TABLE IF NOT EXISTS "public"."profiles"` |
| `tar \| grep -q` under `pipefail` | proving decryption | SIGPIPE — passes on a small archive, dies on a real one |
| `inputs.drill` | gating the restore drill | skipped it; run still green |
| `closeNavMenu()` in open-support | preventing stacked overlays | nothing — `openSupport()` already did it |
| `ALTER DEFAULT PRIVILEGES … FROM public` | closing the anon EXECUTE gap | narrowed it; PUBLIC still grants EXECUTE |
| a CSS reconstruction taking `<style>` … `</style>` | measuring a real layout | took the FIRST of two style blocks. Chips measured 267px against a real 347px, so the measurement said "fits fine" about a row that visibly wraps — and nearly reverted a correct fix (2026-09-17) |

**Falsify your own tests.** Break the code on purpose and confirm the test
goes red. That caught a day-index test passing while `wodEntries` was dropped
entirely, a timing assertion that was a genuine coin flip, and a "fix" for a
bug that did not exist.

**Measure before fixing** — and check the instrument before believing it. A
recorded "21 rebuilds, 289 ms per tap" did not reproduce and pointed at the
wrong code. The opposite also happened: a measurement said a reported wrap did
not reproduce, and the measurement was broken, not the report. The tell was a
CSS variable resolving to empty. If a measurement contradicts something a human
watched happen, suspect the measurement first.

## Declined by the owner — do not re-propose

Streak consolidation · streak nudge redesign · opt-in board ranking ·
finishing `lang="en"` · removing the welcome-modal name field.

## Permanently open, by plan

**Leaked-password protection** will show as a WARN in Supabase's security
advisor forever: it is Pro-plan only, confirmed by trying it. Not fixable on
the free tier and not worth looking at again. Generated passwords achieve the
same thing.
