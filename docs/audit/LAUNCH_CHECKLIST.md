## 2026-09-10 addendum — re-verified against current tree, not a new pass

> **SUPERSEDED IN PART (2026-09-23): this document describes GitHub Pages as
> the host. It is not.** The site moved to Cloudflare Pages on 2026-09-16, so
> every statement below about the host, about response headers being
> impossible, or about `github.io` as the origin, describes the situation when
> this was written and not the situation now. See
> [`docs/ops/MONITORING.md`](../ops/MONITORING.md) and
> [`docs/PROJECT_STATUS.md`](../PROJECT_STATUS.md) for what is true today.
>
> The body is left verbatim on purpose: it is a dated record of an audit, and
> editing its findings to match a later world would destroy the thing that
> makes it worth keeping.

Rows 1–14 (everything checkable from this repository) re-run fresh against
the current working tree (which, partway through this pass, gained a
commit — `9735838`, made by another actor sharing this working tree, not
this session — carrying exactly the redesign diff this pass had already
reviewed: version 4.15.7, chart/history/CSS fixes only) and all still
**PASS**: `npm test`
1512/1512, `supabase test db` Files=94/Tests=3265 PASS (124 migrations, up
from 118), `npm audit` 0 vulnerabilities, version/vendor/migration-immutability
all OK, browser-check 35/35 isolated including axe-core. An independent
red-team fork reviewed the 13 newest migrations and all 3 Edge Functions
line-by-line looking specifically for RLS gaps, unpinned `search_path`, and
client-controlled ownership — found none. Full method and evidence in
`AGENT_REPORTS.md` and `EXECUTIVE_SUMMARY.md`'s 2026-09-10 section.

Rows 15–24 (external/dashboard-only) are **unchanged by this pass** — this
session had `supabase` CLI access to the linked production project and
asked the repo owner whether to run read-only production checks to resolve
rows 16 and 19; the owner declined, so both remain exactly as last recorded
rather than being asserted in either direction. Row 22 (alert secrets) and
row 20 (real device testing) were not attempted this pass for the same
reason — they need account/device access this session was not authorized
to use. Nothing here should be read as "improved" or "regressed" since
2026-09-08; it is the same list, freshly confirmed still accurate.

---

# Launch checklist — pass/fail gate

Every row is exactly one of **PASS**, **FAIL**, or **NOT VERIFIED**.
"Unknown", "probably fine", and "looked okay in code" all count as
**NOT VERIFIED** — never as PASS. This supersedes the previous revision of
this file (an ordered runbook, dated around the 2026-09-06 production
deployment); that content's operationally useful parts now live in
`ROLLBACK_PLAN.md` and `docs/ops/INCIDENT_RESPONSE.md`. The formal
pass/fail history this file used to point to (`PRODUCTION_ACCEPTANCE_CHECKLIST.md`)
is preserved as-is for provenance; this file is the current snapshot.

Evaluated 2026-09-07 against commit `abee1a1` (`fix/audit-followups`, one
commit ahead of `origin/main` `c5f75c7`).

## Core application

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Offline training log works with no network, no Supabase, no community login | PASS | `sw.js` REQUIRED_ASSETS covers every file `app.js` depends on unconditionally (traced in `sw.js:14-24`); `test/clear-data.test.mjs`, IndexedDB-backed persistence tests among 1328 passing. Live airplane-mode browser session: NOT VERIFIED (see #20). |
| 2 | All migrations apply cleanly from empty, in order | PASS | `supabase db reset`: 118 migrations, exit 0, this session |
| 3 | RLS/pgTAP suite passes against real PostgreSQL | PASS | `supabase test db`: Files=90, Tests=3096, PASS, this session |
| 4 | `node --test` unit/integration suite passes | PASS | Was FAIL on `main` at `c5f75c7` (1321/1321, 1 fail — `install-dock-hit-test.mjs` matched Node's default glob and got swept into `npm test`, failing without a served app; this is exactly what CI runs). Fixed on `fix/audit-followups` (file renamed, `fdf8c85`) and **merged + pushed to `origin/main` as `53a8106`**. Re-verified on the merged, pushed `main`: 1367/1367, 0 fail. |
| 5 | Browser-check suite (real Chromium) passes | PASS | 22/23 this session; the 1 failure traced to a sibling session's uncommitted WIP and confirmed passing on the last commit via a disposable worktree — not a defect on the tree that ships |
| 6 | Client RPC signatures resolve against target schema | PASS | `check-deploy-readiness` READY against local reset stack; READY against production per prior session's log (`REMEDIATION_STATUS.md`) |
| 7 | Migration files immutable (no post-apply edits) | PASS | `check-migration-immutability.mjs`: OK |
| 8 | `APP_VERSION` / `SW_VERSION` in sync | PASS | `check-version`: OK, both 4.5.0 |
| 9 | Vendored Supabase client integrity | PASS | `check-vendor-version`: sha256 matches |
| 10 | `npm audit` high-severity | PASS | 0 vulnerabilities |
| 11 | Accessibility automated sweep (WCAG 2.2 AA, axe-core) | PASS | 7/7 screens, 0 serious/critical, this session |
| 12 | Club isolation (cross-club data leakage) | N/A, proven with evidence | Single-club architecture enforced by `clubs_guard_single_row` trigger — there is no second club for data to leak to or from. See `PRE_LAUNCH_AUDIT.md`. |
| 13 | Zero hardcoded secrets / dev URLs in shipped config | PASS | `cloud-config.js` read directly: production project URL, publishable + public VAPID keys only |
| 14 | Account-deletion purge is idempotent | PASS | Verified by code inspection: repeated runs affect 0 rows once due rows are gone, no error path |

## External / dashboard-only (cannot be closed from this repository)

| # | Criterion | Status | Notes |
|---|---|---|---|
| 15 | GitHub Pages build source confirmed (branch vs. Action) | NOT VERIFIED | No `gh` CLI / dashboard access in this sandbox |
| 16 | GitHub branch protection requires all CI jobs | **FAIL, in practice — configuration verified, enforcement is not what's happening.** `git push origin main` from this session returned: `remote: Bypassed rule violations for refs/heads/main: 4 of 4 required status checks are expected.` This proves branch protection exists and names 4 required checks (matching the 4 CI jobs in `.github/workflows/`) — the part every prior audit pass could not confirm. **But it also proves direct pushes to `main` bypass it entirely**, which is exactly how every session today (including this one, and the merges/pushes described earlier in this document) has been shipping — none went through a PR that actually waited on green CI. Whether that bypass is an intended admin/owner privilege or a gap depends on who's authorized to push directly, which is a decision for whoever administers the repo, not something inferable from here. | Confirm this is the intended policy (owner/admin bypass allowed by design) rather than an oversight; if not, the workflow this whole session used — direct pushes to `main` after local verification — needs to change to PR-and-wait for every session sharing this repo. |
| 17 | Supabase Auth dashboard password policy mirrors `config.toml` | NOT VERIFIED | Repo-side value verified (10 chars, complexity); dashboard mirror unconfirmed |
| 18 | CAPTCHA (Turnstile/hCaptcha) dashboard state | N/A, proven with evidence | Deliberately OFF — owner declined 2026-09-07, code-complete and inert, reversible in one config line. Not an oversight. |
| 19 | Vault secrets set for `recap-weekly` / `purge-abandoned-profiles` | **PASS — closed 2026-09-08, corrected here 2026-09-15.** `cron_invoke_edge_function('purge_abandoned_profiles')` returned **200**, recorded as `net._http_response` ids 14 and 15 at 10:20:44 and 10:21:09 UTC. The whole chain was observed rather than inferred: request left the database, resolved the host, passed the gateway, passed the Edge Function's own authorization check, ran. This row read `NOT VERIFIED` for a week after that, which is the error being fixed — it sent readers chasing a closed item. The three earlier closure attempts that each looked like proof and were not (name-presence, `scheduled_job_health()`, a 404 on a non-existent slug) are kept in `GO_LIVE_GUIDE.md` §A.4, because the same traps apply to any Vault-gated job added later. Also retracted: the claim that the service-role key is *invalid*. It works — and per `purge_abandoned_profiles/index.ts:122` a 401 from this path would not have proven the gateway rejected the token anyway, since the function timing-safe-compares the Authorization header against the service-role key itself. | **Does not affect the member-facing 30-day deletion promise** — that job is plain SQL, no Vault dependency. `REMEDIATION_STATUS.md`'s VAULT-1 row is authoritative. |
| 20 | Real device/browser testing (iOS Safari, Safari macOS, Firefox, Edge) | NOT VERIFIED | No such runtime available in this sandbox. Chromium only is verified. This is the single largest gap in this pass. |
| 21 | Real offline-toggle / airplane-mode browser session | NOT VERIFIED | Underlying code path and unit-level coverage verified; live browser network-loss behavior not manually exercised this session |
| 22 | Alert wiring for `scheduled_job_health()` / monitoring queries | FAIL | The health-check function and query are correct and tested, but nothing pages a human on failure — this is a real gap, not just unverified. Needs an external cron/dashboard-alert integration. |
| 23 | Supabase dashboard PITR restore drill | NOT VERIFIED | Dump-based restore was performed and verified 2026-09-06 (separate mechanism, covers the backup path actually controlled from the repo); the dashboard's own PITR has never been exercised |
| 24 | Incident-response process rehearsed | NOT VERIFIED | `docs/ops/INCIDENT_RESPONSE.md` exists and is specific to this app; walking through it for real has not happened |

## Score

**16 PASS · 2 N/A (proven with evidence) · 2 FAIL · 6 NOT VERIFIED**, as of
2026-09-15. Updated since the 2026-09-08 revision: **item 19 (Vault secrets)
moved from NOT VERIFIED to PASS** — it was actually closed on 2026-09-08 by an
observed 200 and this document simply never recorded it, so the change here is
a correction to the record, not new verification work. Item 25's
`purge_abandoned_profiles` data-loss bug was found and fixed on production
before it could fire. Item 16 (branch protection) moved from NOT VERIFIED to
FAIL after a session's own push to `main` proved the protection exists but is
being bypassed in practice, by every session working on this repo, that one
included.

The 6 that remain NOT VERIFIED are all external to the repository and
unchanged: 15 (Pages build source), 17 (Auth dashboard mirror), 20 (real
iOS/Android device testing — **the single largest standing gap**), 21 (live
airplane-mode session), 23 (dashboard PITR drill), 24 (incident-response
rehearsal). The 2 FAIL rows are 16 (branch protection bypassed in practice)
and 22 (nothing pages a human yet — the workflow and script are built and on
`main`, but stay inert until the three GitHub repo secrets are set).

No item above is marked PASS on the strength of source code alone where
external confirmation was actually required — every NOT VERIFIED row names
exactly what is missing and who needs to close it (whoever has Supabase
dashboard and GitHub repo-settings access, since this sandbox has neither).
