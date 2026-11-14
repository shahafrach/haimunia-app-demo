# C2 inventory — 2026-11-14

Local Supabase security / advisor review for the circles + club surface on `audit/c2`.

## Schemas

App data lives in `public`. Supporting / platform schemas in use: `auth`, `storage`, `extensions`, `cron`, `realtime`, `graphql_public`, `vault`. pgTAP helpers use `extensions` + `tests` in the test role.

## RLS

Every `public` table has row-level security enabled (asserted by existing leak / schema guards; re-checked this pass).

### Tables with RLS and no client policies

These keep RLS on and rely on grants + SECURITY DEFINER / service_role paths only (no `anon` / `authenticated` policies):

- `bug_reports`
- `circle_invites`
- `club_staff_actions`
- `edge_function_invocations`
- `invite_attempts`
- `invite_codes`
- `invites`
- `job_health_state`
- `rate_limits`
- `recovery_attempts`
- `recovery_codes`
- `request_idempotency`
- `reset_requests`
- `transfer_attempts`
- `transfer_blobs`

## SECURITY DEFINER

All public DEFINER functions set `search_path = ''` (pinned by `0135_definer_guard_test.sql`).

## Anon EXECUTE

Allowlist remains `{job_health_status()}` only — intentional (keepalive / job health). Everything else is revoked from `anon`.

## C2-1 (staff audit)

Verified: club staff paths write `club_staff_actions` via `club_staff_log` (`202611140001_club_staff_audit.sql`). Covered by `0155_club_staff_audit_test.sql` and isolation re-check in `0157_c2_audit_isolation_test.sql` (announcement post / unpin / delete, `remove_member`).

## Advisors (local splinter 2026-11-14)

| Level | Item | Notes |
|-------|------|--------|
| WARN | `job_health_status` anon DEFINER | Intentional; documented; not opened as a finding. |
| WARN | `training_log_usage` INSERT always-true | Intentional insert-only anon usage counter; documented; not opened. |
| WARN | `auth_rls_initplan` | Many policies re-evaluate `auth.uid()` per row → **F-005** (open, PERF-1). |
| INFO | `unused_index` | Advisor noise / candidate cleanup; not opened as a finding this pass. |

## Tests added

- `supabase/tests/0157_c2_audit_isolation_test.sql` — A/B private_records isolation, non-member club opacity, anon privacy, club vs friends feed separation, and C2-1 staff-audit writes.
