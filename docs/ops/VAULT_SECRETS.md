# Vault secrets for the scheduled Edge Function jobs

`public.cron_invoke_edge_function()` (migrations `202609050005_scheduled_jobs`,
`202611160001_edge_cron_secret`) reads three Vault secrets. Migrations can only seed placeholders, so until they
are set every Edge Function cron job (week card push, `purge-abandoned-profiles`,
`recap-weekly`) is skipped with a NOTICE.

| Vault secret | Value |
| --- | --- |
| `edge_functions_base_url` | `https://<ref>.supabase.co/functions/v1` |
| `edge_functions_service_role_key` | the project's `service_role` key |
| `edge_functions_cron_secret` | a random cron secret; the same value is the Edge Function secret `EDGE_CRON_SECRET` |

The cron calls send `edge_functions_cron_secret` when it is set, and the
`service_role` key only while it is still its placeholder. `notif_push_send`
and `purge_abandoned_profiles` accept either (`_shared/cronAuth.mjs`,
constant-time).

Why a separate secret (F-023): from about 2026-11-13 every cron call answered
401, because the `service_role` key in the Vault and the one the platform
injects into the functions were no longer the same value, and nothing in this
repository controls the latter. The cron secret is written to both places by
the same run, so its two copies cannot drift apart.

Nobody may see a key or the cron secret: no person, no session, no log.

## When to run it

- once, after a project is created (and its migrations applied);
- after the migrations of a release that adds a Vault secret (`202611160001`);
- again, after a key is rotated. Every run also rotates the cron secret.

## How

Actions → **set-vault-secrets** → *Run workflow*. It needs the existing
`SUPABASE_ACCESS_TOKEN` repository secret and refuses to run without it. The
project is the one in `supabase/PROJECT_REF`.

The job fetches the keys from the Management API into memory and masks them.
It then makes a read-only diagnosis, compares the copies by the first 8 hex
characters of each value's SHA-256, and records the result. It writes the base
URL and the `service_role` key with `vault.update_secret` (creating them only
if missing). Then it generates a new cron secret and writes it to the Edge
Function secrets (`EDGE_CRON_SECRET`) and then to the Vault. Finally it asks
Postgres whether each secret is set and no longer a placeholder, and compares
the cron secret's two copies. The job summary shows only booleans and hash
prefixes:

```json
{
  "base_url_set": true,
  "service_role_key_set": true,
  "cron_secret_set": true,
  "cron_secret_matches_functions": true,
  "diagnosis_before": {
    "legacy_service_role": "1a2b3c4d",
    "new_secret_keys": { "default": "5e6f7a8b" },
    "vault": { "service_role_key": "1a2b3c4d", "cron_secret": "…" },
    "functions": { "listed": true, "SUPABASE_SERVICE_ROLE_KEY": "5e6f7a8b", "EDGE_CRON_SECRET": null },
    "vault_key_is_legacy_key": true,
    "functions_key_is_legacy_key": false,
    "functions_key_is_a_new_secret_key": true
  }
}
```

The four booleans at the top must be `true`; otherwise the job fails.
`diagnosis_before` says which key each side held before the run, which is how
F-023 is explained without anyone seeing a key. Afterwards the next cron tick
invokes the functions; `job_health_check()` (see `MONITORING.md`) reports any
that still fail.

Guard: `test/set-vault-secrets-workflow.test.mjs` fails if a step prints,
uploads, caches or summarises a key or the cron secret.
