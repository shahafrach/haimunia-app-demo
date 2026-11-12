# Haimunia club launch

Launch is **after 19.01.2027** (owner decision, 2026-11-12). Until then members keep the old app at
haimuniya.github.io/haimunia-app/ with no change: the invitation card and the transfer-code button in the
old app (3.2.0) are built and switched off.

## What is live already

| Piece | Where | State |
|---|---|---|
| Backend | box-log Supabase project, migration `202611120001` | applied 2026-11-12 |
| Transfer functions | Edge Functions `transfer-put`, `transfer-take` | deployed, `verify_jwt = false` |
| Club app | shahafrach/haimunia-club → https://haimunia.pages.dev | deploys on every push to main |
| Turnstile | widget `0x4AAAAAAE6mfjw79idh0ptH` | `haimunia.pages.dev` added |
| Old app | haimuniya/haimunia-app 3.2.0 | usage counts to box-log; move switched off |

## Steps, in order

1. **Owner account.** The owner installs https://haimunia.pages.dev to the home screen, chooses "connect"
   and signs up with a username.
2. **Create the club.** Actions → `club-admin` → `action = create_club`, `who = <owner username>`.
   The log shows `created`.
3. **Name the coach.** The coach signs up and joins by the club link (club tab → new link, owner only).
   Then `club-admin` → `action = set_coach`, `who = <coach username>` → `set`.
4. **Pilot.** 3 to 5 members, for one week. Each moves their log with a backup file, or with a transfer
   code once step 6 is done for them. Check: sign-up, joining by the link, the feed, reactions, the
   coach's tools, and a transfer from the old app into the installed new app.
5. **Launch week limit.** Actions → `set-auth-config` → `anon_limit = 300`. `auth-launch-limit.yml`
   lowers it to 60 seven days later on its own.
6. **Switch the move on in the old app.** In haimuniya/haimunia-app, `app-config.js`:
   `newApp.enabled: true`, then bump the version (`npm run sync-version`), add a CHANGES.md entry and
   release. Members see a dismissible invitation and "create transfer code". Nobody is moved; the old
   app keeps working with no end date.
7. **Announce** the club link to members.

## After launch

- Usage: `club-admin` → `action = usage_report` (devices per week, per app, no ids).
- Ownership: `docs/ops/CLUB_OWNERSHIP.md`.
- The old app stays live at least one month after step 6 (decision 2026-11-11), with no end date set.
