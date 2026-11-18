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

## In the club app: the coach gives a reset code (Q-38, 202611180003)

The owner or the coach opens the club's member list and taps "איפוס סיסמה" next to a member. The app
shows an 8-character code (for example `ABCD 2345`), valid for 24 hours and once. The member taps
"שכחתי סיסמה" on the login screen, types that code and a new password twice, and is signed in. They
do not need their username. Every other session of the account ends; the recovery code is unchanged.
A coach can never reset the owner, and nobody resets themself (they are signed in). 10 codes a day
per staff member; each is in `club_staff_actions` as `member_password_reset`.

## The owner, locked out, with no coach (Q-38b)

On the phone: "שכחתי סיסמה", then "אין קוד מהמאמן", then the username. The phone shows a
6-character reference, for example `A1B2C3`. Then, from the GitHub app: Actions, **club-admin**,
Run workflow, action `approve_reset`, `who` = the username, `ref` = the reference. The run prints
one word (`approved`). Back on the phone: "המשך", a new password twice, signed in.

Nothing secret is printed, and the repository is public: the username is masked and hashed, the
reference is only the start of an HMAC, and the request token that completes the reset never leaves
the phone. Without the workflow the same request completes on its own after the one-hour wait.

## When the code is lost: the member does it alone (one hour)

On the "שכחתי סיסמה" screen the member taps "אין לי קוד שחזור" and types the username
(`request-reset` Edge Function, decided 2026-11-10). After one hour the same device sets a new
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
