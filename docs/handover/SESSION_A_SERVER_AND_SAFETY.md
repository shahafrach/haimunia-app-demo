# Session A — Server and safety

**CLOSED 2026-09-17.** Everything below was done, and the record of what each
item turned out to be is kept because most of them were not what they looked
like. What is left is listed at the bottom under "Still open".

Read `SHARED_CONTEXT.md` first.

## What A actually found

**A1 — a working join code was published.** `docs/owner-guide/join-qr.png`,
committed 2026-09-16, live at a public URL within the hour because this deploy
publishes the repo root verbatim. Revoked (`active = false`, `revoked_at` set -
redemption needs both). One use, by the owner, five minutes after creating it,
testing his own QR. **No stranger got in.** The folder is out of git and
gitignored, and `functions/_middleware.js` 404s the path.

`_redirects` was the first attempt and **could never have worked**: Cloudflare
Pages resolves a static asset before consulting it, so a rule cannot shadow a
file that exists - which was every path being blocked. Deleted rather than left
as decoration. Middleware runs before asset resolution and can.

**A2 — CI was not failing, it was being cancelled**, by each subsequent push.
That alone explained "4 of 4 required status checks are expected". Underneath
it, two jobs were genuinely broken and neither was what it first looked like:

- `browser-checks` hung for four hours on `make-owner-guide-shots.mjs`, which
  finished normally without closing its target server. Measured: a script that
  THROWS exits cleanly; one that finishes normally with the server open hangs
  forever. `run-all.mjs` had no per-script timeout at all, so one stuck script
  took the whole job - and a job that never finishes reads to branch protection
  as "expected", not "failed". Now killed at 8 minutes and reported HUNG
  separately from FAIL. Both owner-guide build tools moved out of the test glob.
- `edge-function-lockfiles` had nothing to do with Edge Functions: the lockfiles
  recorded the **repo root's package.json** dependencies, because Deno walks up
  and treats the function as part of that workspace. They went stale when the
  node deps were bumped. Each function has a `deno.json` now - 36 lines deleted,
  0 added, dependency pins byte-identical.

**A3 — the audit-log fix verified in production.** Policy is
`admin_actions_read_admin | is_admin()`, one function, gated on `is_admin`.

**A4 — `club_wod` was the only one of its class.** All eight reference tables
now match production exactly. A fresh database reproduces production, which is
what standing up a second club requires.

**A5 — backups exist, and have been restored.** Nightly Mon-Sat, Sunday adds a
restore drill: download the artifact, decrypt, bring up a database from
migrations, empty exactly the tables the dump writes, restore, assert. First
green run 2026-09-17.

The drill found three flaws in the restore runbook before it ever ran in CI -
migrations seed the rows the dump also contains, so the restore died on a
duplicate key; truncating all of public and storage hit `storage.migrations`
and then `storage.buckets_vectors`, both owned by `supabase_storage_admin` and
not truncatable even as postgres, and one permission error rolls the whole
transaction back. The answer is to truncate exactly what the dump restores,
read out of the dump itself.

**A6 — the owner's account is `is_admin` + `head_coach`.** The account
switching is over.

**New, not on the original list: GitHub Pages was still serving the entire
repo** at `haimuniya.github.io`, unprotected, with the Cloudflare middleware
doing nothing for it. Gone once the repo went private - though not immediately;
it took about twenty minutes to tear down.

## The pattern worth carrying into any future work here

Four separate things shipped today reported success while doing nothing:
`_redirects` that Pages ignores · a `CREATE TABLE public.profiles` grep against
a dump that writes `CREATE TABLE IF NOT EXISTS "public"."profiles"` ·
`tar | grep -q` under `pipefail`, which passes on a small archive and SIGPIPEs
on a real one · and `inputs.drill`, which silently skipped the drill and left
the run green.

All four passed review. All four were caught by running them for real. Three of
them were found only because something tried to *use* the thing rather than
read it.

## Still open

- **Node 20 deprecation warnings** on `actions/upload-artifact` and
  `actions/download-artifact`. Harmless today - the runner forces Node 24 - and
  worth pinning to a current release properly, with a real SHA.
- **`scheduled-job-alert` has failed every day since 2026-09-15**, by design:
  it needs three secrets and fails closed. One is `SUPABASE_SERVICE_ROLE_KEY`,
  which bypasses every RLS policy on member data. Nothing is watching the cron
  jobs until this is decided, and it deserves a decision rather than a
  checklist tick.
- **Required status checks are still being bypassed** on every push. Now that
  CI is green end to end, that should stop.
- **The `headcoach` password** is still the weak one, and was in public git
  history until the repo went private.

---

<details>
<summary>The original brief, kept for reference</summary>

## A1 — A join code was published, and is still valid  ⚠️ FIRST

On 2026-09-16 `docs/owner-guide/join-qr.png` was committed. It encodes a
**500-use club join code, valid to 15.3.2027**. Because this deploy publishes
the repo root and the GitHub repo is public, it was live at
`/docs/owner-guide/join-qr.png` within the hour. Confirmed 200 and fetchable
on 2026-09-17.

The file is now out of git and `_redirects` 404s the path, **but un-publishing
is not rotating.** The code was downloadable for a day and still works.

1. Owner deactivates it: ניהול המועדון → הוספת חבר/ה → open
   *"עוד אפשרות: קוד הצטרפות משותף"* → the toggle on that code.
   (RPC: `admin_invite_code_set_active`.)
2. Issue a fresh one. **It does not go in the repo** — send it directly.
3. Check `invite_redemptions` for anyone who joined between 2026-09-16 and the
   deactivation and is not a real member.

Then verify the block actually holds, from outside:

```
for p in docs/owner-guide/join-qr.png docs/audit/RISK_REGISTER.md CHANGES.md; do
  curl -s -o /dev/null -w "$p -> %{http_code}\n" "https://haimunia-app.pages.dev/$p"
done          # all three must be 404
curl -s -o /dev/null -w "app -> %{http_code}\n" https://haimunia-app.pages.dev/
curl -s -o /dev/null -w "cloud.js -> %{http_code}\n" https://haimunia-app.pages.dev/cloud.js
              # these two must still be 200 - _redirects rules are ordered,
              # and blocking too much is the obvious way to get this wrong
```

## A2 — CI is being bypassed on every single push

Every `git push` this week has printed:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - 4 of 4 required status checks are expected.
```

"Expected" means the checks never reported. For most of 2026-09-16 that was
because `supabase start` could not finish — `202609150016` updated a
`club_features` row for `club_wod` that **no migration ever inserted**, so the
chain aborted on every fresh database and the pgTAP gate (113 files, 3487
assertions) simply never ran. `202609160006` fixed that and the local replay
is green.

Nobody has confirmed the hosted runs recover. Do that:

1. Watch the Actions tab on the next push (or dispatch `test.yml`).
2. If a job fails, fix it — that is the work, not a formality.
3. Once green, stop bypassing. A required check that is always overridden is
   a check nobody is running.

`gh` is **not installed** on this machine. Either install it or read the
Actions tab in a browser.

## A3 — Confirm the audit-log fix landed in production

`202609160007` narrowed both the `admin_actions` read policy and
`admin_actions_page()` from `has_perm('community.analytics.view')` to
`is_admin()`. Before it, **a head coach could read the whole audit log** —
password resets, role changes, member removals, including the rows about
themselves. `202609150004` had found this and fixed only the function, never
the policy, and the function is `security invoker` over a table
`authenticated` can `SELECT`, so the policy was always the real gate. Then
`202609150015` re-declared the function from the pre-narrowing body and put the
permission back.

It is verified on a local replay. It is **not** verified against production.
In the Supabase SQL editor:

```sql
select polname, pg_get_expr(polqual, polrelid)
  from pg_policy where polrelid = 'public.admin_actions'::regclass;
-- expect exactly: admin_actions_read_admin | is_admin()

select oid::regprocedure::text, prosrc like '%is_admin%' as gated_on_is_admin
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'admin_actions_page';
-- expect exactly one row, gated_on_is_admin = true
```

## A4 — Find the rest of the "only exists because someone clicked it" class

`club_wod` broke the migration chain because production had a `club_features`
row that **no migration creates** — the admin panel upserted it once, and no
replay reproduces that. `202609160006` seeds it and asserts all 20 module keys
have rows.

That is one instance of a class. Anything a fresh database would lack:
the `clubs` row, `role_permissions` seeds, `onboarding_step_content`,
`intro_carousel_content`, `achievement_definitions`. `supabase db reset
--local` passing is good evidence, but compare a fresh local database against
production table by table and write up anything that exists only in one.

This directly gates standing up a second club (`docs/deploy/PER_CLUB_SETUP.md`),
which is the BoxLog plan.

## A5 — Backups, once the owner adds the secrets

`.github/workflows/backup-database.yml` is written and merged but has never
run. It needs `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` as repo secrets. The
connection string is the **session pooler** on port 5432 — the direct
`db.*.supabase.co` host is IPv6-only on the free tier and GitHub runners are
IPv4-only, and transaction mode on 6543 does not support `pg_dump`:

```
postgresql://postgres.jajmlyrjlkhclgphbfbb:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

After the first run: download the artifact, decrypt it, and confirm
`data.sql` contains real rows. **An untested backup is a guess.** The job
already round-trips the ciphertext in CI, which is not the same as someone
having restored from it.

## A6 — The owner wants his member account to be admin

`profiles.is_admin` has no UI anywhere, deliberately. His community account is
`706d2116-1644-472e-85de-cd6e30b27dee` (`@shahaf_rachmany`). He asked for this
twice, so it is decided — but it is still a privilege grant and belongs in the
audit trail, so do it knowingly:

```sql
update public.profiles set is_admin = true
 where id = '706d2116-1644-472e-85de-cd6e30b27dee';
```

He also needs the **head_coach role separately** — `isCoachTier()`
(`cloud.js:1166`) reads the redeemed role only and excludes admins on purpose,
so the flag alone leaves him without the coach board. That half is a button:
הפיכה למאמן/ת ראשי/ת.

Say plainly that this makes his everyday account a full admin account, and its
password now protects everything the admin password protects.

## Where the schema stands

170 migrations, production at `202609160007`, **zero drift** as of
2026-09-16. pgTAP: 113 files, 3487 assertions, green on a full replay.
`supabase/tests/0112_head_coach_removes_a_member_test.sql` is the newest and
covers the rank guard in both directions.

</details>
