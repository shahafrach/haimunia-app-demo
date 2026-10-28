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
- Notifications are off by default. Only two can be turned on: a reaction to your PR, and the weekly card. Optional quiet hours from Friday evening to Saturday night.
- The invite page detects in-app browsers and asks to open in Safari or Chrome. After joining, a guided Add to Home Screen step.

## Lifecycle

- Leaving or removal deletes the member's posts in that circle. The private log stays on the device.
- An owner who leaves passes ownership to the longest-standing member. The last member to leave deletes the circle.
- Account deletion removes all posts and reactions. The circle sees "a member left".
- First run and empty circles get explicit screens.

## Auth

- Keep invite-based sign-up with a recovery method. No email, no SMTP.
- An invite joins one circle: 32-byte random token, only its hash stored, 7-day expiry, a use limit, the token after `#` in the URL, joined only through `join_circle` with rate limits.
- **Anonymous sign-ins stay ON** (2026-10-25, reversing the line that said off). Sign-up starts as an anonymous session, redeems an invite with `join_circle`, then upgrades to a username and password. With no email there is no other way to hold an identity during the invite step.
- **Turnstile CAPTCHA is enforced server-side**, by Supabase Auth (Authentication, Attack Protection, CAPTCHA, provider Turnstile; the secret is a dashboard setting and never enters this repository). The client already sends the token (`withCaptcha` in `cloud.js`) and fails closed; the dashboard step is in `COMMUNITY_SETUP.md`, and it must be done on the new project before the first sign-up.
- **An anonymous user who is in no circle sees nothing.** Every read policy resolves through circle membership; `is_community_member()` means "member of at least one circle".
- Keep the existing recovery mechanism. No passkeys for now.
- Rate limits: `join_circle` 10 attempts per user per hour; invite creation 20 per circle per day.

## Security

- Every `SECURITY DEFINER` function: empty `search_path`, execute revoked from `public` and `anon`, listed in a reviewed-functions table checked by a pgTAP guard over `pg_proc`.
- Every circle table has a cross-circle leak test.
- The `post-photos` and `avatar-photos` buckets are dropped, and the `sanitize_upload` edge function with them. `purge_abandoned_profiles` and `notif_push_send` stay. No third-party scripts.
- Short docs: a security procedure, a database definition (Israel Privacy Protection Law, Amendment 13), and a Hebrew privacy page.

## Drop and keep

**Drop:** all gym, staff, coach, Arbox and gym-display features; text comments, mentions, saved and hidden posts, pins, announcements, member of the week, monthly recaps, search, follows and friends, absolute leaderboards, feed ranking and weights, reports and posting restrictions, events, the `post-photos` and `avatar-photos` buckets, `sanitize_upload`, `training_log_usage`.

**Keep:** reactions, private records, per-user achievements, notifications and push subscriptions, account deletion, self-export, rate limits, request idempotency, `client_error`.

## Infrastructure

- Supabase free plan. Keepalive and an encrypted backup are required once the project exists. No Realtime.
- CI runs only on pull requests and relevant paths.
- Remove the Realtime code; do not gate it.
- Stay buildless. New circles modules start with `// @ts-check`. Database types come from `supabase gen types` into a `.d.ts` referenced from JSDoc.

## Privacy decisions (2026-10-28)

- **Body weight never leaves the device.** It is excluded from the `private_records` backup in the client (`isBackupRecordType`, `src/constants.js`). The rest of the private log is backed up after consent and can be turned off and deleted.
- **hCaptcha is not used.** Turnstile is the only captcha and the only third-party script. The CSP names only the Turnstile host.
- **`analytics_events` stays**: first-party, purged at 90 days, disclosed on the privacy pages.

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
