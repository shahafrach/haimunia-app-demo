# The founder link

Sign-up is closed: nobody can make an account from the front page. Two kinds of
link open it. A **circle invite** joins you to someone's circle. A **founder
link** lets a friend start a circle of their own. This page is about the second.

Decision of 2026-10-29: [decisions.md](../circles/decisions.md) (Auth),
[journal.md](../journal.md).

## What a member does

Me, then **קישור לחבר שרוצה מעגל משלו**. The sheet explains it in a line and
waits. Tap **יצירת קישור**: the link appears, once, with **שיתוף** (the phone's
share sheet, WhatsApp included) and **העתקה** (copy, for browsers with no share
sheet). Closing the sheet forgets the link; make another if you lost it.

## What the friend sees

They open the link. The token is in the part of the address after `#`, so it
never reaches a server or a log, and the app removes it from the address bar at
once. Then, in order: create a username and password, choose a name and an
emoji, and land on the **create a circle** sheet. If they close it, a button
("יצירת מעגל") stays on the screen.

## What the link allows, and what it does not

- It lets one person **sign up and create circles**. That is all.
- It joins them to **no circle**. The sender's circles are invisible to them.
- The sender is **not recorded** on it. The sender cannot see who used it, or
  anything the friend builds. If the friend later invites the sender to their
  circle, that is an ordinary circle invite.
- It is **one use**. After someone redeems it, it is dead for everyone.
- It **expires after 7 days**.
- A member can make **3 a day**. The fourth says so in Hebrew
  ("יצרת היום 3 קישורים…"). The day is a window that starts at the first link,
  not the calendar day.
- Only the **sha256** of the token is stored. The link is shown once and cannot
  be recovered by anyone, the owner included.
- Only a member **signed up with a profile** can make one. An anonymous
  mid-sign-up session cannot, and neither can a visitor.

## How it works underneath

`create_founder_invite()` writes one row to `invite_codes` (role `member`, one
use, seven days). The friend's app first tries `join_circle`, which does not know
the token and answers `invalid`, then `redeem_invite_code`, which does. That is
the same path the owner's first-circle link takes
([FIRST_CIRCLE.md](FIRST_CIRCLE.md)); there is no second way in. Redeeming writes
one `invite_redemptions` row, which `create_circle` accepts from someone who is in
no circle yet, and which `is_community_member()` ignores, so it opens no reads.

## Limits, in plain words

- **The error for an expired link and a used link is the same.** The server says
  only "invalid" so that guessing tells an attacker nothing. The Hebrew message
  names both reasons. A rate-limited redemption (too many tries in an hour) has
  its own message.
- **The link is a bearer token.** Whoever opens it first gets the one use. Send
  it to the one person, in a private chat.
- **A member who is already in a circle and opens a founder link** spends it for
  nothing. It is not harmful; make another.
- **Nothing stops a friend from creating a circle and a second link-maker from
  inviting a hundred people.** The brake is the per-member cap (3 a day), the
  seven-day life and the fact that every new person needs an existing member to
  send them a link. If it is abused, set `invite_codes.active = false` for the
  unspent rows in the Supabase dashboard, or revoke a member.
- **It is not a way to join the sender's circle.** For that, the owner of the
  circle uses Circle, then **הזמנה**.

## Where it lives

| What | Where |
|---|---|
| Migration | `supabase/migrations/202610290002_founder_link.sql` |
| Database tests | `supabase/tests/0145_founder_link_test.sql`, `0135` (the reviewed-functions list) |
| Client | Me panel in `src/community/circles-ui.js`, sheet and actions in `circles-sheets.js` and `circles.js`, redemption in `auth.js` |
| Tests | `test/founder-link.test.mjs`, `scripts/browser-check/founder-link.mjs` |
