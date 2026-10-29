# Privacy Policy (BOX-LOG)

*Last updated: 2026-10-28. Mirrors `privacy.html`, which is the Hebrew text members read. If the two ever diverge, the Hebrew governs for members.*

BOX-LOG is a free training-log app, a personal project by Shahaf Rachmany, used in private circles of friends. There is no gym, no coach and no club behind it. This document says what is stored, where, who sees it and how to delete it. It was written from the code and the database schema.

## In short

- Body weight never leaves your device.
- The rest of your log is kept on your device and backed up to your own private account after you agree. You can turn the backup off and delete it in Settings.
- Only members of the same circle see anything, and only what you shared there.
- No email address, no phone, no payment data, no health data.
- No ads and no third-party analytics.

## What is stored on the server

- **Account:** a username. Sign-in is username and password. No email address is stored; sign-in uses a synthetic, non-real address.
- **Profile:** display name and emoji, the same in every circle. No photos.
- **Circles:** which circles you belong to, your role, what you chose to share in each, your weekly target and pause.
- **What you shared:** workouts and personal records (PRs) you chose to share to one circle, and the reactions on them (fist bump, fire, clap).
- **Trained together:** a tag naming a circle member. It counts for them only after they confirm.
- **Notifications:** your preferences and, if you turn push on, your browser's push subscription at its push service.
- **Blocks and פנייה messages** you submitted (the text you wrote and the app version).
- **Usage events:** an action name and small properties, with no workout content. Deleted after 90 days.
- **Private backup:** your workout log, custom exercises and measurements, without body weight. Stored under your account only. No circle member sees it and it is never sent to a circle.

## What stays on the device

- Display choices and device settings.
- **Body weight never leaves your device.** It is not shared with a circle and is not part of the backup.
- If you turn the backup off, from then on your log stays on the device only. What was already uploaded stays in the cloud until you delete the backup or the account.
- No email, phone, payment or health data is collected.

## Who sees what

Only members of the same circle, and only what you shared there. One circle never sees another. Someone who is in no circle sees nothing.

What you hide is not sent to the server at all. An absolute weight on a PR is sent only if you chose to show weights; otherwise the circle sees the lift and the percent improvement.

## Backup account

Cloud backup starts at the first workout you save. On a device that shows the "Back up your workouts to the cloud?" card, until you answer, the app opens no backup account for you and uploads no record. If you have already joined a circle with an invite link, an account was opened for you at that step. You can turn it off or on at any time in Settings.

A backup account is opened without a username and password. If you lose this device or clear its data, nobody — including us — can restore it to you. To be able to recover it from any device, set a username and password in Settings.

An empty backup-only account is closed after 30 days. If you have saved even one workout to it, it is not deleted.

## Processors

- **Supabase:** database and sign-in. The project region is not recorded in the repository, so it is not stated here.
- **Cloudflare Pages:** hosting. Cloudflare sees an IP address and browser type on every load, like any website. It does not receive your log.
- **Cloudflare Turnstile:** a human check at sign-up and sign-in. It is the only third-party script in the app.
- Your browser's push service (Apple, Google or Mozilla), only if you turn notifications on.
- No third-party analytics and no ads. Fonts are self-hosted.

## Leaving and deleting

**Leaving a circle:** your posts, reactions, tags and benchmark results in that circle are deleted. Your private log stays on your device. An owner who leaves passes ownership to the longest-standing member; the last member to leave deletes the circle. An owner can also remove a member, with the same clean-up.

**Deleting your account:** your profile and shares disappear immediately and everything else is permanently deleted within 30 days: posts, reactions, notifications, push subscriptions and the private backup. The circle sees "a member left". Workouts on your device stay. Bug reports are kept without any link to you.

**Download your data:** Settings has an export of everything stored about you.

## Contact

Requests, including access and deletion, go through **פנייה** in the app (Me, then פנייה). There is no email address or phone number for requests.

You can also take questions to whoever invited you.

&copy; Shahaf Rachmany, all rights reserved.
