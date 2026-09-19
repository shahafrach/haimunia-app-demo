# What only the owner can do

Everything here needs a dashboard login or a phone in hand. None of it can be
done from this repo. Ordered by whether it matters.

## Worth doing

### 1. Auto-RLS on new tables

**Database → Policies** → the **"Set up trigger"** button at the top, under
*"Automatically enable Row Level Security on new tables"*. Ten seconds.

Every existing table has RLS on, because every migration enables it by hand.
A table created any other way — the Studio table editor, or a migration that
forgets the line — lands with RLS **off**, and no policy applies. This makes
it automatic instead of a habit.

### 2. Rotate the headcoach password

**ניהול המועדון → חברים → איפוס סיסמה**

It is still the weak one it was created with, it was in public git history
until the repo went private, and the session that set it up knows it.

Generate it rather than inventing one:

    openssl rand -base64 18

### 3. Your own admin password

**ניהול מערכת → שינוי סיסמה.** Different from the headcoach one. That account
now holds `is_admin`, so its password protects everything.

### 4. The deploy workflow is almost certainly missing its token

`deploy-edge-functions.yml` was `workflow_dispatch`-only until 2026-09-17, so
nothing had ever deployed on a merge. That is fixed. But after pushing a change
to the workflow file itself — a path its own new trigger covers — the function
was still absent from the gateway six and then ten minutes later, measured
twice against a control probe.

The workflow fails loudly rather than going green when `SUPABASE_ACCESS_TOKEN`
is unset, which is exactly what this looks like. **Check the Actions tab for a
red `deploy-edge-functions` run.** If it is the token: a personal access token
from https://supabase.com/dashboard/account/tokens, added as a repository
secret. It is not the service-role key and must never be confused with it —
that token deploys code, the other reads and writes member data.

Until it is set, every Edge Function deploy is a hand-run command, which is the
habit that left two functions undeployed for weeks once already.

### 5. Confirm a push actually arrives

**Settings → notifications → pick "התראת דחיפה" on any type.** The browser
asks permission; allow it. Then get someone to react to one of your posts, or
wait for the next thing that would notify you.

This is the one step nobody else can do. Everything about web push is built,
tested and live as of 2026-09-17 — the encryption is verified against the
spec's own published example, byte for byte — but no notification has ever
been watched landing on a real phone. That gap is not paranoia: a push that
fails returns **201 from the push service and shows nothing**, so there is no
error anywhere for anyone to find.

On iPhone it only works if the app is installed to the home screen. In Safari,
without installing, nothing arrives and nothing says why.

Tell me when one lands, and `streak_risk_nudges` gets turned on — one
migration. Until then it stays off, because otherwise the first real use of
this code would also be its first test.

## Decide, do not just tick

### ~~The scheduled-job-alert secrets~~ — decided, 2026-09-19

**There is no decision left here, and nothing to paste.** This used to ask you
to weigh putting `SUPABASE_SERVICE_ROLE_KEY` — a key that **bypasses every RLS
policy on member data** — into GitHub Actions, because the only function that
could answer "are the cron jobs running" was service_role-only.

Migration `202609190001` removed the question. The check now runs inside the
database every hour and **notifies every admin in the app** when a job stops;
the GitHub workflow only reads a three-field verdict
(`ok`, `failing_count`, `last_checked_at`) using the publishable key that is
already in `cloud-config.js`. No Supabase secret is involved.

**If you ever see an instruction to add `SUPABASE_SERVICE_ROLE_KEY` to this
repository's Actions secrets, it is out of date — don't.** A test
(`test/scheduled-job-alert-needs-no-service-key.test.mjs`) fails the build if
any workflow starts reading one again.

Optional, and the only secret this alert can still use: `ALERT_WEBHOOK_URL`, a
Slack or Discord incoming webhook. Without it the alert still works — the
workflow run simply turns red in the Actions tab instead of pinging a channel.

### Required status checks

Every push this week printed *"Bypassed rule violations… 4 of 4 required
status checks are expected"*. CI was cancelled-not-failing, and is green now.
The bypass should stop — a required check that is always overridden is a check
nobody runs.

## Not fixable

**Leaked-password protection** is Pro-plan only. It will show as a WARN in the
security advisor forever. Generated passwords do the same job.

**The `anon` EXECUTE default** in schema `public`. Supabase's bootstrap sets it
as `supabase_admin`, and `alter default privileges for role supabase_admin`
raises "permission denied to change default privileges" even from the dashboard
SQL editor, which runs as `postgres`. So the default stays open.

That is the default, not the grants: every function that exists today has had
`anon` revoked explicitly, asserted on the live database by the migration's own
final check. The exposure is only a *future* function whose author forgets the
revoke line, and `supabase/tests/0113` fails CI the moment one does. Nothing to
do here — it is recorded so the next person does not spend an afternoon
rediscovering that the ALTER cannot be run.

## Done, for the record

**Captcha on anonymous sign-ins — closed 2026-09-17.** This was item 1 here
for weeks, and the entry said the app was "already fully wired ... one field
short". The field is filled: `cloud-config.js` carries a real Turnstile site
key (`0x4AAAAAAE6mfjw79idh0ptH`) and the matching secret is in Supabase, so
`withCaptcha(...)` now actually has a token to pass. Turning it on broke two
browser scenarios, correctly — they were reaching Cloudflare for real, and
they now stub the widget script rather than the app's own captcha gate, which
keeps the real path under test. Nothing is left for the owner here.


Join code revoked (used once, by you, testing) · repo private · GitHub Pages
torn down · `is_admin` + `head_coach` on your member account · backups running
nightly, encrypted, and **proven restorable** by a weekly drill · both broken
CI jobs fixed · 19 anon EXECUTE grants closed · web push built and deployed,
with a real VAPID keypair (the private half is an Edge Function secret, set
without ever passing through a command line or this repo).
