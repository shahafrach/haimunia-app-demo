# Standing up a second club

Written 2026-09-16, after the move to Cloudflare Pages, to answer one question:
what does it actually take to run this for a club that is not האימוניה?

Everything below is measured against the repo, not estimated.

## The shape of the thing

**The app is single-club.** One `clubs` row, one database, one deployment, and
`default_club_id()` threaded through the server functions. It is not
multi-tenant and should not be made multi-tenant lightly — the current design is
what lets RLS be simple enough to reason about, and simple enough to have been
audited.

So a second club is a second *instance*: its own Supabase project, its own Pages
deployment, its own data. That is a feature, not a limitation:

- one club can never see another's data, because there is no join that could
  reach it
- one club's outage, migration or mistake cannot touch another's
- a club can be handed over or shut down independently
- each club's members install an app with **their own club's name** on the home
  screen, which is a selling point rather than a compromise

## What is club-specific today

| Thing | Where | Count |
|---|---|---|
| Club name in copy | `manifest.json`, `index.html`, `app.js`, `cloud.js` | ~18 sites |
| Brand colours | CSS custom properties in `index.html` | ~6 vars |
| Logo and mark | `assets/logo-full.png`, `assets/mark.png` | 2 |
| Home-screen icons | `icon-192*.png`, `icon-512*.png` | 4 |
| Hero photographs | `assets/` scene images | several |
| Supabase project | `cloud-config.js` | 2 values |
| Allowed origin | `supabase/functions/admin_reset_password/index.ts` | 1 list |

The name is the awkward one. It is not in a constant — it is written out in
place, including inside content that reads as club-specific rather than
branding: the top achievement tier is literally `אלוף האימוניה`.

## The one change that makes this repeatable

Right now a new club is a careful find-and-replace across four files, and the
failure mode is quiet: miss one and a member sees another club's name in a
toast, an achievement, or a bug-report email.

The fix is to lift branding into a single declared object — club name, short
name, colours, asset paths — and have the ~18 sites read from it. `cloud-config.js`
already exists as the per-deployment file and is the natural home.

That turns a second club from "an afternoon of careful editing, with a real
chance of missing one" into "edit one file and drop in six images". It is a few
hours of work, all of it mechanical, and it should be done **before** the second
club, not during.

`אלוף האימוניה` needs a product decision rather than a variable: either it
becomes `אלוף המועדון` for everyone, or the tier name is part of the per-club
config. The first is simpler and reads no worse.

## Backend, per club

Deploying the database is already automated; this is the order it has to happen in.

1. **New Supabase project.** Note the project ref, URL and publishable key.
2. **Apply migrations** — `supabase db push --linked`. 167 of them, in order.
   They are the schema, the RLS, the roles and the permission grants.
3. **Seed the club row.** One row in `clubs`; `default_club_id()` resolves to it.
4. **Deploy the 4 Edge Functions** — `admin_reset_password`,
   `purge_abandoned_profiles`, `recap_weekly`, `sanitize_upload`. The
   `deploy-edge-functions` workflow does this; it exists because two of three
   were once silently missing in production.
5. **Set the function secrets** (service role key, and the Vault bridge the
   cron jobs use to invoke them).
6. **Verify the 12 cron jobs** registered — `select * from cron.job`. They also
   keep a free-tier project from pausing on inactivity.
7. **Storage buckets** — `avatar-photos` and `post-photos`, both private.
8. **Bootstrap the first admin.** There is no self-service path to admin by
   design: an invite can only grant `member` or `coach`, so the first admin is
   set directly, once, on the new project.
9. **Mint the first invite** and hand it to the club owner.

## Frontend, per club

1. New Cloudflare Pages project, connected to the same repo (or a branch per
   club, if the branding is not yet config-driven).
2. `cloud-config.js` → the new project's URL and publishable key.
3. Branding: name, colours, six images.
4. Add the new `*.pages.dev` origin to `admin_reset_password`'s `ALLOWED_ORIGINS`
   and redeploy that function. Password reset fails on any origin not in that
   list, and the failure looks like a broken app rather than a config gap.
5. Supabase → Authentication → URL Configuration → Site URL and redirect URLs.

## What this costs to run

Nothing, per club, at club scale. Supabase's free tier carries a 500MB database
(האימוניה uses 20MB), 50,000 monthly active users and unlimited cron; Cloudflare
Pages is free for static hosting. The first real ceiling is **1GB of image
storage** — a few hundred post photos — and it arrives long after the point where
the club is paying for something.

The one thing the free tier does not give is **automated backups**. Members'
private training logs live on their own devices and survive anything that happens
to the server, but the community side — feed, roles, invites, challenges — does
not. A weekly export is worth setting up before a second club exists, not after.
