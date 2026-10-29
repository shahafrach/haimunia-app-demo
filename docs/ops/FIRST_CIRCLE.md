# Starting the first circle

A new account can only join through an invite, and only a circle member can
make one, so on an empty project nobody can start. `bootstrap_owner_invite()`
breaks the loop. It is for the owner alone.

## The one line

Open the Supabase dashboard of the **box-log** project, **SQL Editor**, and run:

```sql
select public.bootstrap_owner_invite();
```

The result is a full link: `https://box-log.pages.dev/#invite=<64 hex>`. Copy it
from the result cell. Open it on your phone.

- It works **once** and expires after **one hour**. Run the line again for a new one.
- Only the hash is stored. The link is shown once and cannot be recovered.
- It lets whoever opens it sign up and **create a first circle**. It joins no
  circle and reads nothing.
- Nobody can run it over the API: it is granted to no role. The SQL editor runs
  as `postgres`, which is the only caller.

## After it

Sign up, create the circle, then invite your friends from inside the circle
(Circle, invite): those links last 7 days. Walk through
[PILOT_CHECKLIST.md](PILOT_CHECKLIST.md).

## Prerequisite

Migration `202610290001_pilot_readiness` must be on the project
(`npm run push:prod`, see [MIGRATIONS.md](MIGRATIONS.md)). Without it the line
fails with `function public.bootstrap_owner_invite() does not exist`.

## If it fails

| What you see | Meaning |
|---|---|
| `function ... does not exist` | the migration is not applied yet |
| `not authorized` | the call carried a user; use the SQL editor, not a client |
| the app says the invite is invalid | older than an hour, already used, or the link was cut when copying; run the line again |
