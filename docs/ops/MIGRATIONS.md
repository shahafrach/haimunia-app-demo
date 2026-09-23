# How a migration reaches production

**Status: manual, and honestly so, until 2026-10-01.**

The right answer is a CI job that applies migrations after `check:drift`
passes, so no human is ever the thing standing between a merge and the
database. It cannot be built today: GitHub Actions minutes ran out on
2026-09-19 and reset on **2026-10-01**, and every job in this repository
currently fails in about two seconds with zero steps. A workflow written now
would sit red and unrun, and "we have a deploy gate" would become the most
dangerous kind of false belief — the same shape as launch-readiness **B2**,
where six migrations the client already called had never been applied and
nothing noticed.

So the gate is local, it refuses rather than warns, and it is one command:

```bash
npm run push:prod
```

That is the whole procedure. The rest of this file is what it checks, why, and
the two rules it cannot check for you.

---

## The rule it cannot check: one migration at a time

**Before you write a migration, check that no other open PR adds one.**

```bash
gh pr list --state open --json number,title --jq '.[] | "#\(.number) \(.title)"'
gh pr diff <n> --name-only | grep supabase/migrations/
```

This binds when you *write* a migration, not when you push one — by the time
it is on `main` the question has already been decided, which is why
`push:prod` does not test it.

Two branches each adding `2026MMDD0001_*.sql` merge cleanly, because they touch
no common line, and then apply in an order neither author intended. Worse, if
they land on the same version prefix, Supabase treats the second as already
applied and it **never runs** — silently. That is not hypothetical here:
`202609220007` was taken twice, the announcement feed-card migration never
reached production, and it was found only when a branch carrying both files hit

```
duplicate key value violates unique constraint "schema_migrations_pkey"
Key (version)=(202609220007)
```

It recurred within hours: PR #57 added a second `202609230001` while `main`
already had one.

**Pick the next free version by looking, not by assuming:**

```bash
ls supabase/migrations/ | tail -3
```

---

## The rule it cannot check: forward migrations only

Never edit, rename or delete a migration that has been applied. Supabase
tracks migrations by filename, so editing one that already ran is invisible: a
local `db reset` replays the edited file and passes while production still
carries whatever the original did. Corrections go in a **new** migration.

A rename is a delete plus an add, and counts.

---

## What `push:prod` refuses, and why

| It refuses when | Because |
|---|---|
| you are not on `main` | Production must only receive **merged** migrations. SQL pushed from a branch is SQL no reviewer saw, and everyone else's `check:drift` will then report it as "applied but NOT in the repo" — which reads as somebody having run SQL by hand. |
| `main` is ahead of or behind `origin/main` | A migration pushed from a `main` that does not match the remote is SQL no other clone contains. |
| the working tree is dirty | What is on disk is what gets applied. |
| `check-migration-versions` fails | Two files share a version prefix; the second would silently never run. |
| `check-migration-immutability` fails | An applied migration was edited, deleted or renamed. |
| production has migrations the repo does not | Somebody ran SQL by hand. Pushing would layer new changes onto a database whose real state nobody has written down. **This is the one failure that gets worse after a push, not better.** |

If there is nothing to apply it says so and exits 0. Running it when production
is already current is free and is a reasonable way to check.

Before it applies anything it prints each pending migration — filename, line
count, every schema-changing statement, and a warning if any of them is a
`drop`, `truncate` or `delete` — and then waits for you to type the word
`apply`. It will not run unattended: without a terminal and without `--yes` it
refuses, because reading the plan is the point.

```bash
npm run push:prod -- --dry-run   # show the plan, apply nothing
npm run push:prod -- --yes       # only when you have already read the plan
```

After the push it re-runs `check:drift` and fails if the result is not clean.
A push that reports success while drift still disagrees is exactly the state
B2 lived in.

---

## The two guards it runs

Both landed in #58, after each caught a defect the repository could not
otherwise see.

**`scripts/check-migration-versions.mjs`** — fails when two migration files
share a version prefix. It has two halves: a plain scan of the directory, and a
comparison of what this branch added against what the base branch added since
they diverged. The second half compares against the base **tip**, not the merge
base, because the colliding file arrives on `main` *after* the merge base — a
merge-base comparison passes and is the trap.

**`scripts/check-migration-immutability.mjs`** — fails when an applied
migration is edited, and now also when one is **missing**. It used to iterate
the files present on disk, so a deleted or renamed migration had nothing to
iterate over; that is precisely why the `202609220007` rename sailed through
it. It walks the merge base's file list instead.

Run either alone:

```bash
npm run check:versions
npm run check:immutable
```

---

## The full sequence, for a migration from scratch

1. **Check the slot.** No other open PR adds a migration (above). Pick the next
   free version by listing the directory.
2. **Write it forward.** Never edit an applied file.
3. **Prove it locally.** `supabase db reset --local` must apply the whole chain
   from scratch, then `supabase test db` must pass. A migration that only works
   against your current local database is not proven.
4. **Open the PR, and say in it which suites you ran and what they printed.**
   CI is dark until 2026-10-01, so the person merging is the only evidence there
   is. `1940 pass, 0 fail` is a result; "tests pass" is not.
5. **Merge**, then `git checkout main && git pull`.
6. **`npm run push:prod`**, read the plan, type `apply`.
7. **Record it** — add a line to [the push log](#the-push-log) below, and to
   the next consolidation entry. What was applied, when, and by whom is the
   only audit trail this project has while the push is manual, and a PR
   description alone is not one: nobody can read the history of production
   out of thirty PR bodies.

---

## When the minutes come back — 2026-10-01

The local gate stays; a CI job is added beside it, not instead of it.

The shape to build, and the reason for each part:

- Triggered on push to `main`, touching `supabase/migrations/**` only.
- Runs both guards and `check:drift` **first**, and stops if drift shows
  anything applied-but-not-in-repo.
- Applies with `supabase db push --linked --yes`, using `SUPABASE_DB_URL` from
  repository secrets.
- Re-runs `check:drift` afterwards and **fails the job** if it is not clean.
- Refuses loudly if the secret is missing, rather than skipping quietly —
  the rule `backup-database.yml` already follows. A deploy job that reports
  green while deploying nothing converts "we have no gate" into "we think we
  have a gate".

Keep `push:prod` working after that. It is how you apply a migration when the
runner is down, the quota is out, or you need to watch it happen — and it is
the only version of this gate that has actually been exercised.

---

## The push log

Append-only. One line per `push:prod` run, newest last. Add yours in the same
commit as the work, or immediately after the push — a log written from memory
a week later is the thing this exists to replace.

The columns are what you cannot reconstruct afterwards: `check:drift` can tell
you a migration IS applied, never **when**, by **whom**, or on **whose
approval**. Two sessions have pushed to this project on one day; without the
last column there is no way to tell an approved push from an assumed one.

| Applied (UTC) | Versions | Pushed by | Approved by | How |
|---|---|---|---|---|
| 2026-09-23 ~05:0x | `202609220006`, `202609220007` | session A | session A's user, per-push | `supabase db push` |
| 2026-09-23 ~05:5x | `202609220008` | session A | session A's user, per-push | `supabase db push` |
| 2026-09-23 ~06:1x | `202609230001`, `202609230002` | session A | session A's user, per-push | `supabase db push` |
| 2026-09-23 ~07:4x | `202609230003` | session B | session B's user, per-push after reading the statement summary | `supabase db push --linked --yes` |
| 2026-09-23 (before 10:00) | `202609230004`, `202609230005` | session B | session B's user — but `…04` was session A's migration and session A's user had not approved it (see below) | `npm run push:prod` |
| 2026-09-23 11:2x | `202609230006`, `202609230007` | session A | session A's user, after reading the `--dry-run` plan | `npm run push:prod --yes` |
| 2026-09-23 ~11:5x | `202609230008` | session B | session B's user, per-push, having been told the board would go red | `npm run push:prod --yes` |

Nothing pending: `check:drift` reads **192 migrations, repo and database
agree**.

### Two things this log exists because of

**`202609230003` had no entry when this log was written.** It was applied to
production and nothing recorded who pushed it or on whose approval; the row
was reconstructed from `supabase migration list --linked`, which can say only
that it IS applied. It has since been filled in by the session that pushed it
— session B, on its own user's approval, before `push:prod` existed, with
`supabase db push --linked --yes` directly.

That it could be filled in at all is luck: the operator was still in the room.
A day later nobody would have been able to, and the row would have stayed
`not recorded` forever. That gap is the whole argument for the table.

**A migration was pushed on the wrong user's approval.** `202609230004` was
written by session A and pushed by session B, bundled with session B's own
`…05`, on session B's user's approval. The migration was sound and its pgTAP
was green, and no harm came of it — but `push:prod` applies **everything
pending**, not just the migration you came to push, so bundling somebody
else's work is the default behaviour rather than a mistake you have to make.
Read the plan: it lists every version it is about to apply, and anything in
that list that is not yours needs its author's user to have said yes.

*(Sessions are named A and B here because they are transient; what matters is
that they were different operators with different approvals, not which was
which.)*

