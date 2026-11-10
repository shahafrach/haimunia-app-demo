# Password reset

Members sign in with a username (a synthetic `<name>@members.haimuniya.invalid` address), so
there is no email to reset by. Recovery is a code the member keeps
([decisions.md](../circles/decisions.md), "Home and recovery").

## The normal way: the member's recovery code

Made once, at sign-up (shown once, with a required "שמרתי" box) or from Me, "קוד שחזור חדש"
(asks for the password first). Four groups of four characters, for example `7K2M-QX9D-4HNC-WB8F`.

On the login screen the member taps "שכחתי סיסמה", types the username, the code and a new
password twice. The server checks the code, sets the password, signs the account out
everywhere, and shows a NEW code, once. The old one is dead. Five attempts per 15 minutes per
username and per address; every failure reads the same.

## When the code is lost: the member does it alone (12 hours)

On the "שכחתי סיסמה" screen the member taps "אין לי קוד שחזור" and types the username
(`request-reset` Edge Function, decided 2026-11-10). After 12 hours the same device sets a new
password and is shown a new recovery code once. Meanwhile every signed-in device of that account
gets a push and a banner, "זה לא אני, לבטל"; a cancel kills the request and blocks new ones for
24 hours. Three requests per username per day. Nothing for the owner to do.

Needs on the project: migration `202611100001` and the `request-reset` function deployed (both
happen on merge to `main`); it uses the same `RECOVERY_CODE_HMAC_SECRET` as recover-password.

## When the code is lost: the faster way, one line for the owner

In the Supabase SQL editor (it runs as `postgres`; the function is granted to no other role):

```sql
select public.owner_issue_reset_code('their_username');
```

It returns a one-time code, valid for one hour, stored only as a salted HMAC. Send it to the
friend in WhatsApp. They use it on the same "שכחתי סיסמה" screen in place of the recovery code,
choose a new password, and are shown a new recovery code. A second code for the same member
replaces the first; a used or expired one is refused. An unknown username raises `no such member`.

## Setting it up (once)

1. Run the **rotate-recovery-secret** workflow (Actions, Run workflow). It makes
   `RECOVERY_CODE_HMAC_SECRET` on the runner and sets it as an Edge Function secret; nobody
   sees it. It refuses to replace an existing key unless `replace` is true, because a new key
   makes every existing recovery code useless.
2. Merge, so **deploy-edge-functions** deploys `issue-recovery-code` and `recover-password`
   (`recover-password` has the gateway JWT check off in `supabase/config.toml`: the caller has
   no session; the function does its own checks).
3. Apply the migration with `npm run push:prod` (`202610300001_password_recovery_codes.sql`).

Members who signed up before this see a prompt in Me to create a code.
