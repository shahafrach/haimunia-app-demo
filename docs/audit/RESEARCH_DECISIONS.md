# Competitor research: what was taken, what was refused

Eleven agents researched eleven products on 2026-09-15 (SugarWOD, Wodify,
Hevy, Strong, Strava, PushPress/TeamUp/Glofox/Zen Planner, Discord/Circle,
Linear/Stripe/Intercom/Vercel, TrainHeroic/TrueCoach/BTWB, plus PWA/iOS,
Hebrew-RTL and accessibility passes). They produced roughly seventy
recommendations.

This file is the ledger of what happened to them, because an un-recorded
"no" gets re-proposed by the next pass, researched again, and argued again.
A decision that is written down costs one read; a decision that is not costs
the whole discussion a second time.

---

## Built

| Item | Where |
|---|---|
| Hebrew grammar and typography fixes (gershayim, final-form slashes, genderless 2nd-person verbs) | `test/hebrew-copy-rules.test.mjs` guards them |
| Tap-to-prefill from the recent-entry chips | the mechanic Hevy/Strong build their logging loop around |
| `lang="en"` on the bidi wrapper, for mixed runs | partial by construction, see below |
| A scaled PR named as a scaled PR | `flashWodPR(rx)` |
| Destructive confirms repeat their title's verb+noun | from Vercel's published Geist spec |
| Admin/head-coach panels split fully disjoint | at the owner's direction, not the research's |
| Bug inbox self-loads; admins notified on a new report | `202609150005` |
| Step-up password lock on the admin panel | owner's request |

---

## Declined by the owner, 2026-09-15 — do not re-propose

**Streak consolidation (display).** Three streak definitions coexist and the
header counts consecutive training DAYS, which sits at 1 almost permanently
for a 3-4x/week athlete. Two independent agents recommended re-pointing the
member-facing streak at `consistency_week_streaks()`. **Declined. Closed.**

**The streak-at-risk nudge redesign.** `streak_risk_nudges` is enabled and
fires daily on `activity_pings` - days the app was OPENED - which both the
gamification and community agents called the mechanic in the build closest to
a dark pattern. **Declined. Closed.** The toggle remains in
`club_features` and can be switched off from the admin panel at any time
without a migration, if that is ever wanted.

**Opt-in ranking on the club WOD board.** SugarWOD's daily scoreboard sorted
by result is their most-used social surface. **Declined. Closed.** Note this
is also the direction `community-club-wod-board.test.mjs` actively defends
against ("nothing ranks: no position, no sort") - an attempt to group that
board by Rx/scaled was built and reverted the same day for exactly that
reason, and because the asymmetry it claimed to fix did not exist.

**Finishing the `lang="en"` tagging.** The wrapper covers runs with an
interior neutral ("Back Squat 100") but not bare words ("Fran", "WOD", "Rx"),
which are the ones a Hebrew screen-reader voice most likely mispronounces.
Completing it means a `<span lang="en">` per Latin word - a real DOM-cost
change that would need to clear the render-cost trip-wire. **Declined.
Closed.** The partial coverage stays and is documented as partial in
`safe-helpers.js`.

---

## Refused on the research's own reasoning (before the owner saw them)

Every agent independently rejected the same set, and they are listed so the
argument is not re-run:

- **Absolute or global leaderboards** (KOM/QOM analogues, "heaviest clean",
  an unsegmented "most consistent member" crown). At 150 members with stable
  membership these have one owner for years: a plaque, not a game, and one
  that tells 149 people they have no path.
- **DMs / in-app group chat.** Loses to WhatsApp in an Israeli box, splits the
  conversation, and adds a permanent moderation surface.
- **Daily streaks.** Strava deliberately uses weekly ones because injury and
  recovery interrupt training; a daily streak in CrossFit punishes rest days.
- **A push when the club publishes the day's WOD.** SugarWOD's most-promoted
  notification, and the one recommendation that directly contradicts this
  app's own model - it retrains people into a before-class app.
- **Black-box AI churn scores.** No data to train on, and the existing
  heuristic is explainable, which is the property worth keeping.
- **Billing, scheduling, booking, attendance, kiosks.** Arbox's, permanently.
- **Follower counts, "top cheerer" rankings, presence indicators.** These rank
  real people who see each other weekly.
- **Guilt copy and escalating absence notifications.** In a single-gym app the
  app's voice is the gym's voice.

---

## Open, not declined

- **Tier 4 strategic items**: moving hosting off GitHub Pages (the only way to
  get real clickjacking headers - `frame-guard.js` mitigates today), adopting a
  multi-week programming calendar (which would turn this from a training log
  with a club layer into a box programming platform), and migrating the
  stylesheet to `rem` so system text-size reaches it.
- **The two iOS checks** from the PWA pass, still unverified on a device:
  whether `window.open` returns null inside the installed PWA (which would
  break the support sheet's WhatsApp/mail handoff), and whether
  `touch-action: pan-y` disables pinch-zoom while two code comments claim it
  is deliberately preserved.
