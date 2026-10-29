# Backups (box-log)

`.github/workflows/backup-database.yml` dumps the box-log database (schema, data
and roles), encrypts it with a passphrase, and keeps the encrypted file as a
workflow artifact for 90 days. There are no photo buckets any more, so the dump
is the whole backup. The Supabase free plan takes no backups of its own.

The schedule is **commented out**. Until you turn it on the workflow only runs
when you press the button. It refuses, with a message naming the secret, if one
is missing.

## Repository secrets needed (names only)

| Name | What it is |
|---|---|
| `SUPABASE_DB_URL` | the box-log project's **Session pooler** connection string |
| `BACKUP_PASSPHRASE` | a long random passphrase that encrypts the dump |

Nothing else. (`SUPABASE_ACCESS_TOKEN` is used by other workflows, not this one.)

## Steps for the owner

1. GitHub, the repository, **Settings, Secrets and variables, Actions, New repository secret**.
2. `SUPABASE_DB_URL`: Supabase dashboard of box-log, **Connect**, **Session pooler**,
   copy the URI (port 5432), put your database password where it says
   `[YOUR-PASSWORD]`. Do **not** use "Direct connection": it is IPv6-only and
   GitHub's runners cannot reach it. The job refuses it with a clear message.
   Forgotten the password? Dashboard, Project Settings, Database, reset it, then copy again.
3. `BACKUP_PASSPHRASE`: generate one (for example `openssl rand -base64 32` on
   your computer) and **also save it in your password manager, not in this
   repository**. A backup you cannot decrypt is not a backup. The repository is
   public and artifacts can be downloaded by any signed-in GitHub account, so
   the encryption is the only protection.
4. **Actions, backup-database, Run workflow**, leave "Also rehearse the restore"
   ticked. Both jobs (`backup`, `restore-drill`) must go green. Read the log: it
   prints the dump sizes and the rows restored.
5. Only now turn the schedule on: in `backup-database.yml` uncomment the
   `schedule:` block (six days a week a backup, Sunday a backup plus the drill)
   and merge that change. If a secret is later deleted the scheduled run fails
   loudly and says which one.

## Restoring

The runbook is at the top of `backup-database.yml` (download the artifact,
`gpg` decrypt with the passphrase, empty the target tables, load `data.sql`
with `session_replication_role = replica`). The Sunday drill does exactly that
into a throwaway local Supabase, so the procedure is rehearsed, not hoped for.

## Notes

- `docs/ops/MONITORING.md` still describes the photo-bucket half
  (`scripts/backup-storage.mjs`). That script was removed with the buckets.
- Before the first sign-up the dump holds only seeded reference rows; the job
  warns (does not fail) that there are no profiles yet.
