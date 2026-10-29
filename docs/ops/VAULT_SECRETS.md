# Vault secrets for the scheduled Edge Function jobs

`public.cron_invoke_edge_function()` (migration `202609050005_scheduled_jobs`)
reads two Vault secrets. Migrations can only seed placeholders, so until they
are set every Edge Function cron job (week card push, `purge-abandoned-profiles`,
`recap-weekly`) is skipped with a NOTICE.

| Vault secret | Value |
| --- | --- |
| `edge_functions_base_url` | `https://<ref>.supabase.co/functions/v1` |
| `edge_functions_service_role_key` | the project's `service_role` key |

Nobody may see the service role key: no person, no session, no log.

## When to run it

- once, after a project is created (and its migrations applied);
- again, after the `service_role` key is rotated.

## How

Actions → **set-vault-secrets** → *Run workflow*. It needs the existing
`SUPABASE_ACCESS_TOKEN` repository secret and refuses to run without it. The
project is the one in `supabase/PROJECT_REF`.

The job fetches the key from the Management API into memory, masks it, writes
both secrets with `vault.update_secret` (creating them only if missing), then
asks Postgres whether each is set and no longer a placeholder. The job summary
shows only:

```json
{"base_url_set":true,"service_role_key_set":true}
```

Both must be `true`; otherwise the job fails. Afterwards the next cron tick
invokes the functions; `job_health_check()` (see `MONITORING.md`) reports any
that still fail.

Guard: `test/set-vault-secrets-workflow.test.mjs` fails if a step prints,
uploads, caches or summarises the key.
