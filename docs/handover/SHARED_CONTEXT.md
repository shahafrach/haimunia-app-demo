# Shared context — read this first, whichever session you are

Written 2026-09-17. Two sessions run in parallel from here; this file is the
part both of them need. Your own half is in `SESSION_A_SERVER_AND_SAFETY.md`
or `SESSION_B_CLIENT_AND_PRODUCT.md`.

## What this is

**Haimunia / האימוניה** — a Hebrew/RTL PWA for one CrossFit club. Buildless
vanilla JS: `index.html` (inline CSS), `app.js` (~7,900 lines, the training
log), `cloud.js` (~21,800 lines, the community half). No bundler, no
framework. Supabase for auth/data, Cloudflare Pages for hosting.

Live: https://haimunia-app.pages.dev · Repo: `haimuniya/haimunia-app-demo`
Supabase project: `jajmlyrjlkhclgphbfbb`

Current version **4.67.0** (`APP_VERSION` in `app.js`, mirrored to
`SW_VERSION` in `sw.js` — a git hook syncs them; bump on any shipped change).

## The rules that are not negotiable

1. **Nothing secret is ever committed.** The deploy has no build step —
   Cloudflare Pages publishes the repo root verbatim, and the GitHub repo is
   public. Every committed file is a live URL and a public one. This was
   violated on 2026-09-16 and is item A1 in Session A.
2. **Browser checks never touch production.** Every script in
   `scripts/browser-check/` calls `installMockCloud(page, ...)` *before*
   `page.goto(...)`, and resolves its target with `resolveLocalOnlyTarget()`.
   Never `TARGET_URL`.
3. **Passwords live only in Supabase Auth**, as bcrypt hashes. There is no
   self-service reset (login emails are synthetic), so the only path is the
   admin reset Edge Function.
4. **Migrations are immutable** once committed — `scripts/check-migration-immutability.mjs`
   enforces it. The one documented exception is `202609150016`; read its
   header before you consider a second one.
5. **Arbox owns class scheduling, bookings, payments and attendance.** This
   app reads attendance and does everything that happens *after* training. Do
   not build booking.
6. **The app is opened after training,** not during. No rest timer, no
   bar-side calculator.

## Hebrew, because it has bitten this codebase repeatedly

- `אחד/ת` is **not a word.** The feminine is irregular (`אחת`), so the slash
  form is wrong. Write it out, or rephrase.
- **Second-person past-tense verbs are homographs** in Hebrew — `רשמת` is both
  genders. Never write `רשמת/ה`.
- **Third-person past does differ**, so `נכנס/ה` is correct and expected.

## How to verify anything

```
node --test                      # 1863 JS tests, jsdom. ~4 min.
supabase start                   # docker is on this machine
supabase db reset --local        # replays every migration from empty, ~3 min
supabase test db --local         # 113 files, 3487 pgTAP assertions, ~10 s
node scripts/browser-check/run-all.mjs    # real Chromium, mocked backend
```

`supabase db reset` and `node --test` both exceed a 2-minute foreground
timeout — background them.

**A green `node --test` is not a deploy.** Nothing in CI applies migrations to
production; `supabase db push --linked --yes` does, by hand. Always confirm
with `supabase migration list --linked` rather than believing a doc.

## The defect pattern this codebase actually has

**Sibling drift** — a rule fixed in one place and not carried to its twin.
Roughly half of every finding across ten hunt rounds, and it produced three
separate bugs on 2026-09-16 alone, two of them written the same day by the
session that had just fixed the first one. Before you finish any fix, grep for
the other call sites. If a rule has N places and you changed one, you have not
finished.

## Declined by the owner — do not re-propose

Streak consolidation · streak nudge redesign · opt-in board ranking ·
finishing `lang="en"` · removing the welcome-modal name field.

## Still the owner's to do, not yours

- Rotate the `headcoach` password — it is still the weak one it was created
  with, and the session that set it up knows it. ניהול המועדון → חברים →
  איפוס סיסמה
- Change the temporary admin password
- Set his own `display_name` to `שחף רחמני`. The handle can never contain a
  space (`profiles_handle_check` is `^[a-zא-ת0-9_]{3,24}$`), so the underscore
  is not removable and is not the problem — `nameHtml()` falls back to
  `@handle` only when `display_name` is empty.
- Send the owner `docs/owner-guide/` (on disk, deliberately not in git)
