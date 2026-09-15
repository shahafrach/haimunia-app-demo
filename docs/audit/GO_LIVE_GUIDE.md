# Go-live guide

Ordered, actionable steps to move from the current **CONDITIONAL**
verdict (`PRE_LAUNCH_AUDIT.md`, score 78/100) to **READY**, and what to do
once real members are actually in. Nothing here duplicates the audit
itself — this is the "now go do it" version. Each item names who can do it
(you, from a phone/laptop with dashboard access — none of these need a
developer, and none are things I can do from this sandbox).

## A. Must do before letting real members in

These are the items keeping the verdict at CONDITIONAL. All are external
to the repository — nothing here is a code fix.

### 1. Real device smoke test (~15 minutes, do this first)

No device has run this app outside Chromium. Do this on your own phone,
installed as a PWA, before anyone else's:

1. Open the site in Safari (iPhone) → Share → **Add to Home Screen**.
   Confirm it installs with the right icon and name, opens full-screen
   (no Safari chrome), and the splash matches `manifest.json`'s
   `background_color`.
2. Log a set from a completely fresh app (Add tab). Confirm it saves and
   shows in History.
3. Turn on Airplane Mode. Log another set, edit one, delete one. Confirm
   nothing errors and the UI doesn't hang.
4. Turn Airplane Mode off. Confirm the app doesn't lose or duplicate
   anything, and (if you have Community configured) that any queued sync
   goes through.
5. Join/open Community: view feed, make a post, react, comment, RSVP to an
   event if one exists, join a challenge, change a notification
   preference.
6. Fully close the app (swipe away), reopen from the home screen icon.
   Confirm it comes back to a working state, not a blank/stuck screen.
7. Repeat steps 1–6 once on an Android phone in Chrome. iOS PWA behavior
   is the more failure-prone of the two — Android is the cheaper
   confirmation, not a substitute for it.

If anything breaks here, it's a real finding this audit could not surface
— report it back before going further down this list.

### 2. Confirm GitHub Pages deploy mechanism (~5 minutes)

GitHub repo → **Settings → Pages**. Confirm:
- What branch/folder Pages actually builds from (this determines whether
  pushing to `main` is itself a production deploy, or whether a separate
  step is needed).
- Repo → **Settings → Branches** → confirm branch protection on `main`
  requires the `node-tests`, `browser-checks`, `migration-check`, and
  `edge-function-lockfiles` CI jobs before merge. If it doesn't, a future
  merge could ship broken code without anyone noticing — this is the one
  structural gate keeping `main` trustworthy.

### 3. Confirm Supabase Auth dashboard settings mirror the repo (~2 minutes)

Supabase dashboard → **Authentication → Providers/Settings** for project
`jajmlyrjlkhclgphbfbb`:
- Minimum password length **10**, complexity **lowercase + uppercase +
  digits** — must match `supabase/config.toml` (`minimum_password_length`,
  `password_requirements`), which is documented as local/CI-only and does
  **not** by itself configure the live project.
- Confirm CAPTCHA (Turnstile/hCaptcha) is intentionally left off — this was
  a deliberate decision (`cloud-config.js:51-59`), not something to "fix"
  unless you're reversing that call.

### 4. ~~Confirm the two Vault-gated cron jobs~~ — **CLOSED 2026-09-08, nothing to do**

**Resolved and verified — do not spend time on this row.** This section is
kept (rather than deleted) because it names the three *wrong* ways to check
this, each of which was tried and each of which silently reported success,
and that reasoning is worth preserving. But the item itself is closed:
`cron_invoke_edge_function('purge_abandoned_profiles')` returned **200**,
recorded as `net._http_response` ids 14 and 15 at 10:20:44 and 10:21:09 UTC
on 2026-09-08. That is the entire chain observed end to end rather than
inferred from a proxy: the request left the database, resolved the host,
passed the gateway, passed the Edge Function's *own* authorization check,
and ran. `REMEDIATION_STATUS.md`'s VAULT-1 row is the authoritative record.

Corrected here on 2026-09-15: this section and `LAUNCH_CHECKLIST.md` row 19
both still read `NOT VERIFIED` / "confirmed broken" for a week after that
200 was observed, which sent a reader chasing a closed item. The earlier
text claiming the service-role key is **invalid** (on the strength of a 401)
is also wrong twice over and is retracted: the key works, and per
`purge_abandoned_profiles/index.ts:122` a 401 from this path does not even
prove the gateway rejected the token — the function timing-safe-compares the
Authorization header against the service-role key itself, so the gateway can
accept a valid key and the function still refuse it as the wrong one.

**Three closure attempts that each looked like proof and were not** — worth
keeping, because the same traps apply to any Vault-gated job added later:

1. *Checking the secret names exist.* Useless:
   `202609050005_scheduled_jobs.sql:170-181` creates both names, with
   committed placeholder values, on every stack including a fresh local one.
2. *Checking `scheduled_job_health()`.* Useless for this specific failure:
   the gate inside `cron_invoke_edge_function()` refuses with `raise notice`,
   not an exception, so the cron run records `succeeded` either way.
3. *Reading a 404 as "the transport works".* Useless: Supabase's gateway
   routes before it authorizes, so a wrong key against a deliberately
   non-existent slug 404s exactly like a right one.

The two genuine failures found underneath all that, both since fixed: the
service-role key needed re-setting, and **two of the three Edge Functions had
never been deployed at all** — the nightly purge had been POSTing to a 404
for weeks. `main` now carries `scripts/check-edge-functions-deployed.mjs` as
a hard CI gate plus a `deploy-edge-functions.yml` workflow so that cannot
recur silently.

**Still useful as ongoing monitoring** (not as a launch gate) — after any
scheduled run, `purge-abandoned-profiles` daily at 03:31 UTC and
`recap-weekly` Mondays 05:11 UTC:

```sql
select * from net._http_response order by created desc limit 20;

select * from cron.job_run_details
where jobid in (select jobid from cron.job
                where jobname in ('recap-weekly','purge-abandoned-profiles'))
order by start_time desc limit 5;
```

An empty `net._http_response` after a scheduled run has passed means the gate
started refusing again — that is a regression of VAULT-1, and
`docs/ops/MONITORING.md` §4 explains why `job_run_details` alone will keep
saying `succeeded` through it.

### 5. Wire an actual alert — drafted and locally tested, needs your secrets

**Done, pending configuration.** `.github/workflows/scheduled-job-alert.yml`
+ `scripts/check-scheduled-job-health.mjs` now exist: a daily (06:00 UTC)
GitHub Action that calls `scheduled_job_health()` over the production
REST API and posts to a webhook if any job comes back unhealthy —
including if the check itself can't run at all (missing config, network
failure), which alerts rather than silently reporting "fine." Tested
locally against the local Supabase stack: correctly reports unhealthy jobs
(exit 1), correctly reports a broken config as its own failure (exit 2,
not success), correctly falls back to printing when no webhook is
configured yet.

**What's left is three GitHub repo secrets** (Settings → Secrets and
variables → Actions), not a developer task:
- `SUPABASE_URL` — the production REST URL
- `SUPABASE_SERVICE_ROLE_KEY` — `scheduled_job_health()` is service_role-only
  by design; never put this in a workflow file itself, only the secrets
  store
- `ALERT_WEBHOOK_URL` — a Slack or Discord incoming webhook URL (both
  accept `{"text": "..."}` as-is)

Until these are set, the workflow's own run turns red in the Actions tab
on every scheduled trigger — which is itself a visible (if less
convenient) signal, not a silent no-op. You can also trigger it manually
any time from the Actions tab (`workflow_dispatch`) to test it end-to-end
once the secrets are in.

**Known blind spot, found and documented 2026-09-08 — this alert cannot
detect VAULT-1.** `scheduled_job_health()` reports a job healthy based on
`cron.job_run_details.status = 'succeeded'`, and `cron_invoke_edge_function()`
(which backs `recap-weekly` and `purge-abandoned-profiles`) responds to
unset/placeholder Vault secrets with a `NOTICE`, not an exception — the
cron SQL completes normally either way. So those two jobs can report
healthy while doing nothing, which is exactly the state VAULT-1 describes.
The script prints an explicit note when this applies so it's visible in
the Action's log, but does not fail the check on it — closing that
properly needs a second check against `net._http_response` (not in the
REST-exposed schema; would need its own new migration exposing a narrow,
service_role-only accessor, since applied migrations are immutable).
**Named as a follow-up, not built under this pass** — until it exists, use
the manual `net._http_response` check in §A.4 after a scheduled run to get
a real answer for these two jobs specifically; don't trust this
automated alert's silence for them alone.

**Two operational notes, easy to miss:**
- GitHub disables scheduled (`on: schedule`) workflows after 60 days of
  repository inactivity — on a quiet repo, this alert going silent would
  itself be silent. Check the Actions tab occasionally rather than
  assuming "no notification" means "all clear" indefinitely.
- A `schedule` trigger only runs from the **default branch**. This isn't
  live until `.github/workflows/scheduled-job-alert.yml` is on `main` —
  don't check this item off on the strength of the file existing on a
  feature branch.

**One accepted tradeoff, stated explicitly rather than left implicit:**
the service-role key this workflow uses bypasses every RLS policy on
production member data — a large blast radius for what is otherwise a
simple health ping. This is forced by `scheduled_job_health()`'s own
design (service_role-only, by the same migrations that built it), not an
oversight in this workflow, and it's the standing tradeoff of any
service-role-backed automation. If it's ever worth narrowing: a
purpose-made Postgres role plus a `SECURITY DEFINER` function returning
only job name + healthy boolean, granted to that narrower role instead.

### 6. Confirm the real backup/retention settings (~2 minutes)

Supabase dashboard → **Database → Backups**. Note (don't need to change)
the retention window and whether point-in-time recovery is enabled. This
was never independently tested (only the dump-based path was, successfully,
on 2026-09-06) — you don't need to test it before launch, but you should
know what it actually promises before you need it in an emergency.

---

## B. Should do soon after (not launch-blocking)

- **Dependabot bump — in progress, not just reviewed, as of 2026-09-08
  (a sibling session picked it up mid-audit).** Real findings so far,
  worth knowing regardless of who finishes it:
  - **`jsdom` 25→30 is a genuine breaking change for this repo's test
    suite** — a straight bump caused 1004 test failures. Cause: jsdom 30
    made `window.crypto` a getter-only accessor, and
    `test/helpers/boot.mjs`'s plain assignment to it throws, taking down
    every test that boots the app. One-line fix
    (`Object.defineProperty` instead of assignment) restores 1505/1505.
  - **The `@supabase/supabase-js` re-vendor (2.57.4→2.114.0) broke the
    DEP-3 supply-chain check** (`scripts/check-vendored-supabase-version.mjs`).
    The new build's minifier no longer uses the `exports.version` pattern
    the version-marker regex relied on — Supabase now versions its
    sub-packages as one monorepo unit, so that structural signal is gone.
    The check has reportedly been updated to detect the new pattern, with
    the **sha256 pin kept as the actually load-bearing half** (a version
    string proves what's claimed; the hash proves what's really there).
    Anyone continuing this work should verify that updated detection
    logic independently before trusting it, same as this audit has been
    doing with every other cross-session claim.
  - **The vendored bundle grew 131KB → 212KB, +62%.** All tests and
    browser checks reportedly still pass against it — this is a payload
    *cost* question (relevant to §17 Performance, first-load size on the
    exact low-end-mobile audience this app targets), not a correctness
    one, and is still being weighed (gzip delta, not yet decided) as of
    this writing.
  - Do the final version as its own isolated, reviewed change with a full
    regression pass — not bundled silently into an unrelated release —
    regardless of who lands it.
- **Real screen-reader pass** (VoiceOver on iOS, or NVDA/TalkBack) — the
  automated axe-core sweep catches structural/contrast issues but not
  whether things make sense when heard.
- **Rehearse `docs/ops/INCIDENT_RESPONSE.md` once**, even as a dry run with
  no real incident — a process nobody has walked through is not a verified
  process, and the first real incident is the wrong time to discover a gap
  in it.
- `deleteMeasureType` still cascades away every measurement of that type
  with no confirmation step — in progress, currently blocked by a
  concurrent edit to `app.js` in the shared working tree.
- ~~A restricted member having no UI surface for their restriction's
  reason/expiry~~ — **done**, see `PRE_LAUNCH_AUDIT.md`.
- ~~`challengeKeyExists()` being device-relative for unpublished custom
  WODs~~ — **done, and was already done when this line was written.** Closed
  2026-09-07 by `fbf5a43` ("Stop asking a coach to type a database key"),
  which replaced the free-text comparison-key field with a `<select>` built
  from `challengeKeyChoices()`. That builder skips `category === "Custom"`
  for both movements and WODs, so a per-device id cannot be offered;
  `setWeeklyChallenge()` re-checks against the same list, so it cannot be
  submitted by editing the DOM either. `test/community-weekly-challenge.test.mjs`
  asserts exactly this ("the picker never offers a CUSTOM movement or WOD,
  whose ids are per-device and could never match another member's post").
  Verified 2026-09-15. The published-WOD half was closed separately by the
  club WOD catalogue (`202609060028`).
- ~~`PRIVACY.md`/`privacy.html` still describing the pre-fix
  abandoned-account purge behavior~~ — **done**, shipped in `60c7404`
  ("Stop promising the deletion the database no longer performs"),
  verified this session: both languages corrected in both files,
  `test/community-backup-sync.test.mjs` 19/19 (asserts the new copy AND
  that the old, wrong promise can't silently return).
- **New, 2026-09-08: `community_streaks` Security Advisor finding (Critical, "Security Definer View") — expand phase shipped, contract phase pending.** Verified the view genuinely needs definer semantics (activity_pings' RLS is strictly `user_id = auth.uid()`, no broader policy — flipping `security_invoker=true` would silently zero out every member's streak but the caller's own), so it was converted to a SECURITY DEFINER **function** instead (`202609080005`, matching the pattern `feed_leaderboard`/`chal_progress`/`coach_celebrate_feed`/`member_of_week_candidate_set` already use, which the advisor's rule doesn't flag). The old view is deliberately **still present and unchanged** — `cloud.js` now calls the function via `.rpc()`, but the view stays until a later migration drops it, so no client caught mid-deploy or running a stale service-worker cache 404s. **Follow-up needed, not urgent:** once this has had time to actually reach installed clients (a version bump + normal rollout window), a contract-phase migration should drop `public.community_streaks` (the view) to actually close the Advisor finding — until then the Advisor will likely still show it, correctly, since the flagged object still exists. Also worth doing at the same time: `admin_user_directory` (`202608270011`) will likely show the same Advisor finding and is a genuine false positive (zero grants to anon/authenticated — unreachable via the API at all, dashboard/SQL-editor-only) — safe to dismiss in the dashboard without any code change.
- Two newly-named, unowned items from 2026-09-08: the consent card
  promising device-change recovery an anonymous account can't yet deliver,
  and `admin_incomplete_signups.purgeable_after_reclaim` going stale now
  that the purge guard landed (needs a migration). Ask the team currently
  in `cloud.js`/`app.js` for exact wording before touching either — it's
  in their session transcript.

---

## C. Launch-day sequence (once A is done)

1. **Take a backup first, always:** `supabase db dump --linked -f pre-launch-$(date +%Y%m%d).sql`
   even if nothing is changing that day — cheap insurance.
2. **Confirm schema/client alignment one more time:**
   `node scripts/check-deploy-readiness.mjs <prod-url> <prod-anon-key>` →
   must say READY before inviting anyone in.
3. **Send the first real invite code to yourself or one trusted person
   first**, not the whole club at once. Walk through sign-up → invite
   redemption → first post, exactly as a real member would, on a real
   phone.
4. Only once that one real signup works end-to-end, open invites to the
   rest of the club.

## D. First 48 hours after real members are in

- Watch `cron.job_run_details` for the next `purge-due-accounts` and
  `notif-batch-flush` runs — confirm they're actually executing, not just
  registered.
- Watch for `rate_limited` errors — the abuse-prevention triggers are
  conservative by design but untested against real traffic; a real member
  hitting one reads as "the app won't let me post," which is worth
  catching fast.
- Check the moderation queue (`select count(*) from public.reports where status = 'open';`)
  daily — a report that sits unanswered is a duty-of-care problem, not just
  a metrics one.
- Re-run `select * from public.scheduled_job_health() where not healthy;`
  daily until item A.5's automated alert is actually in place.

## E. Ongoing (monthly-ish)

- Re-check `npm outdated` and review Dependabot PRs — don't let the
  vendored Supabase client drift further without a deliberate look.
- Re-read `docs/ops/MONITORING.md` §5 (moderation backlog) and §2
  (auth/abuse) once a month even without a specific trigger — these are
  the two signals nothing else surfaces automatically.
