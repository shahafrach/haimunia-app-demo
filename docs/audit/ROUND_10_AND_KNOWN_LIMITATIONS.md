# Round 10, and what is deliberately still open

Written 2026-09-16, at the end of a ten-round live bug hunt. Two purposes: to
record what round 10 found, and — more useful to whoever reads this next — to
write down the things that are *knowingly* unfixed, so nobody has to rediscover
them by accident and nobody mistakes them for oversights.

## What round 10 found, and the pattern behind all ten rounds

Twelve confirmed defects, fixed in v4.61.0. The distribution is the story:

| Kind | Count |
|---|---|
| Sibling drift — a rule applied in one place, not the twin beside it | 8 |
| Silent data loss or misattribution | 3 |
| Copy that reads wrong at count 1 | 1 (4 sites) |

Across all ten rounds, roughly **half of every defect found was sibling drift**.
Not novel bugs: rules already decided, already written down, already tested in
one location, and simply not carried across to the near-identical code beside
them. Two of round 10's findings were drift from round *9's own* fixes, written
one day earlier — including a migration whose own comment named the pattern it
was fixing and then left three siblings untouched.

The practical lesson, which is now enforced by tests rather than by intention:
**when a rule gets fixed in one place, the fix is not done until every sibling
is found.** Where possible the fix was restructured so drift becomes impossible
rather than merely corrected — e.g. the badge `aria-label` is now derived from
one `badgeAria()` helper that both sub-tab bars call, instead of two hand-built
strings that had already drifted apart from the visible text.

A second, humbler lesson. Three times this session a *test I wrote to lock in a
fix* was itself wrong: once it asserted my own incorrect behaviour (and the
wider suite caught it), and twice it tripped a copy rule because my explanatory
comment contained the very string the rule bans. Once, a fix looked complete and
did nothing at all — `showToast()` only queues a toast and `render()` is what
paints it, so the confirmation sat unpainted until some unrelated render
flushed it. The cheapest test to write after a fix is one that describes what
you just typed, and that test is worth very little. The ones that earned their
place here assert the *requirement*, and were each verified to fail against the
unfixed code before being trusted.

## Knowingly open, with reasons

### 1. The training log is bound per device, not per entry
`LOG_OWNER_KEY` (app.js) binds a device's log to the first community identity
that signs in, and gates the **club-facing** bridges when a different member
signs in later. That stops the real harm found in round 10: a second member on
one phone being offered the first member's results to publish under their own
name, which wrote a real row to `club_wod_results` attributed to the wrong
person.

What it does *not* do is track ownership per entry. So on a genuinely shared
device the second member cannot attach their own newly logged result either —
the gate is on the whole log. That is the conservative direction (nothing is
misattributed, nothing is deleted, no private history is hidden), and the
in-app copy says plainly that results on this device belong to another account
rather than promising something the code does not do.

Per-entry ownership is the fuller fix: stamp each entry with the bound identity
at save time, preserve it through `sanitizeWodEntry`, and filter the bridge on
it. It was deliberately not bolted onto the one code path that writes to the
club board at the end of a long session.

### 2. `admin_member_roster` still stops one page early in one case
Documented before this round and unchanged by it. The RPC sorts and pages on
`coalesce(invite_redemptions.redeemed_at, profiles.created_at)` but only ever
*returns* `redeemed_at`. A profile with no redemption row therefore sorts on a
value the client never sees, so once such a row is last on a page there is no
correct next cursor, and paging stops rather than looping. 202609160002 adds the
`(date, id)` tie-break, which fixes the far more common timestamp-collision
skip, but it cannot invent the coalesced sort key the client was never sent.
The real fix is to return that key. Every row already shown is correct.

### 3. The absurd-weight guard cannot fire on a movement's first-ever set
`saveSet()` and (since round 10) `saveWod()` both ask for confirmation when a
weight is ≥3× the heaviest ever logged. On a movement with no history the
reference is 0, so there is nothing to compare against and a first-set typo —
500 where 50 was meant — goes through unquestioned. That is the moment with the
highest chance of a fat-finger error and the least protection. Probably
unavoidable without an absolute per-movement plausibility table, which would be
wrong for the strongest member in the club.

### 4. Client-supplied `updated_at` is discarded on the update path
`flushOutbox()` pushes `updated_at` = the outbox row's `queuedAt`, intending it
as a modification time. `private_records_touch` (202608260001) is a BEFORE
UPDATE trigger running `new.updated_at = now()`, so on an update that value is
overwritten before it is ever stored. This is *correct* for its actual job — the
pull cursor pages on `updated_at` and needs one server clock, not a fleet of
unsynchronised device clocks — but it means the row remembers when a write
*arrived*, never when the member made it. Recency is therefore judged from the
payload (`updatedAt`, else `ts`) by `pr_payload_mod_ms()`; see 202609160001. The
client still sends the field because it is meaningful on INSERT.

### 5. Stale-write arbitration trusts device clocks
202609160001 drops a write it can prove is older than the row it would replace.
"Older" is decided from device-authored stamps, so a device with a badly wrong
clock can lose its own writes (clock behind) or win ones it should not (clock
ahead). Every alternative needs a server-assigned version per record, which the
bare-upsert sync path does not have. Unstamped payloads are passed through
untouched rather than guessed about: the goal was to stop provable data loss,
not to become a new way to lose a write.

### 6. Deferred by decision, not by oversight
- **Web push** — deferred until after launch, at the owner's explicit choice.
  `streak_risk_nudges` stays off until it exists, because a nudge with no
  delivery channel is a toggle that does nothing.
- ~~**Feed rerender storm**~~ — **FIXED 2026-09-16.** Re-measured first, and
  the shape was not "one tap costs 21 rebuilds" but "three PER-ITEM loaders
  each call rerender() on every response". One scroll to the bottom of a
  30-post feed cost **11 full rebuilds, 20.2 ms — 8 of them from
  `loadReactionsFor` alone**, each throwing away the DOM the last one built.
  `scheduleRerender()` coalesces the three arriving-data paths
  (`loadReactionsFor`, `resolveAvatarUrl`, `resolvePhotoUrl`) into one frame;
  anything the member *did* still rerenders synchronously, because deferring
  a tap by a frame is a visible lag on the one path where responsiveness is
  the point. **Now 4 rebuilds, 8.5 ms.** Guarded by
  `scripts/browser-check/feed-rerender-storm.mjs` (tripwire 6) and
  `test/render-coalescing.test.mjs`.
- ~~**History/Calendar O(n) scans**~~ — **FIXED 2026-09-16.** `entriesFor()`
  is a full scan, and both screens called it per item: History three times per
  movement (180 scans at 60 movements, redone on every keystroke of its search
  box), the calendar four times per day cell (~124 passes to draw one month),
  and `computeCurrentStreak()` twice per day walked backward. `entriesByExercise()`
  and `buildDayIndex()` build one Map per render and throw it away — no cache,
  so there is no invalidation to get wrong. At 2000 entries: History
  **3.6 → 1.3 ms**, calendar **1.2 → 0.6 ms**, streak **0.6 → 0.1 ms**.
  `test/scan-indexes.test.mjs` asserts the indexed and unindexed paths give
  *identical* answers, which is the property that actually matters — a faster
  screen reporting a different personal record would be worse than a slow one.
- ~~**No automated Supabase backups**~~ — **ADDRESSED 2026-09-16.**
  `.github/workflows/backup-database.yml` dumps schema, data and roles nightly,
  encrypts with AES256 before anything leaves the runner, proves the ciphertext
  round-trips, and uploads only that. **Needs two repo secrets** (`SUPABASE_DB_URL`,
  `BACKUP_PASSPHRASE`) and refuses to run without them rather than reporting a
  green backup of nothing. The encryption is not optional: this repository has
  been private since 2026-09-17, and an Actions artifact is still readable by
  everyone with access to it and by anything holding a token with
  `actions: read`, for the 90 days it is retained.
