# cloud.js — the map, before anything moves

Written to answer one question before a single line is cut: **what is actually
in `cloud.js`, and where would the seams be?** Everything below is measured
off `cloud.js` at `18c9172`, not estimated. The scripts that produced the
numbers are described at the bottom so any of them can be re-derived.

This document is step 1 of splitting `cloud.js` into per-feature modules under
`src/community/`. It deliberately contains no code movement.

---

## 1. The shape of the file

| | |
|---|---|
| Lines | 22,370 |
| Bytes | 1,469,738 |
| Top-level declarations | **1,117** (887 `function`, 230 `const`/`let`) |
| Parsed top-level units | 983 (a unit = one `function` decl, or one `const`/`let` statement) |
| Lines inside those units | 15,416 — the other ~7,000 are section comments and the trailing listener block |
| `window.*` exports | 63 names (the whole public contract with `app.js`) |
| Internal references between top-level units | **3,285** |

The entire file is **one IIFE** (`(function () { "use strict"; … })()`).
Every one of those 1,117 names is a closure binding. Nothing is a module
boundary today; the only real boundary is the 63-name `window.*` surface at
the bottom.

The most-referenced bindings, and therefore the ones any split has to solve
first:

| binding | references | what it is |
|---|---|---|
| `state` | 2,337 | one object literal, **717 lines**, holding every feature's namespace |
| `esc` | 605 | `window.BoxLogSafe.esc`, bound once at the top |
| `rerender` | 537 | the single render entry point |
| `client` | 400 | the Supabase client |
| `A` | 311 | analytics constants |
| `field` | 269 | the form-field helper |
| `setMessage` | 176 | the toast/banner setter |
| `bidiText` | 162 | RTL isolation for interpolated text |

`state` alone is the reason this is not a mechanical cut: it is a single
mutable object every feature reads and writes, declared at L170 and never
re-assigned.

---

## 2. Where the code actually lives

`cloud.js` has 45 `// ====` divider blocks. They are **chronological, not
functional** — they record the order tickets landed, not what belongs
together. Measured sections:

| lines | units | section title |
|---|---|---|
| L59–1533 | 46 | The management client — a SECOND, separate Supabase session |
| L1534–3040 | 77 | JARGON DISCLOSURE (design spec section 3) |
| L3041–3147 | 6 | The club WOD catalogue (202609060028) |
| L3148–3757 | 24 | THE FEED WRITES ITSELF — club WOD sessions and boards |
| L3758–4455 | 23 | COMM-223..226 coach-tools cluster |
| L4456–4572 | 5 | COMM-153, the member's own side of it |
| L4573–5258 | 37 | COMM-150..156 admin-moderation cluster |
| L5259–6614 | 88 | THE JOINING QR |
| L6615–6930 | 19 | COMM-110..115 feed cluster |
| L6931–9238 | 120 | COMM-120..125 engagement cluster |
| L9239–9289 | 3 | UX audit defect 2 — `<input type="date">` in Hebrew RTL |
| L9290–9442 | 8 | the same defect in `<input type="datetime-local">` |
| L9443–9544 | 3 | UX audit defect 1 — empty states |
| L9545–9785 | 22 | COMM-210/211/212 — `feed_leaderboard` |
| L9786–9868 | 6 | COMM-232 — "אנשים שאולי תכירו" |
| L9869–10395 | 33 | COMM-231 — members directory |
| L10396–10448 | 5 | Bug reports inbox |
| L10449–11062 | 22 | The two management panels and the lock on them |
| L11063–11313 | 12 | UX audit defect 3 — incomplete signups |
| L11314–12206 | 56 | COMM-310 admin community analytics dashboard (render half) |
| L12207–13627 | 76 | COMM-101..108, COMM-180 posts cluster |
| L13628–14041 | 13 | COMM-223..226 coach-tools rendering |
| L14042–16487 | 118 | restriction surface + challenges + events rendering |
| L16488–17478 | 56 | OUTWARD SHARING |
| L17479–18888 | 61 | COMM-230 following surface + notifications + realtime |
| L18889–19095 | 7 | Design spec section 3, TIER 3 — the term sheet |
| L19096–20002 | 5 | The two Account-tab coach lists |
| L20003–21141 | 22 | Redesign Phase 1: the "ניהול" (Manage) tab + dialog registry |
| L21142–22370 | 3 | THE DESKTOP STAFF COLUMNS + the trailing listener block |

**The section titles lie about their contents**, and that matters for the
split. Three measured examples:

- The "COMM-120..125 **engagement** cluster" (L6931–9238) contains
  `usernameToEmail`, `passwordRuleError`, `passwordConfirmError`, the whole
  CAPTCHA block, `ensureAnonymousSession`, `startSignup`, `login`,
  `setCredentials`, `saveProfile` — i.e. **all of auth** lives inside the
  comments section.
- The "COMM-231 **members directory**" section (L9869–10395) ends with
  `renderCommentBubble`, `renderComments`, `renderModeration`,
  `auditActionLabel`, `groupConsecutiveAuditActions` — comments *and* admin.
- "THE JOINING **QR**" (L5259–6614) contains the entire admin analytics
  loader block and `publishAchievement`.

---

## 3. Proposed module boundaries, and what they cost

Each of the 983 units was assigned to exactly one module by an ordered
rule set (see §7). The eleven modules the task names, plus four the task's
list does not cover:

| module | units | lines | **separate runs in the file** | first…last line |
|---|---|---|---|---|
| `core` *(not in the task's list)* | 225 | 4,171 | **66** | L18–20813 |
| `admin` | 161 | 2,101 | **38** | L98–20122 |
| `posts` *(not in the task's list)* | 86 | 951 | 11 | L888–16234 |
| `challenges` | 68 | 1,317 | 8 | L2894–18539 |
| `club` | 66 | 891 | 19 | L1011–15591 |
| `directory` | 62 | 892 | 11 | L3505–17730 |
| `outward` *(not in the task's list)* | 55 | 657 | 3 | L8943–17395 |
| `coach-tools` | 48 | 837 | 12 | L3733–19227 |
| `comments` | 39 | 530 | 6 | L6938–10921 |
| `notifications` | 36 | 771 | 5 | L1200–18845 |
| `auth` | 35 | 800 | 5 | L1741–8991 |
| `events` | 35 | 612 | **2** | L12510–15249 |
| `feed` | 32 | 401 | 4 | L6025–18599 |
| `boards` | 25 | 256 | 4 | L2293–21227 |
| `achievements` *(not in the task's list)* | 10 | 229 | 2 | L6536–16486 |

"Separate runs" is the count of non-adjacent blocks a module occupies. A
module with 38 runs is not extracted by cutting — it is extracted by
gathering 38 scattered fragments and proving the reassembly is identical.

### The task's eleven modules do not cover the file

Four sizeable clusters have no home in the requested list, totalling
**376 units / 6,008 lines** — more than a quarter of the file:

- **`core`** (225 units): `state`, `rerender`, `esc`, `client`,
  `communityRpc`, the `SERVER_ERROR_TEXT` table, the outbox bridge, the
  confirm/dialog registry (`CLOUD_DIALOGS`), `field`/`dateField`/`sectionHead`,
  `emptyStateHtml`, the term glossary, `avatarHtml`/`nameHtml`/`bidiText`.
- **`posts`** (86 units): the composer, the eleven post-card renderers,
  `POST_CARD_RENDERERS`, photo upload and signed-URL caching, the PR share
  prompt.
- **`outward`** (55 units): the canvas share-card painter and its bidi
  balancing — 657 lines with no other caller.
- **`achievements`** (10 units).

### The coupling cost, measured

Of the 3,285 internal references, after this assignment:

- **1,982 (60.3%) cross a module boundary.**
- **48 of the 105 module pairs are mutually dependent** (A references B *and*
  B references A). Every feature module is cyclic with `core`; beyond that,
  `directory ↔ comments` (6/9), `posts ↔ feed` (3/4), `boards ↔ challenges`
  (1/5), `admin ↔ auth` (7/7), `club ↔ directory` (8/1) and 30 more.

That is the honest headline: **the seams the task names are real product
seams, but they are not code seams.** Six of every ten internal calls in this
file cross one.

---

## 4. What is *not* a problem

Two things that could have blocked a split, checked and cleared:

**Evaluation order is almost entirely insensitive.** Function declarations
hoist, so only `const`/`let` initialisers that read another `const`/`let` at
init time constrain ordering. There are **15 such initialisers**, and after
discounting names that appear only inside comments, the real chains are
short and stay within one module:

```
cfg → configured → client → state
CLUB_MODULE_TOGGLES, COACH_MODULE_TOGGLES → CLUB_MODULE_KEYS
SERVER_ERROR_TEXT → PERMANENT_SERVER_ERRORS
PROFILE_COLUMNS → PRIVACY_FIELDS → PRIVACY_KEYS
bidiText → LOGIN_RECOVERY_NOTE
```

**There is no name shadowing to untangle.** All 1,117 bindings share one
closure today, so they are already unique; no two units can collide when
separated.

---

## 5. Duplicated logic between modules

Per the instruction not to merge these: listed, not fixed.

### Whole functions that are near-copies across a proposed boundary

Measured by 4-token shingle Jaccard over comment-stripped bodies, threshold
0.55. Five pairs:

| similarity | A | B |
|---|---|---|
| 0.65 | `leaderboardSkeletonHtml` (boards, L9703) | `directorySkeletonHtml` (directory, L9971) |
| 0.62 | `leaderboardSkeletonHtml` (boards, L9703) | `followListSkeletonHtml` (directory, L17582) |
| 0.59 | `performInviteShare` (admin, L5802) | `performOutwardShare` (outward, L17153) |
| 0.59 | `renderChallengeViewOverlay` (challenges, L14532) | `renderEventViewOverlay` (events, L15173) |
| 0.58 | `findNewMemberPost` (coach-tools, L3998) | `findEventCompanionPost` (events, L14867) |

No two top-level functions have byte-identical normalised bodies.

### Identical single lines repeated across proposed boundaries

**139 distinct code lines** appear verbatim in two or more proposed modules.
The ones repeated most often — each is a candidate for exactly the "right line
with three copies" defect `CLAUDE.md` warns about, and each is left alone:

| × | modules | line |
|---|---|---|
| 19 | challenges, boards | `const v = state.challenges.view;` |
| 12 | club, challenges, coach-tools, core | `if (!state.user \|\| !isStaff()) return;` |
| 12 | coach-tools, admin, core, challenges | `const msg = error && error.message;` |
| 9 | posts, challenges, events, outward | `const m = post.metadata \|\| {};` |
| 8 | admin, core | the `skRow` skeleton-row template literal |
| 8 | comments, core, challenges, events, posts | `await refreshOutboxState();` |
| 7 | posts, outward, directory | `state.posts.openMenu = null;` |
| 6 | 6 modules | the shared modal-sheet padding `<div>` |
| 6 | challenges, events | `const name = prof.display_name \|\| (prof.handle ? "@" + prof.handle : "חבר/ה");` |
| 5 | admin, core | `if (!state.user \|\| !isAdmin()) return;` |
| 5 | challenges, club, posts, achievements | the `PRODUCT_EVENTS.POST_CREATED` guard |
| 5 | core, directory | `const pv = state.members.profileView;` |
| 4 | auth, boards, directory | `if (!client \|\| !state.user \|\| !state.profile) return;` |
| 4 | challenges, events | `if (error) return setMessage(failText("הפעולה נכשלה", error));` |
| 4 | core, outward | `if (err && err.name === "AbortError") return OUTWARD_SHARE_RESULTS.CANCELLED;` |
| 4 | core, admin | `if (!isAdmin()) return "";` |

Four of these — the modal-sheet chrome (×6 across six modules), the overlay
header row (×5 across five), the skeleton row (×8) and the chart-card wrapper
(×5) — are pure presentational chrome and would become genuine cross-module
imports the moment the modules exist. They are named here so the split does
not silently duplicate them into five files.

---

## 6. The desktop staff shell (PR #9) — what must not move

`src/desktop-layout.js` is untouched by this work. What `cloud.js` owns is the
three `window.*` renderers the shell calls, plus the week-strip loader:

- `window.renderStaffHome` (L21233), `window.renderStaffContextColumn`
  (L21258), `window.staffHomeAfterRender` (L21283)
- `staffWeekDates` (L21166), `loadStaffWeekBoards` (L21179),
  `renderStaffWeekStrip` (L21193) — assigned to `boards`

All three exported renderers sit in the same trailing block as the document
listeners, and all of them call into `coach-tools`, `club`, `admin` and
`core`. `scripts/browser-check/desktop-staff-shell.mjs` and
`desktop-layout.mjs` measure the result (sidebar 248px at x=892, logging
column 560px at x=300, no context column for a member); those two checks are
the gate on every commit of this work.

---

## 7. How these numbers were produced

Four scripts, run against `cloud.js` at `18c9172`:

1. **Unit extraction** — brace-matched top-level `function` declarations
   (`/^  (?:async )?function NAME\(/` to the matching `^  }`) and top-level
   `const`/`let` statements, producing 983 units with line ranges.
2. **Reference graph** — for each unit body, every identifier token that is
   also a top-level unit name. 3,285 edges. This over-counts identifiers
   appearing inside comments and string literals, which is why §5's
   duplicate detection strips comments first.
3. **Module assignment** — one ordered regex rule set over unit names, first
   match wins; whatever matches nothing is `core`.
4. **Duplicate detection** — comment-stripped, whitespace-normalised bodies
   for exact matches and 4-token shingles for near matches; plus a verbatim
   line index restricted to lines ≥25 characters that are not pure
   punctuation.

The over-counting in (2) is the one number to treat as an upper bound: the
60.3% cross-module figure is computed on the raw graph, so some of those
edges are a function name mentioned in a neighbouring comment. It is not
adjusted downward here because the adjustment cannot be made honestly without
a real parser, and the direction of the bias is stated rather than hidden.

---

## 8. What the split costs the test suite

Two populations of tests depend on `cloud.js` being one file. Both were
counted, not estimated:

| | count | how they depend on it |
|---|---|---|
| **Source-text tests** | **71** | `readFileSync(".../cloud.js")`, then regex/`assert.match` against the text |
| **Executing tests** | **82** | `bootCommunity()` → `test/helpers/boot.mjs` → `window.eval(cloudJs)` in jsdom |

(The two sets overlap; some files do both.)

### Source-text tests, per module

How many of the 71 name at least one symbol belonging to each proposed
module — i.e. how many would have to be repointed when that module moves:

| module | files affected |
|---|---|
| `core` | 71 |
| `admin` | 30 |
| `directory` | 27 |
| `auth` | 26 |
| `club` | 16 |
| `challenges` | 9 |
| `posts` | 8 |
| `comments` | 7 |
| `feed` | 6 |
| `notifications` | 5 |
| `outward` | 5 |
| `coach-tools` | 4 |
| `achievements` | 2 |
| `boards` | 2 |
| `events` | **2** |

This orders the work. `events` (35 units, 2 runs in the file, 2 test files)
is the cheapest first move; `core` is last, and moving it repoints every
source-text test in the suite.

A single shared helper — `cloudSource()` returning `cloud.js` concatenated
with `src/community/*.js` — keeps every existing regex in those 71 files
working unchanged, at the cost that they stop asserting a *per-file*
property. That trade is worth stating out loud rather than making quietly.

### Executing tests: the one hard constraint

`test/helpers/boot.mjs` runs `cloud.js` through `window.eval()` on a jsdom
window created with `runScripts: "outside-only"`. Two consequences:

- **A `<script type="module">` cannot be loaded this way.** `window.eval()`
  of text containing `import`/`export` is a SyntaxError, and jsdom's
  `outside-only` mode does not fetch or link module graphs. All 82 executing
  tests would fail at once on the first commit that introduces ESM syntax,
  and would stay failing until the harness is replaced.
- **Classic scripts have a documented workaround already in the repo.**
  `boot.mjs`'s own comment (lines 17–27) explains that real browsers share
  one global *lexical* environment across classic `<script>` tags — verified
  against real Chromium via `scripts/browser-check` — and that jsdom does
  not, so the helper concatenates the `src/*.js` files into one `eval()`.
  For classic scripts that concatenation is **semantically equivalent** to
  what the browser does, which is why the existing `app.js` split is
  trustworthy under test. For ES modules it would not be: flattening a
  module graph back into one scope is a different execution model from the
  one that ships, so the suite would stop testing the shipped artifact.

`test/sw-precache.test.mjs` is the third constraint, and it is narrower than
it looks: it discovers scripts with
`/<script(?: defer)? src="(\.\/src\/[^"]+)"/g`. That regex matches
`./src/community/*.js` when loaded as `<script defer>`, and **does not match
`<script type="module" …>`** — so under ESM the precache guard would silently
stop covering the new files rather than failing loudly.

### Baseline

Whatever the approach, the number to compare against is the suite's state on
`main` before anything moved. It is recorded in the pull request rather than
here, because it is a property of a run, not of the file.
