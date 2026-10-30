# Backups (box-log)

`.github/workflows/backup-database.yml` dumps the box-log database (schema, data
and roles), encrypts it with a passphrase, and keeps the encrypted file as a
workflow artifact for 90 days. There are no photo buckets any more, so the dump
is the whole backup. The Supabase free plan takes no backups of its own.

The schedule is **commented out**. Until you turn it on the workflow only runs
when you press the button. It refuses, with a message naming the secret, if one
is missing.

## Repository secrets (names only)

| Name | What it is |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the Management API token the other ops workflows already use. `supabase link` with it lets the CLI connect through its temporary login role, so **no database password or connection string is stored anywhere** |
| `BACKUP_PASSPHRASE` | a long random passphrase that encrypts the dump |

## How the passphrase was made (2026-10-30)

It was generated inside the GitHub "New repository secret" form by
`crypto.getRandomValues` and saved there directly. Nobody saw it and it is not
in any password manager. That is deliberate: the only things that ever decrypt
a backup are this workflow's round-trip check and its restore drill, and both
run in GitHub with the same secret. A real recovery runs the same way: a
workflow downloads the artifact, decrypts it with the secret and loads it.

The trade-off: if the GitHub account or the secret is lost, the existing
artifacts cannot be decrypted. To change that, set a new passphrase you also
keep in a password manager; backups from then on use it.

## Running it

1. **Actions, backup-database, Run workflow**, leave "Also rehearse the restore"
   ticked. Both jobs (`backup`, `restore-drill`) must go green. The log prints
   the dump sizes and the rows restored.
2. The schedule (six days a week a backup, Sunday a backup plus the drill) is
   on once the first manual run is green. If a secret is later deleted the
   scheduled run fails loudly and says which one.

## Restoring

The runbook is at the top of `backup-database.yml` (download the artifact,
`gpg` decrypt with the passphrase (in a workflow, from the secret), empty the target tables, load `data.sql`
with `session_replication_role = replica`). The Sunday drill does exactly that
into a throwaway local Supabase, so the procedure is rehearsed, not hoped for.

## Notes

- `docs/ops/MONITORING.md` still describes the photo-bucket half
  (`scripts/backup-storage.mjs`). That script was removed with the buckets.
- Before the first sign-up the dump holds only seeded reference rows; the job
  warns (does not fail) that there are no profiles yet.
