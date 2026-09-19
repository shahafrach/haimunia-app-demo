# `archive/ux-audit-stash` versus main

What the 13-day-old stash on `archive/ux-audit-stash` still contains that main does
not. **Answer up front: five lines, all in one file pair, all the same defect.**
Everything else in it has landed.

| | |
|---|---|
| Stash commit | `0a43d34` — `WIP on fix/ux-audit-blockers`, 2026-09-06 22:40 +0300 |
| Its base | `45b98fe` — `Add a verified local persona/feed seed`, 2026-09-06 21:10 +0300 |
| main at review time | `8ce9e5c`, 2026-09-19 21:29 +0300 — **219 commits** past that base |
| Diff `45b98fe..0a43d34` | 1382 insertions / 342 deletions across 5 files |

`45b98fe` is an ancestor of main, so the stash is a clean one-commit delta off a
known point. It touches no migration and adds no file, so neither the
forward-migrations rule nor the `sw.js` precache rule is in play.

**The stash was superseded, not abandoned.** The same work was finished on the same
branch and merged the next morning as `c5f75c7` *"Merge the five-persona UX audit
remediation"* (2026-09-07 12:49), whose component commits map one-to-one onto the
stash's sections:

| Stash area | Commit that landed it |
|---|---|
| PRIVACY.md bilingual rewrite | `e17c690` *Make the privacy policy describe what the app actually does, in Hebrew* |
| index.html install-dock / tap targets / fonts | `53d6230` *Stop the install banner covering the nav and the save button* |
| app.js celebration + record honesty | `8afbc57` *Stop celebrating things the member did not earn, and un-invert the chart* |
| app.js kg → ק״ג, bidi in the log | `d568aee` *Isolate mixed-script text in the training log too* |
| cloud.js `<bdi>` wrapping | `3a85c76` *Stop a coach's workout rendering to members as a different workout* |
| cloud.js Hebrew server errors | `a42f9d1` *Stop telling members things in English, and things that are not true* |

The stash is therefore a snapshot taken roughly two hours before that work was
completed. Reviewing it is worth doing only for what fell out during the finish —
and something did.

---

## Verdict table

`✅ on main` — present, usually in a stronger form.
`🔴 still needed` — absent from main and worth porting.
`⚫ obsolete` — the reason for it is gone.

### `privacy.html` (1 line)

| # | Change | Verdict |
|---|---|---|
| P1 | `<title>Privacy Policy – האימוניה` → `מדיניות פרטיות – האימוניה` | ✅ on main (`privacy.html:24`) |

### `app.js` (388 insertions)

| # | Change | Verdict |
|---|---|---|
| A1 | `bestLiftedSetFor()` / `formatLiftedSet()` — headline the heaviest set actually lifted, demote the estimate to a labelled second line | ✅ on main (`app.js:5143`, and the `1RM משוער … לא הרמה שבוצעה` note at `app.js:5068`) |
| A2 | `tenureMilestoneEarned()` — a self-typed box-start date no longer earns tenure badges without ≥1 logged session; same gate on `anniversary_year_*` codes | ✅ on main |
| A3 | `deferredCelebration` / `flushDeferredCelebration()` — hold a celebration that would render on top of onboarding | ✅ on main, generalised: the predicate is `blockingDialogOpen()` rather than a hardcoded two-overlay check, and the flush is also wired to the Escape path (`app.js:7031`, from the 2026-09-11 bug hunt) |
| A4 | `ABSURD_WEIGHT_MULTIPLE` / `heaviestLoggedWeight()` — confirm a set ≥3× the athlete's own all-time best before saving | ✅ on main |
| A5 | `isDownwardCorrection` — don't fire "שיא אישי חדש" when an inflated entry is corrected *downwards* | ⚫ obsolete. Main's rule is strictly wider: `celebratePR = isPR && !existing && priorForExercise >= MIN_ENTRIES_BEFORE_PR` (`app.js:2451`). *No* edit of an existing entry celebrates, in either direction, and a first-ever entry does not either. Porting A5 would narrow main's behaviour. |
| A6 | `askAppConfirm()` / `renderAppConfirmSheet()` + 5s undo for delete-entry and delete-wod-entry | ✅ on main, generalised: the undo bar became `showToast()` / `renderToastBar()` with `offerUndo()` as a thin wrapper (`app.js:2794-2825`), and it now also covers measure-type and measurement deletes (`app.js:3016`, `3079`) |
| A7 | `kg` → `ק"ג` across stat cards, est-line, share text, WOD formatting | ✅ on main — with a different quote character: main uses the Hebrew geresh `ק״ג` (U+05F4), the stash used an ASCII `"`. Main's is the correct one; do not port the stash's spelling. |
| A8 | Bottom-bar CTA stale-label fix (`#saveBtnLabel` still advertising another screen's action) | ✅ on main (`app.js:6128`, `6518`) |
| A9 | WOD-log empty state gets a real `open-wod-picker` button instead of a sentence | ✅ on main (`app.js:6573`, `6625`) |
| A10 | `saveWelcomeForm()` — open onboarding *before* the achievement check | ✅ on main |

### `cloud.js` (144 insertions)

| # | Change | Verdict |
|---|---|---|
| C1 | `bidiHtml()` helper + `<bdi>` in `nameHtml()`; ~45 call sites swapped `esc()` → `bidiHtml()` | ✅ on main **and far beyond it.** The helper was promoted to `src/shared/safe-helpers.js` as a pair — `bidiText()` for plain-text sinks, `bidiHtml()` for already-escaped HTML — both isolating per line and per embedded LTR run, with `lang="en"` on the wrapper for screen readers. There are now ~200 call sites across `app.js`, `cloud.js` and `src/community/*`, plus `test/bidi-isolation.test.mjs` and `scripts/browser-check/bidi-rtl-geometry.mjs`. **Five of the stash's call sites did not survive the split — see "Still needed" below.** |
| C2 | Recovery-gate copy: delete the "עד להשלמת האימות אפשר לצפות בקהילה בלבד" promise of a browse-only mode that does not exist | ✅ on main (`cloud.js:3818`), with better copy — it also says the training log and private backup keep working |
| C3 | `MEMBER_ERROR_PATTERNS` / `memberErrorText()` — Hebrew for bare Postgres wire codes in the outbox banner | ⚫ obsolete as written. Main has `SERVER_ERROR_TEXT` / `serverErrorText()` / `serverErrorIsRetryable()` (`cloud.js:2156-2322`), which is the same idea done properly: a flat keyed lookup rather than a regex list, verified against the live stack rather than read off the schema, *and* it drives whether a "ניסיון חוזר" button renders at all — the stash's version left a retry button next to a permanent failure. |
| C4 | Announcement author rendered through `nameHtml()` instead of a hand-rolled `display_name \|\| "@"+handle` | ✅ on main |

### `index.html` (254 insertions)

| # | Change | Verdict |
|---|---|---|
| I1 | The launch blocker: `#installBanner` / `#iosInstallBanner` moved out of `position:fixed; z-index:59` and into `#bottomNavWrap` as in-flow `.install-dock` children | ✅ on main (`index.html:2605-2670`) |
| I2 | `--bottom-nav-reserve` / `--install-dock-reserve` tokens + the `body:has(…)` padding rule | ✅ on main |
| I3 | `.icon-btn` 44×44 hit area on every dialog ✕ and the dock dismiss | ✅ on main |
| I4 | `#navMenuBtn::after` / `#notificationsBellBtn::after` transparent 44×44 hit boxes | ✅ on main |
| I5 | Font-size floor raised (`.tabbtn` 10.5→12, `.stat-label`, `.bar-caption`, `.stepper-label`, `.rep-cell-label`, `.footer-note`, `.link-btn` 11→13 / 36px, `.nav-sub`, `.subitem`, `.divider-label`, `.cat-name`, `.cal-*`, `.medal-name`) | ✅ on main, every one |
| I6 | `min-height:44px` on `.exercise-row`, `.movement-btn`, `.movecheck-row`, `.cal-cell` | ✅ on main |
| I7 | `#themeRow` / `#textScaleRow` restyled from underlined links into segmented controls | ✅ on main |
| I8 | Hebrew fallback in the display font stacks — `'Anton','Rubik'`, `'JetBrains Mono','Rubik'` | ⚫ obsolete as written. Main went further and added a real Hebrew display face: the stacks are now `'Anton','Secular One','Rubik',sans-serif` (`index.html:924`, `1187`, `1713`, `1726`, `1905`, `1992`), landed as `9630b7a` *Give Hebrew headings a display face of their own*. `.mono` is `'JetBrains Mono','Rubik',monospace` exactly as the stash proposed. Porting the stash's two-family stack would *remove* Secular One. |

### `PRIVACY.md` (595 insertions) — see the dedicated section below

---

## Still needed: five bidi call sites lost in the cloud.js split

This is the entire portable content of the stash.

The stash's C1 pass wrapped every user-typed string in `cloud.js` that renders into
an RTL paragraph. Between the stash being taken and `ec428cd` *Split cloud.js into
per-feature modules under `src/community/`* (#15), five of those call sites ended up
in the new modules **still carrying bare `esc()`**. They are all a member's own
typed display name or team name — precisely the mixed-script case the pass exists for.

| File | Line | Expression | Surface | Who sees it |
|---|---|---|---|---|
| `src/community/boards.js` | 238 | `esc(name)` in `leaderboardRowHtml()` | Consistency / challenge leaderboard row | every member |
| `src/community/challenges.js` | 931 | `esc(mine.name)` | "my team" line on a team-challenge card | every participant |
| `src/community/challenges.js` | 1098 | `esc(name)` | cooperative-challenge contributors list | every participant |
| `src/community/challenges.js` | 1174 | `esc(name)` | team-reassignment roster | staff |
| `src/community/challenges.js` | 1262 | `esc(name)` | coach progress-entry roster | coaches |

`boards.js:238` is the textbook case of this repo's characteristic defect. That file
holds **two** ranked-row renderers side by side: `renderRankedList`'s `rowHtml` at
line 58, which calls `nameHtml()` and is therefore `<bdi>`-wrapped, and
`leaderboardRowHtml()` at line 238, which is not. Same visual row, same data, one
twin fixed and one missed. The stash caught both because in September they were
fifteen lines apart in one file; the split moved them into the same module but the
fix only ever existed on the stash.

**Size of the port: five one-token edits, two files, no new code.** The fix is
`esc(X)` → `bidiText(X)` — *not* the stash's `bidiHtml(X)`. `bidiHtml()` is for a run
that is already escaped HTML (a comment body with `@mention` buttons spliced in);
these five are raw values, so they need `bidiText()`, which escapes and isolates in
one step. `src/community/*.js` are classic scripts sharing one global scope with
`cloud.js`, so `bidiText` is already in scope in both files and needs no import or
binding. `challenges.js` already calls it at lines 957, 1200, 1302, 1303 and 1390.

### Do **not** port these adjacent `esc()` sites

Six more turned up in the same sweep. They are correct as they stand:

- `challenges.js:1310`, `events.js:625`, `notifications.js:943` — the value lands in
  a `data-note=` / `title=` **attribute**. `<bdi>` is an element; attributes keep bare
  `esc()`. The stash's own comment on `bidiHtml()` says exactly this.
- `challenges.js:1149`, `challenges.js:1172` — `<option>` text. `<bdi>` is not valid
  inside `<option>`; this needs `dir="auto"` on the `<select>` instead, which is a
  separate change and not something the stash proposed.
- `cloud.js:2970` — already inside an explicit `<bdi>`.

### Adjacent, out of scope, flagged not fixed

Not in the stash, found while checking it, listed so the next pass has them:

- `src/community/notifications.js:792` — `esc(r.body)`. For the `announcement` type
  this is real per-row coach-typed content (the code comment two lines up says so),
  which puts it in the same class as the five above.
- `cloud.js:3241`, `src/community/achievements.js:208`, `cloud.js:3215` — names and
  achievement titles. Achievement titles are app-defined Hebrew constants, so the
  risk is lower, but `cloud.js:3241` is a member display name in a profile link.

---

## PRIVACY.md: which of its changes still describe the app

The stash's PRIVACY.md rewrite — bilingual Hebrew-first framing, the "בקצרה"
summary, the honest "gets switched on without asking" backup section, the real
toggle list with real defaults, the "this is not class attendance" training-day
section, the "we will not call this consent" note — **is all on main**, landed as
`e17c690` the following morning and revised since. Main is 784 lines; the stash's
version is 634. Its structure, its section order and most of its sentences are
identical.

What follows is where the **stash's wording**, if it were applied today, would state
something untrue. This is the part worth reading.

### Still correct today

| Claim in the stash | Status |
|---|---|
| Bilingual, Hebrew governs for members | ✅ correct, unchanged on main |
| Nothing leaves the device until a first save or a community join | ✅ correct |
| The backup is private; no member and no coach can read it in the app | ✅ correct — main adds that this is an RLS guarantee, not a promise |
| A "training day" is a logged day, never class attendance | ✅ correct. Main additionally names the club's real booking system (Arbox) |
| A training day is not retracted when the entry behind it is deleted | ✅ correct |
| The drop-in-rate flag: 2-week window vs. 8-week baseline, level + two rates, hidden from its own subject | ✅ correct |
| The eleven privacy toggles and their defaults | ✅ correct — verified against `202608280003_profile_privacy_and_recovery.sql` |
| `show_attendance` / "נוכחות בשיעורים גלויה" defaults **off** | ✅ correct, and load-bearing across half the schema |
| "רישום קרוב לשיעור" exists but reveals nothing — reserved for future | ✅ correct |
| No government ID, location, payment, biometrics, date of birth | ✅ correct, and CLAUDE.md makes it a hard rule |
| Supabase `ap-southeast-1` (Singapore); admins override profile toggles | ✅ correct |
| 90-day deletion of community activity and feed impressions | ✅ correct |
| Account deletion: hidden immediately, purged after 30 days | ✅ correct |

### Now wrong — do not port these sentences

**1. "The backup starts automatically, without asking."** ⚫ The stash leans on this
as its central honesty point, in the summary, in the backup section and in the legal
basis section. **A consent card now exists**: `app.js:4751` renders
`לגבות את האימונים לענן?` after the first save, and `8136133` *Make "לא עכשיו" on
the backup card actually mean not yet* makes the decline real. Main's replacement
text handles this properly by splitting the population — *asked* (basis: consent)
versus *never asked, device predates the card* (basis: contract + legitimate
interest) — and says in as many words that it refused to pick the more convenient of
the two framings. The stash's flat "without asking" would now be false for every
member who installed after 2026-09-07.

**2. "A backup-only account is deleted after 30 days, along with everything backed
up to it."** ⚫ **This is the most dangerous stale line in the file**, because it
describes a data-loss bug that was found and fixed. `202609070001_purge_abandoned_
profiles_training_data_guard.sql` documents the reproduction: one anonymous account,
30 `strength_entry` rows, 40 days old → `purge_abandoned_profiles()` returned success
and left zero rows. It was live and inert only by accident (unset Vault secrets).
The purge now only collects accounts that are **empty**. Main's wording —
`חשבון גיבוי בלבד וריק נסגר אחרי 30 יום` … `אם שמרתם אליו ולו אימון אחד — הוא לא
נמחק` — is the corrected one. Publishing the stash's version would tell members their
training log is deleted on day 31 when it is not, which is both wrong and alarming.

**3. "GitHub Pages serves the app's files."** ⚫ The host is **Cloudflare Pages**
(`9de21de` *Cloudflare Pages is the real host now*; `functions/_middleware.js` exists
precisely because of it; CLAUDE.md says so in its first section). Main already says
Cloudflare Pages in both language halves.

**4. "Coaches see members' training days."** ⚫ Overstated. Reading another member's
`attendance_log` rows requires an admin/analytics permission, not the coach role —
enforced in RLS, not in the screen. What reaches a coach is the aggregate: the
rate-vs-rate flag, the "not active" / "new members" lists, and a training-day *count*
for new members. Main says this explicitly and adds a dedicated paragraph
(`**את ימי האימון עצמם מאמן/ת לא רואה**`) plus a reordered "who sees what" list that
puts coaches above admins. The stash's line reads as a wider disclosure than the
database actually permits.

### Wrong on the stash **and still wrong on main** — new findings

Two claims survived into main's current text and have been overtaken by changes on
2026-09-17. Both are in `PRIVACY.md` and in `privacy.html`. **Not fixed here** — this
PR adds one document and changes no other file — but they are live and member-facing:

**5. Bot protection: "currently not enabled, so nothing is sent to it."**
`PRIVACY.md:266-269` (Hebrew) and `:666-669` (English) both say this.
`cloud-config.js:83-84` now carries `captchaProvider: "turnstile"` and a real site
key, and its own comment records the reversal: *"REVERSED (2026-09-17), before going
live."* Commits `dd527a5` *CAPTCHA on, reversing a decision rather than quietly
contradicting it* and `1366769` confirm it shipped. Cloudflare **is** receiving
request and browser data from the account-creation screens today, and the policy says
it is not.

**6. Push notifications: "the feature is off today and no such identifier is
stored."** `PRIVACY.md:151-152` (Hebrew) and `:532-534` (English). `cloud-config.js`
now holds a real VAPID keypair
(*"REPLACED 2026-09-17 (B3) … This is a real pair"*), `state.featureFlags.notifPush`
defaults to **on** (`cloud.js:231`), `src/community/notifications.js:376` calls
`pushManager.subscribe()` and upserts into `push_subscriptions`, and
`202609170002_the_push_that_actually_sends.sql` is applied. Browser push identifiers
**are** being stored.

Both are one-paragraph corrections in four places (`PRIVACY.md` ×2 languages,
`privacy.html` ×2). They are the same class of defect the stash's own PRIVACY.md work
existed to fix — a policy sentence that stopped being true when the code moved —
which is a reasonable argument for a standing check rather than another audit.

---

## Recommendation

1. **Port the five bidi call sites.** Five `esc(` → `bidiText(` edits in
   `src/community/boards.js` and `src/community/challenges.js`. Small enough to ride
   along with any other change to those files. Worth a test in
   `test/bidi-isolation.test.mjs` asserting that `leaderboardRowHtml` and
   `rowHtml` agree, since that pair has now drifted once.
2. **Correct the CAPTCHA and push paragraphs** in `PRIVACY.md` and `privacy.html`.
   Separate change, separate PR — it is member-facing legal copy, not a code fix.
3. **Delete `archive/ux-audit-stash`** once (1) has landed. Everything else in it is
   either on main or superseded by something better, and a branch that looks like
   1382 lines of unmerged work but is really five is a trap for the next reader.

---

## How this was checked, and what was not run

Every verdict above comes from reading `git diff 45b98fe 0a43d34` hunk by hunk and
grepping the current tree at `8ce9e5c` for the symbol, the string or the CSS rule it
introduced. Claims about defaults, the purge rule, the host, CAPTCHA and push were
checked against the migration or config file named beside them, not inferred from
the commit subject.

**No test suite was run for this PR, and none is claimed.** This change adds one
document under `docs/audit/` and touches no code, no CSS, no migration and no
precached asset, so `npm test`, `scripts/browser-check/run-all.mjs` and
`supabase test db` have nothing to say about it. The two live findings in items 5
and 6 above are read from source; they have not been reproduced against the running
production project.
