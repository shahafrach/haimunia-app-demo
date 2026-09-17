# What only the owner can do

Everything here needs a dashboard login or a phone in hand. None of it can be
done from this repo. Ordered by whether it matters.

## Worth doing

### 1. Captcha on anonymous sign-ins

**Authentication → Attack Protection**, and a free key pair from
https://dash.cloudflare.com → Turnstile.

- The **secret** goes into Supabase.
- The **site key** goes into `cloud-config.js` → `captchaSiteKey` (currently
  `""`). That file is public by design, same as the publishable key already
  in it.

**The app is already fully wired for this.** `cloud.js:7786` wraps the
anonymous sign-in in `withCaptcha(...)` and passes a token whenever it has
one; it never has one, because the key is empty. The work was done and left
one field short.

Why it matters: anonymous sign-in is how signup *starts*, so anyone can
trigger it repeatedly. On the free tier that means MAU inflation, junk
`auth.users` rows, and eventually a bill. Supabase's own dashboard warns
about exactly this on the Sign In / Providers page.

Do **not** disable anonymous sign-ins instead — signup depends on them.

### 2. Auto-RLS on new tables

**Database → Policies** → the **"Set up trigger"** button at the top, under
*"Automatically enable Row Level Security on new tables"*. Ten seconds.

Every existing table has RLS on, because every migration enables it by hand.
A table created any other way — the Studio table editor, or a migration that
forgets the line — lands with RLS **off**, and no policy applies. This makes
it automatic instead of a habit.

### 3. Rotate the headcoach password

**ניהול המועדון → חברים → איפוס סיסמה**

It is still the weak one it was created with, it was in public git history
until the repo went private, and the session that set it up knows it.

Generate it rather than inventing one:

    openssl rand -base64 18

### 4. Your own admin password

**ניהול מערכת → שינוי סיסמה.** Different from the headcoach one. That account
now holds `is_admin`, so its password protects everything.

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

### The scheduled-job-alert secrets

`.github/workflows/scheduled-job-alert.yml` has failed every day since
2026-09-15, **by design** — it needs three secrets and fails closed rather
than silently. Nothing is watching the cron jobs until they are set.

One of them is `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses every RLS policy
on member data**. Putting it in GitHub Actions is defensible and the workflow
argues it through in its own header, but it is a real decision about blast
radius, not a checklist item. Read that header before deciding.

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

Join code revoked (used once, by you, testing) · repo private · GitHub Pages
torn down · `is_admin` + `head_coach` on your member account · backups running
nightly, encrypted, and **proven restorable** by a weekly drill · both broken
CI jobs fixed · 19 anon EXECUTE grants closed · web push built and deployed,
with a real VAPID keypair (the private half is an Edge Function secret, set
without ever passing through a command line or this repo).
