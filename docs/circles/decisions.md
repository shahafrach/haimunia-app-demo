# Circles: decisions

Recorded 2026-10-25. These are settled. They are written down so later sessions
build on them and do not reopen them. Open questions live in
[audit.md](audit.md) section 6, not here. Every session reads this file first.
The reasoning behind each line, and what would reverse it, is in
[../journal.md](../journal.md).

This repository moved from the gym account to a personal account. The old
Supabase project (`jajmlyrjlkhclgphbfbb`) is deleted. A new Supabase project
and a new Cloudflare Pages project come later. The app becomes a free app of
private circles for friends. It is not a gym app and not a product.

## Product

- The app is named **BOX-LOG** (with the letter O). The rename happens in the Rebrand session.

- Free, for friends. No payments, no public sign-up, no paid services. Chat stays in WhatsApp.
- Own repository (personal account) and a new Supabase project. `training_log_usage` is not needed and is dropped.
- A circle is a `clubs` row. Membership is `circle_members(club_id, user_id, role, joined_at, share_defaults)`. Up to 10 circles per user.
- Types, chosen at creation, defaults editable:
  - **Couple**: max 2, both owners, side-by-side week. Shares workouts and PRs; absolute weights hidden.
  - **Friends**: max 20, the creator is owner, "together" mode, no ranking. Shares PRs and percents; workouts as a weekly count.
- Circle settings, owner only: name, emoji, mode (together or weekly competition), benchmark of the month on or off, who invites, welcome line.
- Member settings, per circle: what I share, show absolute weights, weekly target, pause, notifications.
- A member's privacy setting always wins. Hidden data is never sent to the server.
- Profile is display name and emoji only, the same in every circle. No other profile fields; `visible_to_club` is dropped. No avatars: the `avatar-photos` bucket is dropped, emoji instead.

## Sharing

- Logging is sharing by circle defaults. No compose step. One tap skips one workout.
- A post belongs to exactly one circle. Sharing to several circles creates one post each.
- Reactions: exactly three kinds, stored as `fist_bump`, `fire`, `clap`; a member may hold all three on a post. No text comments, no mentions.
- A PR with no reaction after a day moves to the top of the circle screen. No notification.
- "Trained together": tag a circle member. It counts for them only after they confirm.

## Targets and metrics

- Personal weekly target. Any workout counts. The circle sees percent of own target. Competition compares percent of own target, never absolute numbers.
- Count weeks the target was met. No daily streaks. A missed week resets nothing and gets no message.
- Pause mode: the circle sees "paused", no percent.
- PRs show the lift and percent improvement. Absolute weight only if the member chose it. Body weight never leaves the device.
- Estimated 1RM only from sets of 10 reps or fewer, labeled "estimated". Celebrate only real rep-max PRs.
- Benchmark of the month, optional: Rx and scaled in separate lists, results visible only after you log yours, enforced in the database. The circle owner picks it from the fixed list of eight named benchmarks the app already has.

## Logging

- Prefill from the last session of that lift. Target under 30 seconds per lift. History shows the heaviest set, one tap away.

## Distribution and notifications

- WhatsApp is the main channel: invite links, PR cards, the weekly circle card. Cards are drawn on canvas on the device, Hebrew RTL, built before the tap, shared as a file alone through Web Share, with a download fallback.
- The week starts Sunday, Asia/Jerusalem, for everyone. The weekly card is ready Saturday night.
- Notifications are off by default. Four can be turned on, each with its own switch in Me (2026-10-26, widening the earlier two): a reaction to your post (at most one per post per hour), a trained-together tag waiting for your confirmation, someone joined a circle you own, and the week card (Saturday night). Every one belongs to one circle: none after you leave it, none between blocked members. The VAPID subject is `https://box-log.pages.dev`, and the key pair is rotated by the `rotate-vapid` workflow so nobody sees the private key. Optional quiet hours from Friday evening to Saturday night are not built.
- The invite page detects in-app browsers and asks to open in Safari or Chrome. After joining, a guided Add to Home Screen step.

## Lifecycle

- Leaving or removal deletes the member's posts in that circle. The private log stays on the device.
- An owner who leaves passes ownership to the longest-standing member. The last member to leave deletes the circle.
- Account deletion removes all posts and reactions, and takes the member out of every circle at the request, with the same cleanup as leaving (202610290003): the circle's count and a Couple's seat free up at once, not at the purge. The circle sees "a member left".
- First run and empty circles get explicit screens.

## Auth

- Keep invite-based sign-up with a recovery method. No email, no SMTP.
- An invite joins one circle: 32-byte random token, only its hash stored, 7-day expiry, a use limit, the token after `#` in the URL, joined only through `join_circle` with rate limits.
- **Anonymous sign-ins stay ON** (2026-10-25, reversing the line that said off). Sign-up starts as an anonymous session, redeems an invite with `join_circle`, then upgrades to a username and password. With no email there is no other way to hold an identity during the invite step.
- **Turnstile CAPTCHA is enforced server-side**, by Supabase Auth (Authentication, Attack Protection, CAPTCHA, provider Turnstile; the secret is a dashboard setting and never enters this repository). The client already sends the token (`withCaptcha` in `cloud.js`) and fails closed; the dashboard step is in `COMMUNITY_SETUP.md`, and it must be done on the new project before the first sign-up.
- **An anonymous user who is in no circle sees nothing.** Every read policy resolves through circle membership; `is_community_member()` means "member of at least one circle".
- Keep the existing recovery mechanism. No passkeys for now.
- Rate limits: `join_circle` 10 attempts per user per hour; invite creation 20 per circle per day.
- **Founder link** (2026-10-29): still no open sign-up, but any member can send a friend a "start your own circle" link. The friend signs up and creates their own circle; they do not join the sender's circle, and the sender sees nothing of it. `create_founder_invite()`: a signed-up member with a profile, 32-byte token after `#`, only the sha256 stored, one use, 7-day expiry, at most 3 per member per day (`rate_limits`). It is a row in `invite_codes`, spent by `redeem_invite_code` like the owner's bootstrap link: it grants the right to create circles and nothing else (no membership, no read of the sender's data), and the sender is not recorded on it. How it works and its limits: [../ops/FOUNDER_LINK.md](../ops/FOUNDER_LINK.md).

## Security

- Every `SECURITY DEFINER` function: empty `search_path`, execute revoked from `public` and `anon`, listed in a reviewed-functions table checked by a pgTAP guard over `pg_proc`.
- Every circle table has a cross-circle leak test.
- The `post-photos` and `avatar-photos` buckets are dropped, and the `sanitize_upload` edge function with them. `purge_abandoned_profiles` and `notif_push_send` stay. No third-party scripts.
- Short docs: a security procedure, a database definition (Israel Privacy Protection Law, Amendment 13), and a Hebrew privacy page.

## Home and recovery (2026-10-30)

Two owner findings from the live app.

- **Home is about me, Circle is about us.** Home always draws the member's own training from the device (IndexedDB), signed in or not, with or without a circle: a greeting, this week's workouts against the personal weekly target as the ring ("N done" early in the week, "N left" near the end), weeks met, the last session with a one-tap log of the same lift, the latest PRs with percent improvement, and the log button. Before the first workout it says what to do first. With no personal target set the ring uses the default of 3. Circles on Home are one compact card: with no account or no circle, one line and the create/join buttons; with circles, the list and the latest few posts. The full gate, feed, week and invites exist on the Circle tab only (`renderCircleGate` has no caller in the Home screen).
- **Password recovery without email: a recovery code.** Sign-in is a username mapped to a synthetic `.invalid` address, so Supabase's email reset can never work. At sign-up (right after the username and password upgrade) the member is shown a recovery code once: 4 groups of 4 characters from the unambiguous 32-symbol alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0 O 1 I`), exactly 80 bits, and only an HMAC-SHA256 of it, with a domain prefix, is stored (`recovery_codes`, no client grants; the key is the Edge Function secret `RECOVERY_CODE_HMAC_SECRET`). Me has "קוד שחזור חדש" (password re-entered first) that rotates it; members who signed up before this see a one-time prompt in Me to create one.
- **Recovering** is the Edge Function `recover-password` (`{username, recovery_code, new_password}`), no session needed: 5 attempts per 15 minutes per username hash and per IP hash, constant-time compare, every failure the same generic answer. On success it sets the new password with the admin API, revokes every session, rotates the code and returns the new one once.
- **A friend who lost the code**: the owner runs `select public.owner_issue_reset_code('username');` in the Supabase SQL editor. The function is `SECURITY DEFINER`, `search_path ''`, granted to no role, and returns a one-use reset code valid for one hour, stored as an HMAC. The same recover-password screen accepts it. Procedure: [../ops/PASSWORD_RESET.md](../ops/PASSWORD_RESET.md).
- **Lost code, self-service** (2026-11-10, owner's decision, fix plan F19): "אין לי קוד שחזור" on the forgot screen asks with the username alone, through the Edge Function `request-reset`. After a **one-hour wait** (12 hours until the owner shortened it the same day) the same device sets a new password and gets a new recovery code once. Any signed-in session of the account sees a banner and can cancel, which blocks new requests for 24 hours; the account's devices get a push (`reset_requested`, sent even with the other notification switches off). 3 requests per username per day plus the recover-password IP limit. No approval by anyone. **Accepted risk:** anyone who knows a username can take that account over after an hour unless the owner cancels; members never see each other's usernames (`test/username-not-exposed.test.mjs`), and an account with two-step login still needs its second factor. Migrations `202611100001` and `202611100002` (the push text). The owner's SQL line above stays as the faster path.
- **Login is username only** (2026-11-10, fix plan F5): the real-email login path is gone; nobody needs email to recover.
- This reverses "Keep the existing recovery mechanism; no passkeys" for the one thing the existing mechanism could not do (a forgotten password). Passkeys are still not built.

## Drop and keep

**Drop:** all gym, staff, coach, Arbox and gym-display features; text comments, mentions, saved and hidden posts, pins, announcements, member of the week, monthly recaps, search, follows and friends, absolute leaderboards, feed ranking and weights, reports and posting restrictions, events, the `post-photos` and `avatar-photos` buckets, `sanitize_upload`, `training_log_usage`.

**Keep:** reactions, private records, per-user achievements, notifications and push subscriptions, account deletion, self-export, rate limits, request idempotency, `client_error`.

## Infrastructure

- Supabase free plan. Keepalive and an encrypted backup are required once the project exists. No Realtime.
- CI runs only on pull requests and relevant paths.
- Remove the Realtime code; do not gate it.
- Stay buildless. New circles modules start with `// @ts-check`. Database types come from `supabase gen types` into a `.d.ts` referenced from JSDoc.

## Privacy decisions (2026-10-28)

- **Body weight never leaves the device.** It is excluded from the `private_records` backup in the client (`isBackupRecordType`, `src/constants.js`). Migration `202610280001` deletes existing bodyweight rows and the CHECK on `private_records.record_type` refuses the type. The rest of the private log is backed up after consent and can be turned off and deleted.
- **hCaptcha is not used.** Turnstile is the only captcha and the only third-party script. The CSP names only the Turnstile host.
- **`analytics_events` stays**: first-party, purged at 90 days, disclosed on the privacy pages.

## Haimunia club (2026-11-11)

Owner decisions for the Haimunia club, which runs on this project beside BOX-LOG. The research, the numbers
behind them and the four build sessions are in [`docs/club/research.md`](../club/research.md).

- **The club is one circle of a third type, `club`.** At most one exists. Cap 250 (the club counts as one of a member's 10 circles). It is created once by `owner_create_club`, never from the app. Every branch on a circle type is explicit and an unknown type raises, so no type silently inherits friends' limits.
- **Roles:** owner, at most one coach, members. The coach removes members (never the owner), deletes any post in the club (soft delete), rotates the join link and writes announcements. In a couple or friends circle nothing changes.
- **One fixed join link** (`rotate_club_link`, owner or coach, 5 rotations a day). It does not expire; the cap limits joins.
- **Ownership** passes to the coach when the owner leaves or deletes the account; with no coach the club has no owner until `owner_set_club_owner` runs ([`docs/ops/CLUB_OWNERSHIP.md`](../ops/CLUB_OWNERSHIP.md)). A club is never deleted automatically and never handed to a random member.
- **Announcements return, for the club only:** 500 characters, one pinned, never a notification. This is the one exception to "Drop" above.
- **Notifications in a club:** "reaction on your post" and "trained together" only. No PR fan-out, no week card, no join notification to the owner, enforced in the triggers.
- **Push by app:** `push_subscriptions.app` is `box-log` or `club`. A circle notification is pushed only to the app that shows that circle; a personal one (reminder, digest, reset alert) to every device. BOX-LOG never lists the club.
- **Club share defaults:** every workout posted, PRs as percent improvement, absolute weights off. A member's own setting always wins.
- **No cloud copy of the private log in the club.** A new phone is covered by the backup file and the transfer code.
- **The recorded exception to "body weight never leaves the device": the one-time transfer code.** The backup, body weight included, is encrypted on the phone with a key that exists only in the code the member copies. The server holds ciphertext and a hash of the lookup, at most 24 hours, deleted on the first download, and refuses anything that looks like plaintext. It cannot decrypt it.
- **`training_log_usage` returns** for the two Haimunia apps only: per device, per day, insert-only for anon, totals through a function granted to no role, purged at 400 days. This reverses the 2026-10-25 drop.
- **Anonymous sign-ins:** 300 an hour for launch week through `set-auth-config.yml`, then 60, lowered by `auth-launch-limit.yml` on its own.
- **Bug reports from the club app** are `bug_reports.app = 'club'`. The owner does not read them in routine operation and nothing in the club waits on him.
- **Zero routine work for the owner.** His gates: approve PRs, one Cloudflare visit, name the coach, go or no-go on the pilot. Everything recurring is a workflow (`club-admin.yml`, `auth-launch-limit.yml`, `migration-status.yml`).
- **Timing:** launch during the owner's reserve duty, 22.11.2026 to 19.01.2027 (decided 2026-11-12, reversing "after 19.01" the same day). Every step is short and can be done from a phone. The steps are in [`docs/club/LAUNCH.md`](../club/LAUNCH.md).

## Superseded

The 2026-10-02 version of this file said "same repo and same project", "keep
`training_log_usage`", "sign-up uses a real email" and "no public visibility"
for a public app. The first two are reversed above, and the email decision is
reversed too (no email, no SMTP).

The same day, "Anonymous sign-ins are off" (Auth) was reversed: they stay on,
behind Turnstile and the no-circle-sees-nothing rule above.

Also 2026-10-25 (Circles RPCs review): reactions are exactly three kinds, the
fist bump (`fist_bump`, formerly `cheer`), `fire` and `clap`; and
`purge_abandoned_profiles` skips anyone who is a member of at least one circle.
