# Standalone training-log edition: plan

**Status:** plan only. Nothing in this document has been built.
**Written:** 2026-09-22, against this repository at `2cf5cf4` (APP_VERSION 4.77.0).
**Older app compared:** `haimuniya/haimunia-app` at `16d0cd8` (v2.34.0), which is
also that repository's `HEAD`. Its members use it today at
`https://haimuniya.github.io/haimunia-app/`.

**Goal:** a training-log-only edition of this app, with no community, no
Supabase and no staff shell. It replaces the older app at the same URL, and no
member loses data.

How this was measured. Both trees were read side by side. The built-in
movement and WOD catalogues were compared by evaluating the `MOVEMENTS`,
`WOD_LIBRARY` and `WOD_MOVEMENT_TAGS` array literals from both files in Node
and diffing them by `id` (or `name` for tags). The storage keys were taken from
every `dbGetSetting`/`dbSetSetting`/`localStorage.*Item` call site in both.
No suite was run: this is a read-only audit and nothing changed. Every
line number below is at the commits above.

---

## 0. The finding that decides everything else: the origin

IndexedDB, localStorage, Cache Storage and the service-worker registration
are all scoped to the **origin**, not the path.

| | Origin | IndexedDB name | localStorage prefix | Cache prefix |
|---|---|---|---|---|
| Older app | `https://haimuniya.github.io` (path `/haimunia-app/`) | `box-log-db` v7 | `haimunia:` | `haimunia-v` |
| This app | `https://haimunia-app.pages.dev` (Cloudflare Pages since 2026-09-16) | `haimunia-demo-db` v10 | `haimunia-demo:` | `haimunia-demo-v` |

This app cannot read a single byte of the older app's data from where it is
hosted now. `test/old-app-backup-imports.test.mjs` already states this: "a
different origin cannot read the old one's IndexedDB". The move and its cost
are recorded in `docs/deploy/HEADERS.md`.

So there are exactly two ways to carry a member's data across:

1. **Same origin, same path (recommended).** Publish the standalone edition
   *as* `haimuniya.github.io/haimunia-app/`, which means pushing it to the
   `haimuniya/haimunia-app` repository's Pages source. The new `sw.js`
   replaces the old one at the same URL and scope (`./`). The new code opens
   the member's existing database on their phone. No member has to do
   anything.
2. **Any other origin.** The member exports a file in the old app and imports
   it in the new one. Every member must do this by hand, and the file loses
   data (see §4.3). Some members won't do it, and when iOS evicts their
   storage the old app's data is gone.

The rest of this plan assumes option 1. §4.3 covers option 2 as the fallback
and as the recovery path.

---

## 1. Files: what the standalone edition needs, and what is community-only

### 1.1 Needed (after the edits in §2)

| File | Role | Edit needed |
|---|---|---|
| `index.html` | Shell + entire stylesheet | Remove community/cloud script tags (lines 3361–3394 minus the core ones), CSP Supabase/captcha hosts (lines 70–75), community CSS blocks, `scene-page--community` classes; see §2.3 |
| `app.js` | The training log | Remove every seam listed in §2; about 40 guarded call sites plus the club-WOD/club-feature/log-owner/sync blocks |
| `theme-init.js` | Pre-paint theme/text size | Key names (§3.3) |
| `frame-guard.js` | JS clickjacking guard | Keep as is. GitHub Pages cannot set `X-Frame-Options`, so this is the only frame protection there |
| `sw.js` | Offline + update flow | Rewrite the precache lists, cache prefix and activate cleanup (§3.4). Drop `push`/`notificationclick`/`PUSH_SELF_TEST` |
| `manifest.json` | PWA identity | None. Byte-identical to the old app's today (`id` and `scope` both `"./"`) |
| `src/shared/safe-helpers.js` | `esc`, `uid`, `clean*`, `brandName` | Keep |
| `src/constants.js` | Catalogues, LIMITS | Remove the `Club` category colour/label (lines 40–51) or leave it inert |
| `src/format.js` | Formatters | Keep |
| `src/sanitize.js` | Record sanitizers | Remove `sanitizeClubWod` and `retiredAt`. **Restore the old EMOM fields (§4.1, blocking)** |
| `src/db.js` | IndexedDB access | Name, version, stores (§3.1). Remove the `syncOutbox`/`communityOutbox` functions and the `queueSyncRecord` calls in every write's `oncomplete` |
| `cloud-config.js` | Config | Replace with a config holding only `brand`, `supportWhatsApp` and `supportEmail`. It must hold no Supabase URL, publishable key, VAPID key or captcha key |
| `privacy.html`, `terms.html` | Legal pages linked from Settings | Rewrite. The current ones describe accounts, posts and cloud backup, none of which exist in this edition |
| `404.html` | | Keep |
| `icon-*.png`, `assets/mark.png`, `assets/icon-*.png`, `assets/logo-full.png`, `assets/medal-*.png`, `assets/fonts/*` | | Keep. The old app precaches the same set |
| `assets/club-photos/*`, `assets/photos/*` | Scene backgrounds | Keep only the ones a training-log screen uses. `community-logo-wall.jpg` is community-only |
| `package.json`, `scripts/sync-version.mjs` | Dev tooling | Trim `package.json` to `jsdom` and `fake-indexeddb` (no Supabase CLI) |
| `test/` (training-log subset) and `test/helpers/boot.mjs` | | See §1.3 |
| `scripts/browser-check/` (training-log subset) | | See §1.3 |

### 1.2 Community-only: not shipped

- **Scripts:** `cloud.js`, `vendor/supabase.js`, `src/eventbus.js`,
  `src/analytics.js`, `src/realtime.js`, `src/image.js`, `src/dormancy.js`
  (the cloud-backup panel), `src/outbox.js`.
- **`src/community/`, all 15 files:** `events.js`, `outward.js`,
  `achievements.js`, `notifications.js`, `challenges.js`, `coach-tools.js`,
  `club.js`, `feed.js`, `comments.js`, `boards.js`, `directory.js`,
  `posts.js`, `share-prompt.js`, `auth.js`, `admin.js`.
- **`src/desktop-layout.js`.** It writes `data-layout`/`data-staff`, and every
  rule keyed on it is staff-only by design (CLAUDE.md §Desktop), so a member
  on a laptop matches nothing. Without `is_staff()` it does nothing. It is
  listed in `REQUIRED_ASSETS` today and must come off that list, not only out
  of `index.html`.
- **Server side:** `supabase/` (migrations, tests, Edge Functions),
  `functions/_middleware.js` (Cloudflare-only, and inert on GitHub Pages),
  `_headers` (inert on GitHub Pages), and the `.github/workflows/` files
  `backup-database.yml`, `deploy-edge-functions.yml`,
  `scheduled-job-alert.yml` and `claude-review.yml`'s Supabase checklist.
- **Docs:** `COMMUNITY_SETUP.md`, `docs/community/`, `CLAUDE_CODE_PROMPT.md`,
  `mockups/`, `design/`. These are not loaded, but the Pages site serves the
  repository root verbatim, so anything committed is public.

### 1.3 Tests

Of 235 entries in `test/`, 104 are `community-*.test.mjs`, and a further set
covers cloud or staff surfaces: `admin-*`, `coach-*`, `desktop-*`,
`sync-*`, `web-push-*`, `platform-*`, `edge-function-*`, `migration-*`,
`mock-permissions-*`, `scheduled-job-*`, `vendored-supabase-*`,
`workflow-*`, `security-hunt-outbox-identity`, `grant-coach-by-handle`,
`shared-join-code-creation`, `trained-together`, `owner-report` and
`invite-gate-*`. None of these apply.

The training-log tests that do carry over include `app-flow`, `achievements`,
`medals`, `calendar*`, `bodyweight-measurements`, `duration-entries`,
`emom`, `superset-blocks`, `wod-*`, `import*`, `old-app-backup-imports`,
`clear-data`, `sanitizers`, `theme*`, `text-scale`, `sw-precache`,
`version-sync`, `install-prompt`, `storage-quota-exceeded`, `first-run-*`,
`stepper-tap-type` and `typing-survives-a-render`. The `hunt-round*` and
`live-bug-hunt-round*` files are mixed: each has to be split by test case,
not by file.

`test/storage-isolation.test.mjs` asserts the **opposite** of what the
standalone edition needs: it requires `haimunia-demo-db` and forbids
`box-log-db`/`haimunia:`/`boxlog:`. It must be replaced with its inverse
(§3), not deleted. The migration depends on those names being exactly right.

---

## 2. Every place the community reaches into the training log

"Imported" here means loaded as a `<script>`. There are no modules. Every
file shares one global scope, so a seam is a global read or a `window.*`
bridge.

### 2.1 Loaded / registered

- `index.html:3360–3394`: `<script defer>` for `vendor/supabase.js`,
  `cloud-config.js`, `src/eventbus.js`, `analytics.js`, `realtime.js`,
  `image.js`, `dormancy.js`, `outbox.js`, all 15 `src/community/*.js`, and
  `cloud.js`. `src/desktop-layout.js` at 3403.
- `sw.js:48–71`: all of the above in `OPTIONAL_ASSETS`, and
  `src/desktop-layout.js` in `REQUIRED_ASSETS` (line 38).
- `sw.js`: the `push` and `notificationclick` handlers and the
  `PUSH_SELF_TEST` message branch (lines 174–260).
- `index.html:68–82` CSP: `jajmlyrjlkhclgphbfbb.supabase.co` in `img-src` and
  `connect-src` (plus `wss:`), and Turnstile/hCaptcha in `script-src`,
  `connect-src` and `frame-src`. The standalone CSP is `'self'` everywhere
  (plus `data:`/`blob:` for images).

### 2.2 Referenced from `app.js`

`typeof X === "function"` guards on cloud-provided globals (line numbers are
first occurrences):

| Global | Lines | What it does in the log |
|---|---|---|
| `isCommunitySignedIn`, `getCommunityNavPreview`, `pick` | 339–345, 1616 | Nav preview of the community tab |
| `communityUnreadCount`, `openCommunityNotifCenter` | 1773–1787 | Header bell badge |
| `cloudSyncActive` | 1876, 1892, 1915, 6364 | Support diagnostics, the "send to club" support route, and the backup-nag threshold (30 days vs 5) |
| `communityMemberId` | 2642 | Owner stamp on sync-outbox rows |
| `renderShareControl` | 5460, 5493, 5766, 5814, 7461 | "Share" controls on PRs, WOD results and medals |
| `cloudStorageStatusText`, `renderBackupSettingsPanel` | 6460, 6371 | Settings: cloud backup status |
| `renderStaffHome`, `renderManageApp`, `renderClubManageApp`, `renderCommunityApp`, `renderStaffContextColumn` | 6765–6870 | The `staffhome`/`manage`/`clubmanage`/`community` tabs |
| `renderCloudConfirmDialog`, `syncCloudDialogFocus`, `syncAppDialogHistoryState` | 6896, 6998, 7028 | Cloud dialogs stacked on app dialogs |
| `afterRenderCommunity`, `afterRenderManage`, `staffHomeAfterRender` | 6985–6994 | Post-render hooks |
| `communityShowsWorkoutResults`, `communityWodLogFor`, `haimuniaLogIsOwnedByAnotherMember` | 7099–7139 | Club WOD card on the WOD tab |
| `openTermGlossary` | 8422 | Community glossary sheet |
| `publishClubWod`, `attachClubWodResult`, `detachClubWodResult`, `openClubWodBoard`, `switchToCommunityTopTab`, `openCommunityPrivacySettings` | 8460–8489 | WOD-tab club actions |
| `shareAchievementToCommunity` | 8596 | Medal sheet |
| `communityOpenCoachBoard` | 8615 | Coach entry point |
| `handleCommunityClick`, `setCommunityTab` | 8283, 8295 | Click delegation into the community |
| `communityInviteFlowPending` | 8900 | Boot: invite-link routing |
| `communityHandlePushDeepLink`, `communityHandlePushSelfTestReceipt` | 8973, 8979 | Service-worker message handling |
| `applyDesktopLayout`, `startDesktopLayoutWatch` | 177, 6747, 8863 | Staff desktop shell |

`window.*` bridges that **app.js publishes** for cloud.js to call:
`switchToCommunityTopTab` (414), `haimuniaBindLogOwner` (1418),
`haimuniaLogIsOwnedByAnotherMember` (1434), `haimuniaBackupConsentPending`
(2140), `haimuniaTotalLoggedEntries` (2175), `adoptCommunityDisplayName`
(3333), `haimuniaTrainingDataSummary` (3640), `haimuniaExportBackup` (3650),
`setClubWods` (3961), `setClubFeatureFlags` (4025), `setClubWodSessions`
(4081), `communityWodLogFor` (4098), `communityWodEntryForAttach` (4115),
`haimuniaActiveTab` (6762).

State and logic in `app.js` that exists only for the community:

- `VALID_TABS` (line 85) includes `community`, `manage` and `staffhome`.
  `?tab=community` must fall back to `add`.
- **Cloud backup sync:** `queueSyncRecord` / `queueAllLocalRecordsForSync` /
  `syncApplyingRemote` / `applyRemotePrivateRecord` (from line 2624). In
  `src/db.js`, every `dbPut*`/`dbAdd*`/`dbDelete*` calls `queueSyncRecord` in
  its `oncomplete`, which is 13 call sites. **Sibling drift:** removing the
  function without removing all 11 calls throws in every write's completion
  handler.
- **PR bus event:** `emitCommunityPrCreated` (2265–2313), which reads
  `window.HaimuniaEvents`/`PRODUCT_EVENTS`.
- **Club WODs:** `clubWods` (626), `CLUB_WODS_CACHE_KEY` (3954),
  `loadCachedClubWods`, `allWods()` merging `clubWods` (4145), and the
  import's orphan filter reading `clubWods` (3722). `allWods()` must revert
  to `WOD_LIBRARY.concat(customWods)`.
- **Club feature flags:** `clubFeatureFlags` / `CLUB_FEATURES_CACHE_KEY`
  (4006–4049). `strengthPercentagesOn()` (4052) and `benchmarksOn()` (4062)
  read them, and an unknown key means **off**. In the standalone edition
  nothing ever sets them. Both features are new relative to the old app (the
  strength-percentage chips and the progress-screen benchmark tracker), so
  "off" is not a regression. The decision is whether to ship them on (a
  constant) or leave them out.
- **Log owner binding:** `LOG_OWNER_KEY`, `logOwnedByOther` (1390–1434).
- **Community achievement claims:** `COMMUNITY_CLAIMED_KEY` and
  `loadCommunityClaimed` (1390–1400).
- **Backup consent sequence:** `BACKUP_CONSENT_KEY` (2122). It gates cloud.js
  `maybeAutoStartBackup()` and means nothing without it.
- **Release notes:** `RELEASE_NOTES` entry `4.0.0` (1677) announces the
  community. See §5.4.
- **Support sheet:** the "send to club staff" route (1905–1911) and the
  `קהילה:` diagnostics line (1880).
- **`clearAllData`:** `dbClearSyncOutbox()` and
  `window.HaimuniaOutbox.clearAll()` (3865–3866).
- **Nav menu:** the `tabCommunityBtn` row (`index.html:2947` comment,
  rendered by `renderNavMenuList()`), and the community bell,
  `notificationsOverlay`'s `scene-page--community` class (index.html:3229).

### 2.3 CSS

`index.html:157–2803` holds community-only sections with their light and
dark twins. These include the immersive club scene layer (264 on), the staff
desktop shell (1309 on, every rule prefixed `html[data-layout][data-staff]`),
the feed scope filter (1811), the club board (2016), the social feed pass
(2171), the printable joining sheet (2337), "community is framed below the
wordmark" (2464), and the wide-desktop block (2688). Removing a rule means
removing it from **all three** theme declarations. A rule removed from `:root`
and left in `:root[data-theme="dark"]` is harmless. The reverse leaves a
light rule with no dark counterpart. `test/theme-token-parity.test.mjs` is
the guard to keep.

---

## 3. Storage differences, store by store, key by key

### 3.1 IndexedDB: the database

| | Older app (2.34.0) | This app (4.77.0) |
|---|---|---|
| Name | `box-log-db` | `haimunia-demo-db` (`src/db.js:7`) |
| Version | 7 | 10 |
| `onversionchange` / `onblocked` | **none** (`app.js:558–576`) | both (`src/db.js:51–57`) |

**Recommendation: the standalone edition opens `box-log-db` at version 7 and
changes no schema.** Reasons, in order:

1. **An upgrade blocks behind the old app.** The old app's connection has no
   `onversionchange`. If a member has the old version open anywhere (a
   background PWA instance or a second tab), an `open("box-log-db", 8)` sits
   in `onblocked` indefinitely. This is the exact 2026-09-11 bug documented in
   `src/db.js:16–28`, but this time the old side cannot be fixed, because it
   is already on members' phones.
2. **An upgrade makes rollback impossible.** After the DB is at v8, the old
   app's `indexedDB.open("box-log-db", 7)` fails with `VersionError` and the
   old app shows a storage error with the member's data still on disk but
   unreadable. At v7, rolling back to `16d0cd8` just works.
3. **No store needs adding.** See the store table below.

A later schema change can still happen, in a release after the standalone
has shipped with `onversionchange` for long enough that no v2.34 page is
still open.

### 3.2 IndexedDB: store by store

| Store | keyPath | Older app | This app | Difference |
|---|---|---|---|---|
| `entries` | `id` | ✓ | ✓ | New optional field `updatedAt` (from `modTs`). `cleanTs` now falls back to the entry's date rather than `Date.now()` for a missing `ts`. Otherwise identical |
| `movements` | `id` | ✓ | ✓ | Identical shape `{id, name, category}` |
| `wodEntries` | `id` | ✓ | ✓ | New: `rx` may be `"plus"` (Rx+); `notes` kept on Rx entries too (the old app keeps them only when `!rx`); `updatedAt`; `partnerTag`. **`emomReps` semantics differ (§4.1)** |
| `customWods` | `id` | ✓ | ✓ | **The new sanitizer drops `emomMovementTypes`, `emomTargetDurations` and `emomTargetWeights` (§4.1)** |
| `bodyweight` | `id` | ✓ | ✓ | Identical `{id, date, weight, ts}` |
| `settings` | `key` | ✓ | ✓ | Key names differ (§3.3) |
| `measureTypes` | `id` | ✓ | ✓ | Identical `{id, name}` |
| `measurements` | `id` | ✓ | ✓ | Identical `{id, typeId, date, value, ts}` |
| `syncOutbox` | `id` | — | ✓ | Community-only (cloud backup queue). Drop |
| `communityOutbox` | `id` | — | ✓ | Community-only. Drop |
| `wodMovementTags` | `name` | — | ✓ | Training-log feature (WOD builder remembers a typed movement). **Store it as one `settings` row (`key: "wodMovementTags"`, `value: [{name, category}]`) instead of a new store**, so there is no version bump |

Id formats are the same on both sides: `uid(prefix)` gives
`<prefix>-<uuid>`, and `cleanId` uses the same charset and `idLen` 128. A
record id never needs rewriting.

Every older-app record passes the new sanitizers except for the EMOM fields,
because every new field is optional with the old behaviour as its default.
`test/old-app-backup-imports.test.mjs` confirms this for the non-EMOM shapes
via the file path.

### 3.3 Settings rows and localStorage, key by key

| Older app key | Where | This app's equivalent | Standalone |
|---|---|---|---|
| `haimunia:userName` | settings (and legacy localStorage, migrated on read) | `haimunia-demo:userName` | **Keep the old key** |
| `haimunia:boxStartDate` | settings | `haimunia-demo:boxStartDate` | Keep the old key |
| `haimunia:barWeight` | settings, one of `[20,15,8]` | `haimunia-demo:barWeight`, same `BAR_OPTIONS` | Keep the old key |
| `haimunia:seenAchievements` | settings, array of ids | `haimunia-demo:seenAchievements` | Keep the old key. See §5.3 |
| `haimunia:lastSeenVersion` | settings, `"2.34.0"` | `haimunia-demo:lastSeenVersion` | Keep the old key. See §5.4 |
| `haimunia:hasOnboarded` | settings, `true` | `haimunia-demo:hasOnboarded` | Keep the old key |
| `boxlog:lastExportAt` | settings (and legacy localStorage, migrated on read) | `haimunia-demo:lastExportAt` | **Keep `boxlog:`**, the one key with a different prefix |
| `sessionNote:<YYYY-MM-DD>` | settings | `sessionNote:<date>`, **same, unprefixed** | No change |
| `haimunia:theme` | localStorage, read by `theme-init.js` | `haimunia-demo:theme` | Keep the old key in both `theme-init.js` and `app.js` (sibling pair) |
| `haimunia:textScale` | localStorage, read by `theme-init.js` | `haimunia-demo:textScale` | Same |
| `haimunia:installDismissed` | localStorage (`app.js:4974`), **not listed in the brief** | `haimunia-demo:installDismissed` | Keep the old key, or a member who dismissed the install banner sees it again |
| — | | `haimunia-demo:iosInstallDismissed` | New. Rename to `haimunia:iosInstallDismissed` |
| — | | `haimunia-demo:wodRxDefault` | New, training-log. Rename to `haimunia:`. Absent means the default |
| — | | `haimunia-demo:pctIncrement` | New, training-log (percentage chips). Rename. Absent means 2.5 |
| — | | `haimunia-demo:firstOpenDate` | New. Rename. Absent on an existing device means "long past day one", which is correct (`app.js:8836–8839`) |
| — | | `haimunia-demo:firstLogCelebrated` | New. Rename. Bootstrapped `true` for a device with data (`app.js:8844`) |
| — | | `haimunia-demo:backupConsent` | Community (cloud backup). Drop |
| — | | `haimunia-demo:logOwnerUserId` | Community. Drop |
| — | | `haimunia-demo:communityClaimedAchievements` | Community. Drop |
| — | | `haimunia-demo:clubWods`, `haimunia-demo:clubFeatures` | Community. Drop |
| — | | `haimunia-demo:cloudSyncEnabled`, `…:backupOptOut`, `…:notifPushEndpoint`, `…:notifPushFlag`, `…:coachEngageFlag`, `…:hideMyLeaderboardResult`, `…:seenIntroCarousel`, `…:mgmtAccount`, `…:prPromptDismissed`, `…:prPromptMovementLastShown`, `…:sharePromptsOff`, `…:workoutPromptOffered`, `…:termSheetOpens`, `…:termMarks`, and the actor key in `auth.js:189` | Community, all localStorage. Drop |

In short, the standalone edition **adopts the older app's names wholesale**.
It does not keep this app's `haimunia-demo:` names and copy the data across.
Copying means two copies on the device, a half-finished copy if the tab dies
mid-way, a question of which copy is authoritative, and double the storage on
the phones iOS is most eager to evict.

The one-line consequence for this repository's own tests: the standalone
edition's version of `storage-isolation.test.mjs` asserts that `box-log-db`,
`haimunia:` and `boxlog:lastExportAt` **are** used and `haimunia-demo` is
not.

### 3.4 Service worker and Cache Storage

| | Older app | This app |
|---|---|---|
| Path / scope | `./sw.js`, `./` | same |
| Cache name | `haimunia-v<ver>` | `haimunia-demo-v<ver>` |
| Activate cleanup | **deletes every cache on the origin** except its own | deletes only `haimunia-demo-v*` except its own |
| Install | one `allSettled` over everything | `REQUIRED_ASSETS` strict, `OPTIONAL_ASSETS` best-effort |
| `SKIP_WAITING` message | ✓ | ✓ |

The standalone uses the prefix `haimunia-v` and a scoped cleanup that deletes
only `haimunia-v*` other than its own. The old app's "delete everything"
cleanup is a hazard on a shared `github.io` origin, and there is no reason to
keep it.

The update path from 2.34.0 works without new code on the old side. The old
page's `reg.onupdatefound` → `offerUpdate()` → `postMessage({type:
"SKIP_WAITING"})` → `controllerchange` → reload flow (old `app.js:4935–4947`
and `5466–5484`) talks to whatever `sw.js` is at that URL, and the new one
answers `SKIP_WAITING`.

`APP_VERSION` must be **greater than 2.34.0**. `compareVersions` drives the
"what's new" list and `sync-version.mjs` drives the cache name. Something
like `3.0.0` for the first standalone release works. Carrying over `4.77.0`
from this repo also works numerically, but it implies a history members
never saw.

### 3.5 Built-in catalogues, id by id

**Movements (`MOVEMENTS`).** Old has 64, this app has 75. **All 64 old ids are
present, unchanged, in the same categories.** 11 are new: `squat-clusters`,
`safety-bar-squat`, `pin-squat`, `deadlift-clusters`, `rack-pull`,
`block-pull`, `behind-the-neck-press`, `hang-power-clean`, `tall-clean`,
`tall-snatch`, `sumo-deadlift-high-pull`. 17 existing ids gained
`barbell: false`: `single-arm-db-press`, `weighted-pullup`,
`weighted-chinup`, `single-arm-db-row`, `face-pull`, `lat-pulldown`,
`weighted-dip`, `turkish-getup`, `weighted-step-up`, `nordic-curl`,
`ghd-hip-extension`, `weighted-plank`, `ab-wheel-rollout`, `leg-press`,
`leg-curl`, `leg-extension`, `calf-raise`. That flag changes the barbell
visual and the weight floor for new sets. It does not touch stored entries.

**WODs (`WOD_LIBRARY`).** Old has 25, this app has 32. **All 25 old ids are
present with identical name, category, scoreType and desc.** 7 are new:
`chelsea`, `amanda`, `linda`, `fight-gone-bad` (Girls); `the-seven`,
`hansen`, `glen` (Heroes).

**WOD builder tags (`WOD_MOVEMENT_TAGS`).** 137 on each side, identical.

**Consequence.** No `exerciseId` or `wodId` in a member's data points at
something the standalone edition doesn't know. No id remapping is needed.
A member's custom movement or custom WOD *named* like a new built-in (for
example a custom "Rack Pull") stays a separate custom item, because ids are
`uid()`-based and never collide with a built-in slug. It will appear twice
in the picker. That is cosmetic and safe.

---

## 4. What would break for a member with data in the older app

### 4.1 Custom EMOM WODs (blocking, data loss)

The older app gained a richer EMOM model after this app forked from it
(old release notes 2.28.0 and 2.29.0). Each station has a type
(`reps`/`duration`/`rest`), a target duration, a target weight, and rest
stations:

- `customWods` fields `emomMovementTypes`, `emomTargetDurations`,
  `emomTargetWeights` (old `app.js:436–448`, builder at 2777–2780).
- `wodEntries.emomReps` stores **only the non-rest stations** (compacted,
  old `app.js:2842`), and is re-expanded against `emomMovementTypes` on edit
  (2884–2890).

This app has none of that. `grep emomMovementTypes` finds nothing in
`app.js`, `src/` or `cloud.js`, and there is no `toggle-builder-movement-rest`
action. `sanitizeWodShape` (`src/sanitize.js:60`) rebuilds a custom WOD with
only `emomMovements`/`emomTargetReps`/`emomMinutes`.

What a member sees on first open:

- A custom EMOM with a rest station shows "Rest" as a station to log reps
  against. The saved `emomReps` array is one shorter than the station list,
  so on **edit** each value after the rest slot shifts onto the wrong
  station, and saving writes the misalignment to disk.
- Duration stations are treated as rep stations. Target durations and
  target weights disappear from the form.
- The drop is in memory on load (`reloadFromDb` re-sanitizes). It becomes
  permanent on disk the first time the WOD is re-saved, and **immediately**
  on the file-import path, because `importDataFromFile` sanitizes before
  `dbAddCustomWod`.

**Fix:** port the older app's EMOM model (the sanitizer fields, the builder
rest toggle, and the compact/expand of `emomReps`) into the standalone edition
*before* it reads any member's data. Do not migrate the data down to the
poorer model. `test/fixtures/old-app-backup-v1.json` contains no EMOM WOD,
which is why nothing caught this. Add one with a rest station and a duration
station.

### 4.2 Other visible changes

| # | What | Severity | Cause |
|---|---|---|---|
| 1 | **Bronze PR medals disappear** for any category where a member has 1 or 2 PRs | High (visible loss) | `PR_TIERS` bronze `need` is 1 in the old app (`app.js:1077`) and **3** here (`app.js:907`). `earned()` is computed live, so the medal simply isn't earned any more. Decide: keep 1 in the standalone edition, or accept it and say so in "what's new" |
| 2 | "What's new" shows the **4.0.0 "community is here!"** note | High (wrong) | `lastSeenVersion` is `"2.34.0"`, and every `RELEASE_NOTES` entry newer than that renders. Rewrite `RELEASE_NOTES` for this edition, with one entry for the first standalone version |
| 3 | Backup nag after **5 days** instead of 21 | Medium | `renderSettingsBody` uses 30 days for cloud-covered members and 5 otherwise (`app.js:6364–6365`). Every standalone member is "otherwise". Pick one number deliberately |
| 4 | Calendar "log for this date" button gone | Medium (feature regression) | Old `data-action="cal-log-day"` (old `app.js:3601`, 3670) doesn't exist here |
| 5 | History search "clear" buttons gone | Low | Old `clear-history-search`/`clear-wod-history-search` don't exist here |
| 6 | Navigation changes (menu + bottom bar, different Settings entry point) | Low | Old 2.32.0 returned to a bottom tab bar with ⚙ in the header. Expected, and should be announced |
| 7 | 7 new benchmark WODs and 11 new movements appear | None (additive) | §3.5 |
| 8 | Rx+ option, partner tag, notes on Rx results | None (additive) | New optional fields |

Item 4 comes from comparing `data-action` values across both trees, and 5–6
come from the old release notes. Each needs confirming by opening both apps
side by side before it is fixed or dropped. The old app's 2.25–2.34 release
notes are the checklist for anything else that forked away.

### 4.3 If the standalone edition is **not** on the old origin

Everything in §4.1–4.2 still applies, plus:

- Nothing migrates unless the member exports and imports by hand.
- The old export (`buildBackupPayload`, old `app.js:2211`) has **no
  `sessionNotes`**. Every per-day training note is lost on this path.
- The old export has **no settings**: name, box start date, bar weight,
  theme, text size and seen achievements. The member re-enters their name
  and box start date. Without `seenAchievements`, this app's import doesn't
  re-baseline (the old app called `baselineSeenAchievements()` after import,
  but this app's `importDataFromFile` has no such call), so the member's
  next save pops a celebration listing every medal their history already
  earned. That is a sibling-drift gap in this repo today, independent of
  the standalone work.
- Installed home-screen icons keep pointing at the old URL.

---

## 5. What the one-time migration actually has to do

With the §3 choices (same origin, same DB name/version, same keys), most of
the "migration" is **not writing a migrator**: the standalone edition reads
the old data where it already is. What is left:

1. **Settings rows the old app never wrote.** The bootstrap block in
   `init()` (`app.js:8805–8847`) already does the right thing for a device
   with data, provided it runs *after* `reloadFromDb()` and the settings
   loads, which it does today. `isFreshInstall` should also count
   `measureEntries` and `customWods` (today it counts neither), or a member
   whose only data is measurements is treated as a first run.
2. **`wodMovementTags`.** Nothing to migrate. The old app never persisted
   them (they were in-memory only; `src/db.js:44–48` is the fix). Start the
   settings row empty.
3. **Achievements.** Keep `haimunia:seenAchievements` as is. If the PR
   bronze threshold changes (§4.2 #1), no write is needed. If the 7 new WODs
   add `rx-*` ids, they are unearned for any existing member, because none
   could have logged them. So no baseline is needed on upgrade. Add the
   missing `baselineSeenAchievements()` call to the import path anyway.
4. **`lastSeenVersion`.** Leave the stored `"2.34.0"` alone and ship a
   `RELEASE_NOTES` whose only entry newer than it is the standalone
   introduction.
5. **A migration marker.** Write `haimunia:schemaEdition = "standalone-1"` to
   settings on first successful boot. It costs one row and gives any future
   migration a known starting point, instead of inferring the edition from
   which keys happen to exist.
6. **A pre-upgrade safety file.** On the first boot where the marker is
   absent and data exists, offer a one-tap backup download (the
   `box-log-backup-before-delete` pattern from `clearAllData`) *before* the
   first write, with session notes included via the new payload. It is
   cheap insurance against a defect in steps 1–5, and the old export can't
   provide it because it omits notes.

Nothing else. No record is rewritten, no id is remapped and no store is
created. Every step is idempotent.

---

## 6. Step list, in order

1. **Decide the origin.** Get explicit agreement that the standalone edition
   ships to `haimuniya.github.io/haimunia-app/` via the
   `haimuniya/haimunia-app` repository, not to `pages.dev` or a new domain.
   Everything below assumes it.
2. **Decide the three product questions:** PR bronze threshold (1 or 3),
   backup-nag interval, and whether strength-percentage chips and the
   benchmark tracker ship on or off.
3. **Create the edition as a branch of `haimuniya/haimunia-app`**, seeded
   from this repo's training-log files (§1.1). This app stays where it is.
   Two editions in one repo would put every `sw.js`/`index.html` change
   through a two-way sibling-drift check forever.
4. **Strip the community** along the §2 inventory, grep-driven:
   `typeof window.<name>`, `window.haimunia*`, `queueSyncRecord`, `club`,
   `community`, `cloud`, `staff`, `data-layout`. Remove the dead branches
   rather than leaving guards that are always false.
5. **Switch the storage identifiers** to the old app's (§3.1–3.4): `box-log-db`
   v7 with no new stores, `haimunia:` and `boxlog:lastExportAt`, cache
   prefix `haimunia-v` with scoped cleanup, and `onversionchange`/`onblocked`
   kept. Invert `storage-isolation.test.mjs`.
6. **Port the older app's EMOM model** (§4.1). Add an EMOM-with-rest-and-duration
   custom WOD and a matching entry to the old-app fixture, and test both the
   in-place path and the file path.
7. **Port the other old-only features** confirmed in §4.2 (#4 and #5 at
   least).
8. **Rewrite `RELEASE_NOTES`, `privacy.html`, `terms.html`**, the Settings
   "saved on this device only" copy, and the support sheet (WhatsApp/email
   only).
9. **Write the migration steps of §5** (marker, `isFreshInstall` fix,
   import baseline, first-boot safety download).
10. **Build a real-data rehearsal.** In Chromium, serve `16d0cd8` at
    `http://localhost:<port>/haimunia-app/`, install its SW, and seed a
    representative log through the UI: ladders, supersets, durations, EMOM
    with rest, measurements, notes, theme, text size and name. Then swap the
    files for the standalone edition and let the old page's update banner
    drive the swap. Assert every record, setting and localStorage key is
    intact and the what's-new sheet is correct. Repeat with a second old tab
    left open (the `onblocked` case). Then **roll back** to `16d0cd8` and
    assert the old app still opens the data.
11. **Run the full suites** of the new repo: `npm test` and the browser
    checks.
12. **Ship to a staging path first.** Use a copy at a different path on the
    same origin, reachable only by staff, with their own real data exported
    and imported. Then publish to `/haimunia-app/`.
13. **Keep `16d0cd8` tagged** as the rollback target, and document the
    rollback: revert the Pages source. At v7 it is safe (§3.1).
14. **After release, tell members once** (WhatsApp is the club's channel)
    to open the app and tap "update", and to export a backup first if they
    haven't in a while.

---

## 7. Risks, ordered

1. **Hosting on a different origin.** Every member's local data becomes
   unreachable from the new app, silently, and iOS eventually evicts the old
   copy. It is mitigated only by step 1. Worst case: total loss for any member
   who doesn't do a manual export/import.
2. **The custom EMOM model regresses** (§4.1). Silent structural loss on
   first re-save, and misaligned reps on edit. Permanent on the import path.
   Mitigated by step 6 before anything ships.
3. **Bumping the IndexedDB version.** It blocks behind any open old tab or
   PWA instance (the old app has no `onversionchange`), and it makes rollback
   impossible (`VersionError`). Mitigated by staying at v7 (§3.1).
4. **Getting a storage key wrong.** A single typo (`haimunia:` vs
   `haimunia-demo:`, or `boxlog:lastExportAt` vs `haimunia:lastExportAt`)
   reads as "no value": the member's name disappears, the welcome sheet
   reappears, and onboarding re-runs. Mitigated by the inverted isolation
   test (step 5) and the rehearsal (step 10).
5. **Visible medal loss** from the PR bronze threshold (§4.2 #1). This is
   not data loss, but members will read it as lost progress. Mitigated by
   step 2.
6. **A community reference left behind.** An unguarded call to a removed
   global throws in a render path, and on a `REQUIRED_ASSETS` miss the SW
   refuses to install and the old version stays. That second outcome is at
   least safe. Mitigated by the step-4 greps and `sw-precache.test.mjs`.
7. **Old cleanup deleting other apps' caches.** Until every member has
   updated, the old SW's activate handler still deletes every Cache Storage
   entry on `haimuniya.github.io`, including a staging copy's. This only
   affects offline caching, not data. Mitigated by staging at a path whose
   precache failure is harmless, and by accepting it until adoption.
8. **Stale "what's new".** The community announcement shows up in a
   community-free app. Embarrassing, not harmful. Step 8.
9. **The iOS eviction window during rollout.** A member who doesn't open the
   app for weeks may be evicted before or after the update. That is
   independent of this work, but the backup-nag interval (step 2) is the
   lever.
10. **Duplicate-looking picker items** where a member's custom movement or
    WOD matches a new built-in (§3.5). Cosmetic.
11. **Stale `haimunia-demo-db` on `github.io`.** Anyone who used this app
    at its old `github.io` path before 2026-09-16 may have a
    `haimunia-demo-db` there as well. The standalone edition ignores it. It
    is not a member-data source for this migration, but it is on the same
    origin and should be left alone, not deleted.

---

## What was not done

- No suite was run. This is a read-only audit and nothing changed.
- The old app was not run in a browser. The feature regressions in §4.2
  #4–6 come from reading code and release notes, not from using both apps.
- The live `haimuniya.github.io/haimunia-app/` deployment was not fetched.
  The audit is against `16d0cd8`, which is that repository's `HEAD`, on the
  assumption that Pages serves `HEAD`. Confirm this before step 10.
