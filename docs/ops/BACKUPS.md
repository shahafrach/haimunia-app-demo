# Backups (box-log)

`.github/workflows/backup-database.yml` dumps the box-log database (schema, data
and roles), encrypts it with a passphrase, and keeps the encrypted file as a
workflow artifact for 90 days. There are no photo buckets any more, so the dump
is the whole backup. The Supabase free plan takes no backups of its own.

The schedule is **on** (daily, with a restore drill on Sundays). It refuses, with
a message naming the secret, if one is missing.

## Repository secrets (names only)

| Name | What it is |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the Management API token the other ops workflows already use. `supabase link` with it lets the CLI connect through its temporary login role, so **no database password or connection string is stored anywhere** |
| `BACKUP_PASSPHRASE` | a long random passphrase that encrypts the dump |

## The passphrase

`BACKUP_PASSPHRASE` was already set in the repository from the earlier setup; the
2026-10-30 run used it as it was. Whoever set it should hold it in a password
manager: a backup is opened with it. If nobody holds it, replace it with a new one
you keep (Settings, Secrets and variables, Actions, update `BACKUP_PASSPHRASE`);
backups from then on use the new one, older artifacts keep the old one.

## Running it

1. **Actions, backup-database, Run workflow**, leave "Also rehearse the restore"
   ticked. Both jobs (`backup`, `restore-drill`) must go green. The log prints
   the dump sizes and the rows restored.
2. The schedule is **on** since 2026-10-30 (02:17 UTC, six days a week a
   backup, Sunday a backup plus the drill). The first manual run passed both
   jobs. If a secret is later deleted the scheduled run fails loudly and says
   which one.

## Restoring

The runbook is at the top of `backup-database.yml` (download the artifact,
`gpg` decrypt with the passphrase (in a workflow, from the secret), empty the target tables, load `data.sql`
with `session_replication_role = replica`). The Sunday drill does exactly that
into a throwaway local Supabase, so the procedure is rehearsed, not hoped for.

## Recovery time and recovery point

Q-50 (2026-11-19). Both are measured or derived, not hoped for.

- **RPO (how much can be lost): up to 24 hours.** One dump a day at 02:17 UTC, so a
  failure just before the next dump loses that day's server rows: posts, reactions,
  memberships, notifications. Members' private training logs are not in it at all;
  they live on their phones (and in their own exports), so a server restore never
  costs a member their log. A shorter RPO needs a paid plan's point-in-time recovery.
- **RTO (how long a restore takes): the drill measures it.** The `restore-drill` job
  times itself from download to the last row check and writes the duration, with a
  table of rows in the dump against rows restored, to the run's summary. Every
  table in the dump must come back with exactly as many rows as the dump holds;
  one row short fails the drill. Target: **under 1 hour** from the decision to
  restore until the data is back, of which the drill's own time is the mechanical
  part. Read the latest Sunday run's summary for the current number; when it grows
  past 30 minutes, look at why before the target is at risk.
- **Backup age**: artifacts are kept 90 days, so the oldest restorable point is
  about three months back.

## Notes

- `docs/ops/MONITORING.md` still describes the photo-bucket half
  (`scripts/backup-storage.mjs`). That script was removed with the buckets.
- Before the first sign-up the dump holds only seeded reference rows; the job
  warns (does not fail) that there are no profiles yet.
