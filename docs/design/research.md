# BOX-LOG Design Research Report

Date: 2026-10-25. Scope: post-workout moment, progress views, delight, design token architecture, Hebrew RTL, color, information architecture.

Method: web search and fetch across product pages, help centers, platform guidelines, browser support data and peer-reviewed or published research. I measured some things myself: I downloaded the four Hebrew fonts from the Google Fonts repository and inspected their OpenType tables and digit widths with fontTools, and I computed every contrast ratio in section 5 with the WCAG 2.x relative-luminance formula. Anything I could not confirm from a source is marked UNVERIFIED.

---

## 1. Top 10 findings

1. **Lead the summary with what improved, then the totals.** Strava's post-activity screen puts trophies for personal bests up front, and a design critique credits these for its positive emotional tone. Hevy marks each PR set with a medal, and SugarWOD calculates PRs automatically as results are logged. All three treat the PR as the headline. A summary screen should also confirm the session ended, which Apple's HIG states directly. [Pratt IxD Strava critique; Hevy Set vs PR; SugarWOD; Apple HIG Workouts]

2. **Compare the user only to themselves. This is BOX-LOG's strongest lever.** Self-monitoring explained the most variation between interventions in a 122-evaluation meta-regression (N = 44,747). Interventions that paired it with another self-regulation technique reached an effect size of 0.42, against 0.26 for the rest. [Michie et al. 2009, Health Psychology] Upward social comparison raised well-being only for users with high self-control and lowered it for the rest (n = 1,452). [Cai and Li 2024, Frontiers in Public Health]

3. **Social visibility works, and a light touch is enough.** In a five-year study of more than a million runners, each extra kilometre run by friends led to about 0.3 km more for the individual. [Aral and Nicolaides 2017, Nature Communications] Strava's 2024 report found 34% of respondents say group exercise keeps them accountable. [GearJunkie on Strava Year in Sport] Seeing friends' logs is the active ingredient. Rankings are not needed.

4. **Weekly targets beat daily streaks, and a missed week must not feel like a loss.** Across seven studies, people re-engage more when a log shows an intact streak than a broken one. The drop after a break is larger when people blame themselves, and smaller when the streak can be repaired. [Silverman and Barasch 2023, Journal of Consumer Research] BOX-LOG's "weeks met, nothing resets" model avoids the break moment entirely. Keep it.

5. **Frame each week as a fresh start.** Gym visits rise 33.4% at the start of a new week. [Dai, Milkman and Riis 2014, Management Science] Open the weekly circle card on Sunday, the start of the Israeli week, with an empty, inviting target, not last week's shortfall.

6. **Show whichever part of the goal is smaller.** Motivation is highest when people focus on the smaller share: completed progress early on, what remains near the end. [Koo and Fishbach, Journal of Consumer Research, via ScienceDaily] Weekly ring copy should read "2 done" at 2 of 5 and "1 left" at 4 of 5.

7. **Celebrate in proportion, and pair the celebration with a next step.** Confetti has lost its impact through overuse, intensity should match the rarity of the moment, and Robinhood removed its trade confetti after criticism. [UX Collective; UX Planet] A routine logged workout earns a quiet confirmation. A real PR earns a moment. A benchmark PR or a milestone week count earns the biggest moment.

8. **There are no haptics on iPhone web, so design without them.** caniuse lists `navigator.vibrate` as unsupported in every iOS Safari version through 27.2, and supported on Chrome for Android and Samsung Internet. [caniuse] A known workaround clicks a hidden `<input type="checkbox" switch>`, which Safari 17.4+ answers with a system haptic. Its own author calls it a hack that Safari could stop at any time. [azukiazusa; ios-haptics README; Frontend Masters] Apple's guidance says to make haptics optional and keep them short. [Apple HIG Playing haptics]

9. **`light-dark()` lets BOX-LOG define every color token once.** Support: Safari and iOS Safari 17.5+, Chrome 123+, Firefox 120+, 91.28% global usage per caniuse. `color-mix()` works on iOS Safari 16.2+ (94.79% global). Relative color syntax needs Safari 18+ and Chrome 119+. [web.dev; caniuse; Stefan Judis] TelemetryDeck shows about 98% of iPhones on iOS 18 or later as of September 2026. One `:root` block with `light-dark()` values plus a `color-scheme` switch replaces three hand-synced blocks.

10. **Pick the font for its numbers, not its letters.** Measured from the Google Fonts files: Heebo and Noto Sans Hebrew have identical widths for all ten digits by default, so numbers align without extra settings. Rubik has proportional digits but ships a `tnum` feature. Assistant has neither: its "1" is narrower and it has no `tnum`, so columns of weights jitter. Heebo pairs a Roboto-based Latin with Hebrew by Oded Ezer. [fontTools inspection; Fontsource]

---

## 2. Recommended post-workout flow, screen by screen

Design goal: the 20 seconds after "Save" should answer three questions in order. Did it save? What did I achieve? Where do I stand this week? Sharing comes after that, and it is always optional.

### Screen 0: Save tap (in place, under 300 ms)
- Disable the button, then turn it into a check mark with a short scale animation (motion-duration-short, ease-out).
- Android: `navigator.vibrate(15)` when the user has haptics on. iOS: nothing, or the switch hack behind a flag (see 4.3).
- Offline: save locally first and show the check anyway. Mark sync state with a small cloud icon, never a blocking error. Apple's HIG asks for clear feedback when a session starts or stops.

### Screen 1: Workout Summary (a full screen, not a toast)
Order of content, top to bottom:
1. **Headline (one line).** On a PR day: "שיא חדש בסקוואט" with the number. Otherwise: "אימון מספר 47" plus the date. Counting sessions carries weight because it never goes down.
2. **Achievement strip (0 to 3 cards).** Show only real achievements: a new heaviest weight, a new estimated 1RM, a rep PR at a given weight, a benchmark PR (a faster Fran), or a first-time lift. Each card shows the new value, the previous best and the delta ("+5 ק״ג"). If there are none, hide the strip. Never show an empty or "no PRs today" state.
3. **"Compared to last time" rows.** One row per main lift: last time against today (top set, or volume). Use neutral wording and a neutral color for a lower result ("־2.5 ק״ג", no red). Show an up arrow only for gains. Hevy shows the previous performance in a "Previous" column during logging. [HotelGyms Hevy review] BOX-LOG moves that comparison to after the workout, where it reads as reward rather than pressure.
4. **Weekly target ring.** Use small-area framing: "2 מתוך 4, נשארו 2" or "היעד הושג". When this session completes the week, the ring gets the strongest celebration on the screen.
5. **Totals in a muted row:** duration, sets, volume. Hevy and Built for Mars show raw totals turned into relatable comparisons ("you lifted a bus"). Make this an optional, playful line, not the headline.
6. **Actions:** primary "שתף בוואטסאפ" (PR card or session card), secondary "סיום". The Strava critique faults the summary for lacking a clear next step. [Pratt IxD]

Celebration intensity by tier:
- Tier 0 (a normal session): check mark, ring fill animation, nothing more.
- Tier 1 (any PR): the PR card slides in with an accent glow, plus one Android vibration pulse.
- Tier 2 (weekly target met, or a benchmark PR): a short burst of brass particles around the ring or card (under 800 ms, at most 12 particles), not full-screen confetti.
- `prefers-reduced-motion: reduce`: every tier becomes an instant state change with a color fade. [W3C Understanding 2.3.3]

### Screen 2: Share sheet (only when the user taps share)
- Generate the PR card or session card as a canvas PNG and pass it to `navigator.share({ files })` after checking `navigator.canShare`. Sharing must start from a user tap. [web.dev Web Share] Fallback: download the image, then open a `wa.me` text link.
- Offer the card in light and dark. Hevy offers light, dark and transparent card backgrounds. [Hevy shareables]
- Card contents: the lift, the new value, the delta, the date, the BOX-LOG mark. No body weight, ever (house rule).

### Screen 3: Back to Home, with the circle in view
- The new log appears at the top of the circle feed, marked "שלך". Reactions from friends arrive later as a quiet badge, not a push storm.
- This closes the loop: log, achieve, share, and later receive fist bumps.

---

## 3. Recommended progress views

Principle: every chart compares the user to their own past, and a weak week renders as calm and neutral, never as red.

1. **Lift detail (one per exercise)**
   - Estimated 1RM line over time, with real 1RM tests as solid dots and estimates as hollow dots. Mark PRs with a brass ring and a direct label, not color alone. [WCAG 1.4.1; Datawrapper]
   - Formula: use Epley for 1 to 5 reps and Brzycki for 6 to 10, and show no estimate above 10 reps. Both formulas lose accuracy above about 10 reps. Epley overestimates at 9 to 10. [dev.to summary of LeSuer 1997; the source does not give sample sizes, so this needs cross-checking]
   - Rep-max table (1RM, 3RM, 5RM, 10RM best). Hevy calls these "set records". [Hevy help] SugarWOD tracks 1, 2, 3 and 5RM. [SugarWOD]
   - Time range: 3 months, 1 year, all. Free, with no paywall on history (Hevy limits free users to 3 months, so this is a differentiator).

2. **Benchmark WOD detail (Fran, Grace, Murph)**
   - A dot timeline in which lower is better for time-based WODs. Label it clearly "מהיר יותר ↓", or invert the axis so better is always higher. Recommend inverting so "up equals better" holds across the whole app.
   - Store RX and scaled as separate series with different marker shapes. A scaled result never sits as a failure on the RX line. SugarWOD stresses smaller gains, such as faster times and less scaling. [SugarWOD]

3. **Consistency view**
   - A weeks-met grid (52 small squares for a year). A met week is filled, a partial week is filled to its percent, and a missed week is an empty outline. Missed weeks stay neutral, never red.
   - Headline numbers: "weeks met this year: 31" and "best run: 9 weeks". Show the best ever beside the current count so nothing feels lost. [screensdesign streak article]
   - Trend tone, borrowed from Apple Trends, which compares the last 90 days with the year average. It groups improving metrics under "Keep it Going" and falling ones under "Worth a Look" with tips. [Macworld] Use one gentle line, such as "יותר אימונים מהממוצע השנתי שלך".

4. **Volume view.** Weekly volume bars per muscle group or movement pattern. This is secondary, kept in Progress, not on the summary. Fitbod and Hevy both put volume in reports, not up front. [Fitbod Insights; Hevy gym progress]

5. **Monthly recap (generated on the 1st).** PRs this month, weeks met, sessions, and the top lift. Gentler Streak, Hevy and Fitbod all use periodic recaps, and Gentler Streak shows its Monthly Recap at the start of each month. [iThinkDiff; Hevy; Fitbod] A recap is also a fresh-start moment. [Dai et al.]

6. **Circle view (social progress without ranking)**
   - Each member gets a ring for percent of their own target. Sort by most recent activity, never by percent.
   - Members who exceed 100% get a full ring plus a small "+1" chip. Do not order or highlight them above others.
   - Aral and Nicolaides found upward comparison the more motivating direction, but Cai and Li found it hurts low-self-control users. Percent of own target keeps the visibility and drops the ranking.

---

## 4. Design token architecture

### 4.1 Structure: three tiers, one file

Recommendation: keep tokens in one `<style id="tokens">` block at the top of `index.html`'s inline CSS, or in a `tokens.css` file added to the `sw.js` REQUIRED_ASSETS. The inline block avoids a render-blocking request and matches the current buildless setup. Every rule outside that block reads only semantic or component tokens.

Tiers, following the common primitive, semantic and component model: name for intent, order broad to specific, and never let components consume primitives. [Always Twisted] The W3C Design Tokens Community Group published its first stable format (2025.10), which covers aliases and themes. [W3C DTCG] A JSON export is optional later. CSS custom properties are enough today.

**Tier 1, primitives (raw values, never used directly in rules)**
- Color ramps in OKLCH: `--p-sand-50 … --p-sand-950` (warm neutral), `--p-brass-300 … --p-brass-800` (accent), `--p-teal-300 … --p-teal-800` (progress), `--p-ember-300 … --p-ember-700` (PR highlight)
- `--p-space-1 … --p-space-12` (4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64)
- `--p-radius-1 … --p-radius-5` (4, 8, 12, 16, 24) plus `--p-radius-full`
- `--p-font-size-1 … --p-font-size-9` (see section 6)
- `--p-duration-1 … --p-duration-5` (100, 150, 250, 400, 700 ms)

**Tier 2, semantic (what rules use)**

| Token | Role |
|---|---|
| `--color-bg` | app background |
| `--color-surface` | cards |
| `--color-surface-raised` | sheets, modals, popovers (lighter in dark mode) |
| `--color-surface-sunken` | input wells, chart tracks |
| `--color-border` | decorative dividers (no contrast requirement) |
| `--color-border-strong` | input outlines, focus-adjacent edges (≥3:1, WCAG 1.4.11) |
| `--color-text` | primary text (≥7:1 target) |
| `--color-text-muted` | secondary text (≥4.5:1) |
| `--color-text-faint` | placeholder, disabled (exempt, but keep ≥3:1 where readable) |
| `--color-accent` | brand accent as text or icon (≥4.5:1 on bg) |
| `--color-accent-fill` | brand accent as button fill |
| `--color-on-accent` | text on accent-fill (≥4.5:1) |
| `--color-progress` | weekly ring, trend lines, "met" squares |
| `--color-progress-track` | ring track, empty week outline |
| `--color-pr` | PR highlight, medals, PR dot rings |
| `--color-pr-soft` | PR card wash (`color-mix(in oklch, var(--color-pr) 14%, var(--color-surface))`) |
| `--color-neutral-delta` | down or flat comparisons (never red) |
| `--color-danger` | destructive actions only (delete workout), never for performance |
| `--color-focus` | focus ring |
| `--shadow-1`, `--shadow-2` | elevation (light mode mainly; dark mode uses surface lightness) |
| `--space-xs … --space-2xl` | aliases onto primitives |
| `--radius-control`, `--radius-card`, `--radius-sheet`, `--radius-pill` | shape roles |
| `--font-body`, `--font-numeric` | families |
| `--text-caption, --text-body, --text-label, --text-title, --text-headline, --text-display, --text-hero-number` | type roles (size + line-height pairs) |
| `--motion-fast`, `--motion-base`, `--motion-slow`, `--motion-celebrate` | durations |
| `--ease-standard`, `--ease-enter`, `--ease-exit`, `--ease-spring` | curves |

**Tier 3, component tokens (only where a component needs to differ)**
- `--btn-primary-bg: var(--color-accent-fill)`, `--btn-primary-fg: var(--color-on-accent)`
- `--card-bg: var(--color-surface)`, `--card-radius: var(--radius-card)`
- `--ring-fill: var(--color-progress)`, `--ring-track: var(--color-progress-track)`, `--ring-size`
- `--pr-card-bg: var(--color-pr-soft)`, `--pr-card-edge: var(--color-pr)`
- `--chart-line: var(--color-progress)`, `--chart-pr-marker: var(--color-pr)`, `--chart-grid: var(--color-border)`
- `--tab-active: var(--color-accent)`, `--tab-inactive: var(--color-text-muted)`

Mapping to the current code: existing tokens such as `--surface`, `--border`, `--steel`, `--chalk` and `--brass` become aliases during migration (for example `--brass: var(--color-accent)`), so old rules keep working while new rules use the semantic names. Remove the aliases once nothing references them.

### 4.2 CSS pattern: single-source light and dark

```css
:root {
  color-scheme: light dark;                 /* follow the OS by default */

  /* primitives (one definition each) */
  --p-sand-50:  oklch(97% 0.008 85);
  --p-sand-950: oklch(17% 0.006 60);
  /* ... */

  /* semantic: every theme-dependent color is written ONCE */
  --color-bg:       light-dark(var(--p-sand-50),  var(--p-sand-950));
  --color-surface:  light-dark(#fff,              var(--p-sand-900));
  --color-text:     light-dark(var(--p-sand-950), var(--p-sand-100));
  --color-accent:   light-dark(var(--p-brass-700), var(--p-brass-300));
  --color-pr-soft:  color-mix(in oklch, var(--color-pr) 14%, var(--color-surface));
  --shadow-1: 0 1px 2px light-dark(oklch(0% 0 0 / .08), oklch(0% 0 0 / .4));
  /* ...non-color tokens (space, radius, type, motion) have no theme... */
}

/* explicit user choice: flip color-scheme, never re-declare colors */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark;  }

body { background: var(--color-bg); color: var(--color-text); }

@media (prefers-reduced-motion: reduce) {
  :root { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; --motion-celebrate: 0ms; }
}
```

Why this works: `light-dark()` follows the used `color-scheme`, not the media query. Changing the `data-theme` attribute therefore re-resolves every token at once, with no duplicated values. [12 Days of Web; web.dev] This replaces today's three color blocks with one. The CLAUDE.md "both dark-theme blocks" rule becomes "one token, written with light-dark()", and a guard test can assert that no color literal appears outside the token block.

Caveats:
- `light-dark()` accepts only colors. Non-color differences, such as a different image or a different shadow structure, still need a small selector block. Keep those rare. [12 Days of Web]
- Fallback for browsers before iOS 17.5 or Chrome 123 (about 9% globally per caniuse, about 2% of iPhones per TelemetryDeck): an `@supports not (color: light-dark(#000, #fff))` block that sets light values only. Or decide to support only iOS 17.5+ and say so.
- `<meta name="theme-color">`: provide two tags with `media="(prefers-color-scheme: …)"`, and update the content from JS when the user forces a theme.
- Material and Apple guidance: avoid pure black, desaturate accents in dark mode, and show elevation with lighter surfaces in dark mode instead of shadows. [Atmos; Apple HIG Dark Mode] Apple says to aim for 7:1 on small text where possible, with 4.5:1 as the floor. [Apple HIG Dark Mode]

### 4.3 Motion and haptic tokens
- Durations: fast 120 ms (press states), base 220 ms (sheets, cards), slow 400 ms (ring fill), celebrate 700 ms (tier 2 burst).
- Curves: `--ease-standard: cubic-bezier(.2, 0, 0, 1)`, `--ease-enter: cubic-bezier(.05, .7, .1, 1)`, `--ease-exit: cubic-bezier(.3, 0, .8, .15)`. These are commonly cited Material 3 values. UNVERIFIED: the M3 token page needs JavaScript and did not render for me.
- Haptics as a JS map, not CSS: `HAPTIC = { tap: 10, success: [12, 40, 18], pr: [20, 60, 30] }`. Android only, behind a user setting that defaults on. On iOS, the switch hack is optional and flagged experimental (Safari 17.4+). Pair every haptic with a visual. [Apple HIG Playing haptics] UNVERIFIED from this research: whether Chrome requires a user gesture for `vibrate()` (my understanding is yes, sticky activation). Trigger it only inside tap handlers.

### 4.4 Spacing, radius, elevation
- Spacing: a 4px grid. Card padding 16, section gaps 24, screen gutter 16 (matches phone width).
- Radius: controls 12, cards 16, sheets 24, pills full. Use logical corners (`border-start-start-radius`) only where a shape is asymmetric.
- Elevation: two levels only. Light mode: shadow-1 on cards, shadow-2 on sheets. Dark mode: surface to surface-raised lightness steps, with near-transparent shadows.

---

## 5. Color direction

Target feel: energetic but calm and premium. Warm neutrals, one confident accent, and a separate progress color, so a PR (rare, warm) never looks the same as routine progress (frequent, cool). Strava uses its signature orange, Gentler Streak uses soft pastel activity hues, WHOOP uses black with recovery green, yellow and red. UNVERIFIED: these app palettes are from general knowledge, not fetched pages.

All ratios below were computed with the WCAG relative-luminance formula. Thresholds: 4.5:1 for normal text, 3:1 for large text (24px, or 18.5px bold), 3:1 for UI and chart graphics. [W3C Understanding 1.4.3; Deque 1.4.11]

### Palette A: "Chalk and Brass" (closest to the current brand tokens)
| Role | Light | Dark |
|---|---|---|
| bg | #F6F3EC (warm chalk) | #141312 |
| surface | #FFFFFF | #1E1C1A |
| text | #1C1B19 → 15.5:1 on bg | #F2EEE6 → 16.0:1 |
| text-muted | #5E5A52 → 6.9:1 on surface | #A8A194 → 6.6:1 |
| accent (text/icon) | #87590B → 5.5:1 on bg (#9A6B12 only 4.2:1, fails as small text) | #E0B25A → 9.4:1 |
| accent-fill + on-accent | #C8922A with #1C1B19 text → 6.2:1 | #E0B25A with #141312 → 9.4:1 |
| progress (teal) | #0F766E → 5.5:1 on surface | #4FD1C5 → 9.1:1 |
| PR (ember) | #B45309 → 5.0:1 on surface | #F59E0B → 7.9:1 |

Notes: in light mode, teal progress and ember PR have almost the same luminance (1.09:1 against each other), so they will merge for color-blind users and in grayscale. Separate them by shape (PR as a ringed dot or medal, progress as a line or fill) and by direct labels. [WCAG 1.4.1; Datawrapper] The surface against bg ratio is only 1.1:1, which is fine for decoration, but cards need a 1px `--color-border` or shadow to read as separate. Muted chart bars must reach 3:1: #8C8579 gives 3.65:1 on white, while #A39C90 at 2.72:1 fails. In dark mode, #6B655C on surface gives 2.95:1 and fails, so pick a lighter value.

### Palette B: "Slate and Ember" (cooler, more athletic)
| Role | Light | Dark |
|---|---|---|
| bg | #F4F6F8 | #0E1116 |
| surface | #FFFFFF | #171B22 |
| text | #14181F → 16.4:1 | #EEF1F5 → 16.7:1 |
| text-muted | #566070 → 6.4:1 | #9AA4B2 → 6.9:1 |
| accent | #C2410C → 4.8:1 on bg | #FB923C → 8.4:1 |
| accent-fill + on-accent | #C2410C with white → 5.2:1 (#EA580C with white is only 3.6:1, fails) | #FB923C with #0E1116 → 8.4:1 |
| progress (blue) | #1D4ED8 → 6.7:1 | #60A5FA → 6.8:1 |
| PR | #C2410C → 5.2:1 | #FDBA74 → 10.2:1 |

Notes: blue against orange is the safest pairing for red-green color blindness. [Datawrapper] That makes B the more accessible chart palette. The risk is that orange reads close to Strava's brand. Muted bars: #8B95A3 on white gives 3.03:1 and passes narrowly. In dark mode, #5B6573 gives 2.92:1 and fails, so pick a lighter value.

### Chart and PR rules for both palettes
- At most three colors in any chart: progress, PR and neutral. [Datawrapper]
- PR is always a shape plus a label ("שיא" next to the dot). It never depends on color alone. [WCAG 1.4.1]
- Lines and markers reach 3:1 against the surface in both themes. Gridlines are exempt as decoration but stay faint. [Deque 1.4.11]
- Do not use red or green to mean good and bad. Down deltas use `--color-neutral-delta`, a muted text tone.
- Test every chart in grayscale and with a deuteranopia simulator.

---

## 6. Typography and Hebrew recommendations

### Font choice (measured from the Google Fonts variable TTFs)
| Font | Weights (variable) | Digits by default | `tnum` feature | Notes |
|---|---|---|---|---|
| **Heebo** | 100–900 | all 10 digits equal width | n/a (already tabular) | Roboto-based Latin, Hebrew by Oded Ezer. Neutral, very legible. Recommended body and numbers font. |
| **Rubik** | 300–900 (+ital) | proportional (the "1" is much narrower) | yes, plus `zero` | Rounded, friendly, more character. Good for display and headlines. Needs `font-variant-numeric: tabular-nums` on number columns. |
| Assistant | 200–800 | "1" narrower than the other digits | **no** | Weights and times jitter in tables. Avoid for numbers. |
| Noto Sans Hebrew | 100–900, width 62.5–100 | all equal width | n/a | Solid fallback. The width axis helps fit long numbers. |

All four include Latin, Hebrew and the shekel sign. Recommendation: **Heebo for everything**, with an optional Rubik 600 to 700 for big display numbers and headlines if the owner wants more personality. Self-host one variable woff2 subset (Hebrew + Latin) and add it to `sw.js` OPTIONAL_ASSETS. Use `font-display: swap`.

### Numbers
- Apply `font-variant-numeric: tabular-nums` globally on `.num`, tables, timers and charts. It is Baseline widely available (since January 2020). [MDN] It is harmless on Heebo and required on Rubik.
- Hero numbers (PR value on the summary): about 48 to 56px, weight 700. Large text needs only 3:1, but keep it at 4.5:1 or above anyway.
- Units: put the number and its unit in one isolated LTR run: `<bdi>102.5 ק״ג</bdi>` or `<span dir="ltr">`. Wrap every opposite-direction phrase, and use `<bdi>`/`dir="auto"` for user-generated strings. [W3C i18n inline bidi] Times like `3:42` and scores like `5+12` especially need isolation, because the `+` and `:` can reorder in RTL.
- In `title`, attribute values and `navigator.share` text, use the isolate controls U+2066 to U+2069, not embedding marks. [W3C i18n]
- Decide once whether the unit comes before or after the number and keep it consistent. Recommended: number, then unit ("102.5 ק״ג"), inside one `<bdi>`.

### Type scale (roles; about 1.2 ratio, rem-based)
caption 12/16, label 13/18 (weight 500), body 16/24, title 18/24 (weight 600), headline 22/28 (weight 700), display 28/34, hero-number 52/56 (tabular). Inputs must stay at 16px minimum, or iOS Safari zooms on focus. UNVERIFIED: this is known iOS behavior, not fetched.

### RTL layout
- `<html lang="he" dir="rtl">`. Use logical properties everywhere: `margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`, `border-start-start-radius`. [MDN logical properties]
- Charts: the time axis direction is a choice. Recommendation: time flows right to left (RTL-native) for timelines, keeping numerals LTR. UNVERIFIED as a convention. Test with 3 to 5 Hebrew-speaking users. Either way, keep the "now" end visually consistent across all charts.
- Mirror directional icons (back arrows, chevrons). Do not mirror the progress ring direction, the play icon or the clock-like timer.

---

## 7. Recommended app structure (4 tabs + a center action)

Reference patterns: Strava's 2024 tabs are Home, Maps, Record, Groups and You, with progress in "You". [Zeno / CyclingTips] WHOOP's 2025 Home stays "focused on today" and moved long-term metrics to a separate tab. [WHOOP] Gentler Streak cut its tabs from four to three. [BGR] Duolingo puts a single primary path on Home and moves secondary things to tabs. [Duolingo blog]

Recommended BOX-LOG bar (RTL order, right to left):

1. **בית (Home / Today):** this week's ring at the top, then a "log a workout" card or today's planned session, then the latest circle activity (3 to 5 items) with reactions, then a "your last PR" card. This is the screen the post-workout flow returns to.
2. **החוג (Circle):** the full feed, member rings (percent of own target, sorted by recency), the weekly circle card with a WhatsApp share, and circle switching (couple, friends). No text comments. Reactions are a fist bump plus two emoji.
3. **＋ (Log, center, raised):** a large button that opens the logger as a full-screen sheet, not a tab destination. Hevy, Strava and WHOOP all give "start or record" a dedicated, central control.
4. **התקדמות (Progress):** lifts, benchmarks, consistency grid, volume, monthly recaps. The "You" pattern from Strava.
5. **אני (Me / Settings):** profile, weekly target, units, theme (system, light, dark), haptics toggle, motion toggle, export, privacy.

Option for 4 tabs: fold "Me" into an avatar button on Home's top bar, as WHOOP does with the profile icon. That gives Home, Circle, Log and Progress.

Notifications to support the routine (opt-in, few): "Friend X logged" (batched, at most one per day), "Your circle card is ready" (Saturday night or Sunday morning, a fresh start), "Monthly recap ready" (the 1st). Never send "You haven't trained in N days."

---

## 8. What to avoid

- Daily streaks, streak freezes, or any streak repair you pay for. Paid protection monetizes anxiety. [Yu-kai Chou; Silverman and Barasch]
- Guilt copy ("You missed…", a crying mascot). Duolingo's crying-mascot emails are a known example of this pattern. [Duolingo experiments blog]
- Leaderboards or ranks inside a circle. Avoid "top of the week" badges.
- Red for lower numbers or missed weeks. Red is for destructive actions only.
- Full-screen confetti on every save. Robinhood had to tone its trade celebrations down. [UX Collective]
- Celebrating before the save is confirmed, or celebrating something that is not the user's own achievement. [UX Planet]
- Trophies or badges for trivia (first login, profile complete). The NTC critique calls trophies overbearing featuritis. [Pratt IxD NTC]
- Long or frequent haptics, or haptics with no visual pairing. [Apple HIG]
- Hard-coded colors outside the token block, and theme values maintained in more than one place.
- Assistant or other non-tabular fonts for weights and times.
- An e1RM estimate shown for sets above 10 reps.
- Body weight on any shared card, and PR cards that reveal other members' absolute numbers to the circle without consent.
- Paywalling or limiting history depth (Hevy's free tier caps graphs at 3 months, so this is a differentiator).
- Apple's HIG advises against an app-specific appearance setting. BOX-LOG keeps one for the explicit choice. Default it to "system".

---

## 9. Open questions for the owner

1. Palette A (warm brass, continuity with the current tokens) or Palette B (slate and ember, more athletic, more color-blind-safe)?
2. Font: Heebo only, or Heebo plus Rubik for display numbers?
3. Week start: Sunday (the Israeli default) or Monday? This drives the fresh-start timing of the circle card.
4. Should the circle see PR values, or only "X set a squat PR" without the number? Each member could choose this per circle.
5. Should a scaled benchmark count as a PR on its own track, or only RX results?
6. e1RM formula display: show "estimated" plainly, or hide the e1RM until the user has three or more sessions on that lift?
7. Haptics on iOS: accept the fragile switch-input hack behind a setting, or ship no iOS haptics?
8. Support floor: iOS 17.5+ only (enables `light-dark()` without a fallback), or add the light-only fallback for older devices?
9. Chart time direction in RTL: right-to-left timelines, or left-to-right like most apps? Worth a quick test with five users.
10. Four tabs (Me in an avatar) or five?
11. Sound on PR: none, or a short optional sound off by default? (Not researched in depth. Most gym users wear headphones. UNVERIFIED.)

---

## 10. Sources

Product and app design
- Pratt IxD, Design Critique: Strava (iOS) — https://ixd.prattsi.org/2025/09/design-critique-strava-ios-app-2/
- Pratt IxD, Design Critique: Nike Training Club — https://ixd.prattsi.org/2023/09/design-critique-nike-training-club-iphone-app/
- Strava tab redesign (CyclingTips / Zeno) — https://zenocycleparts.com/blogs/cyclingtips/new-strava-update-makes-big-changes-to-layout-organization-and-navigation
- the5krunner, Strava App Redesign 2025 — https://the5krunner.com/2025/07/16/strava-app-redesign/
- T3, Strava Athlete Intelligence — https://t3.com/active/strava-s-new-ai-powered-feature-turns-your-workout-data-into-instant-insights
- GearJunkie, Strava Year in Sport 2024 — https://gearjunkie.com/endurance/strava-year-in-sport-trend-report-2024
- Hevy, Live PR notifications — https://help.hevyapp.com/hc/en-us/articles/36012016405655-Hevy-Live-PR-Notifications-Get-Instant-Updates-on-Your-Best-Lifts
- Hevy, Set Records vs Personal Records — https://help.hevyapp.com/hc/en-us/articles/38279531346455-Set-Records-vs-Personal-Records
- Hevy, Gym progress — https://www.hevyapp.com/features/gym-progress/
- Hevy, Shareables — https://www.hevyapp.com/features/shareable/
- Hevy, Live PR feature — https://www.hevyapp.com/features/live-pr/
- HotelGyms, Hevy review — https://www.hotelgyms.com/blog/hevy-workout-app-review-the-up-and-comer-taking-the-fitness-world-by-storm
- Built for Mars, Hevy — https://builtformars.com/company/hevy
- Strong, App Store listing — https://apps.apple.com/il/app/id464254577
- SugarWOD, Performance tracking — https://www.sugarwod.com/?p=14224
- Garage Gym Reviews, SugarWOD — https://www.garagegymreviews.com/?p=203373
- Garage Gym Reviews, Ladder — https://www.garagegymreviews.com/ladder-app-review
- Fitbod, Weekly goal and streaks — https://help.fitbod.me/hc/en-us/articles/360013245993
- Fitbod, Insights — https://fitbod.me/blog/fitbod-insights-feature/
- WHOOP, New home screen — https://www.whoop.com/us/en/thelocker/the-all-new-whoop-home-screen/
- BGR, Gentler Streak redesign — https://bgr.com/tech/gentler-streak-gets-a-major-redesign-focused-on-your-wellbeing/
- Leisure Opportunities, Gentler Streak App of the Year — https://www.leisureopportunities.co.uk/news/Kind-activity-tracker-Gentler-Streak-wins-Apple-Watch-App-of-the-Year/350559
- iMore, Gentler Streak vs rings — https://www.imore.com/apps/health-fitness-apps/want-to-hit-your-2023-fitness-goals-drop-apples-rings-and-try-gentler-streak-instead
- Yahoo / Tom's Guide, Gentler Streak — https://sg.news.yahoo.com/fitness-app-shows-apple-better-180000454.html
- 9to5Mac, Gentler Streak weekly recaps — https://9to5mac.com/2025/11/19/gentler-streak-rolls-out-weekly-recaps/
- iThinkDiff, Gentler Streak Streak Tab 4.0 — https://www.ithinkdiff.com/entler-streak-ios-26-update-liquid-glass/
- Screensdesign, Gentler Streak — https://screensdesign.com/showcase/workout-tracker-gentler-streak
- Screensdesign, streak design examples — https://screensdesign.com/articles/mobile-app-streak-design-examples/
- Screensdesign, Duolingo — https://screensdesign.com/apps/duolingo-language-lessons/
- Duolingo, Streak milestone design — https://blog.duolingo.com/streak-milestone-design-animation
- Duolingo, New home screen — https://blog.duolingo.com/new-duolingo-home-screen-design
- Duolingo, Experiments — https://blog.duolingo.com/improving-duolingo-one-experiment-at-a-time
- Macworld, Apple Activity Trends — https://www.macworld.com/article/233093/ios-13-and-apple-watch-activity-trends-give-you-the-big-picture.html

Research
- Silverman and Barasch 2023, JCR (CU Boulder summary) — https://www.colorado.edu/business/faculty-research/2023/04/19/or-track-how-broken-streaks-affect-consumer-decisions
- Dai, Milkman and Riis 2014, Fresh Start Effect — https://anderson-review.ucla.edu/wp-content/uploads/2021/03/Dai-Milkman-Riis_FreshStartEffect_2014_Mgmt_Sci.pdf
- Wharton Knowledge, Fresh start — https://knowledge.wharton.upenn.edu/article/need-fresh-start-heres-begin/
- Koo and Fishbach, small-area hypothesis (ScienceDaily) — https://sciencedaily.com/releases/2012/04/120416113113.htm
- Michie et al. 2009, self-monitoring meta-regression — https://ore.exeter.ac.uk/repository/handle/10871/13754
- Williams, Edmunds and French, self-efficacy techniques — https://pureportal.coventry.ac.uk/en/publications/what-are-the-most-effective-techniques-for-changing-self-efficacy-2/
- Cai and Li 2024, Frontiers in Public Health — https://public-pages-files-2025.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2023.1281323/text
- Aral and Nicolaides 2017 (MIT Sloan) — https://mitsloan.mit.edu/press/new-study-mit-sloan-school-management-professors-shows-exercise-contagious
- Yu-kai Chou, streak burnout — https://yukaichou.com/gamification-analysis/streak-design-gamification-motivation-burnout/
- e1RM formulas, Epley vs Brzycki — https://dev.to/ffmicheck/the-two-1rm-formulas-that-give-different-answers-and-which-one-to-trust-8ib

Delight, motion, haptics
- UX Collective, Over-confetti-ing — https://uxdesign.cc/the-over-confetti-ing-of-digital-experiences-af523745db19
- UX Planet, Why confetti backfires — https://uxplanet.org/why-confetti-celebrations-backfire-and-how-to-make-them-work-be838a6e7b8b
- Apple HIG, Playing haptics — https://developer.apple.com/design/human-interface-guidelines/playing-haptics
- Apple HIG, Workouts — https://developer.apple.com/design/human-interface-guidelines/workouts
- caniuse, navigator.vibrate — https://caniuse.com/mdn-api_navigator_vibrate
- azukiazusa, iOS Safari web haptics — https://azukiazusa.dev/en/blog/ios-safari-web-haptics
- web-haptics browser support — https://mintlify.wiki/lochie/web-haptics/advanced/browser-support
- ios-haptics README — https://unpkg.com/ios-haptics@0.0.8/README.md
- Frontend Masters, Safari switch input — https://blog.master.dev/safari-gets-a-toggle-switch-input/
- W3C, Understanding 2.3.3 Animation from Interactions — https://w3c.github.io/wcag/understanding/animation-from-interactions.html
- web.dev, Web Share API — https://web.dev/articles/web-share
- LottieFiles, Duolingo case study — https://lottiefiles.com/case-studies/duolingo

Tokens, CSS, browser support
- web.dev, light-dark() — https://web.dev/articles/light-dark
- caniuse, light-dark() — https://caniuse.com/mdn-css_types_color_light-dark
- caniuse, color-mix() — https://caniuse.com/mdn-css_types_color_color-mix
- web.dev, color spaces and functions — https://web.dev/blog/color-spaces-and-functions
- Stefan Judis, Safari 18 relative color — https://www.stefanjudis.com/blog/safari-18-what-web-features-are-usable-across-browsers/
- 12 Days of Web, CSS light-dark — https://12daysofweb.dev/2024/css-light-dark/
- TelemetryDeck, iOS version share — https://telemetrydeck.com/survey/apple/iOS/majorSystemVersions/
- W3C DTCG, first stable spec — https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/
- Always Twisted, token naming — https://www.alwaystwisted.com/articles/design-token-naming-conventions
- Apple HIG, Dark Mode — https://developer.apple.com/design/human-interface-guidelines/dark-mode
- Atmos, dark mode best practices — https://atmos.style/blog/dark-mode-ui-best-practices
- MDN, font-variant-numeric — https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric
- MDN, logical properties — https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Logical_properties_and_values

Accessibility and color
- W3C, Understanding 1.4.3 Contrast — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- W3C, Understanding 1.4.1 Use of Color — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- Deque, 1.4.11 Non-text Contrast — https://dequeuniversity.com/resources/wcag2.1/1.4.11-non-text-contrast
- Datawrapper, colorblind-friendly charts — https://www.datawrapper.de/blog/colorblindness-part2
- The Node, Okabe-Ito palette — https://thenode.biologists.com/data-visualization-with-flying-colors/research/

Hebrew and fonts
- Fontsource, Heebo — https://fontsource.org/fonts/heebo/about
- Fontsource, Rubik — https://fontsource.org/fonts/rubik/about
- W3C i18n, Inline bidi markup — https://www.w3.org/International/articles/inline-bidi-markup/
- Google Fonts repository (font files inspected) — https://github.com/google/fonts/tree/main/ofl

## Unverified items (summary)
- Exact layout of Strong, Apple Fitness, NTC and Duolingo lesson-complete screens: not documented in fetched sources. Descriptions are limited to what the sources state.
- Palettes of Strava, WHOOP and Gentler Streak: general knowledge.
- Material 3 easing cubic-bezier values: the page did not render.
- Chrome's user-gesture requirement for `vibrate()`, and whether the iOS switch haptic fires inside an installed home-screen PWA.
- iOS input zoom below 16px.
- RTL chart time-direction convention.
- The e1RM accuracy table comes from a secondary summary of LeSuer 1997 with no sample sizes.
