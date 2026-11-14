# Findings (haimunia-app-demo)

Codes: sibling `haimunia-club/STANDARD.md`. Cursor checks: sibling `docs/audit/CURSOR-CHECKS.md`.

| ID | Source | Code | Severity | Status | Finding | Evidence | Check |
|----|--------|------|----------|--------|---------|----------|-------|
| F-002 | grok-G2 | SEC-7 | low | fixed (PR #170); C2-1 verified on `audit/c2` | Staff actions lacked audit rows; now `club_staff_actions` via `club_staff_log`. | `supabase/migrations/202611140001_club_staff_audit.sql`; tests `0155`, `0157` | C2-1 |
| F-005 | cursor-C2 | PERF-1 | medium | open | Splinter `auth_rls_initplan`: many policies re-evaluate `auth.uid()` per row. | `docs/audit/C2-INVENTORY.md`; local splinter 2026-11-14 | C2 |
| F-006 | cursor-C2 | OPS | low | open | `0153_club_load_test.sql` index EXPLAIN assertion flaky locally. | `supabase test db` on `audit/c2` | C2 |

### C2 notes (2026-11-14)

- Isolation: pass (`0157_c2_audit_isolation_test.sql`).
- Every public table has RLS; all public DEFINER functions have `search_path = ''`.
- Anon EXECUTE allowlist remains `{job_health_status()}` (intentional).
- Advisor WARNs for `job_health_status` anon DEFINER and `training_log_usage` INSERT always-true: intentional, already documented; not opened as findings.
- Full inventory: `docs/audit/C2-INVENTORY.md`.
