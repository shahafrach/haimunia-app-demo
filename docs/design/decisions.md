# Design decisions

Recorded 2026-10-25 by the owner, after the research in [research.md](research.md).
The Design session reads this file and research.md first. These decisions win
over the research recommendations where they differ.

## Goal

One complete design system for BOX-LOG. One source of design tokens, used by
every screen. The app is the natural end of a workout: the member opens it,
logs, sees what they achieved and how far they progressed, and leaves pleased.

## Decisions

- **Themes:** four palettes, chosen by the member in Settings. Palette A
  "Chalk and Brass" and palette B "Slate and Ember" from research.md, plus two
  more designed in the Design session. Every palette has light and dark and
  meets WCAG 2.2 contrast in both. Color is never the only signal (PRs get a
  shape and a label).
- **Transparency:** a Settings control for surface transparency (translucent
  cards and bars with backdrop blur). It respects prefers-reduced-transparency
  and falls back to solid surfaces where backdrop-filter is unsupported or the
  member turns it off.
- **Tokens:** one token source. Primitive, semantic and component layers.
  light-dark() and color-mix() on a single :root block, with data-theme and
  data-palette attributes switching color-scheme and palette. No duplicated
  per-theme color blocks.
- **Font:** Heebo only. Tabular digits for weights, reps and times. Numbers and
  units wrapped in bdi inside Hebrew text.
- **Structure:** four tabs: Home, Circle, a center Log button, Progress. "Me"
  (profile, settings, appearance) opens from the avatar on Home.
- **Charts:** time axes run right to left, matching Hebrew reading order.
- **Older devices:** browsers without light-dark() (iOS Safari below 17.5) get
  the light theme only, with a working fallback.
- **Celebration:** three levels per research.md (quiet check, PR card, short
  burst for a met week or benchmark PR). All motion off under
  prefers-reduced-motion. No haptics on iOS.
- **Already settled elsewhere:** the week starts Sunday, Asia/Jerusalem. The
  circle sees the lift and percent improvement, not the absolute weight,
  unless the member chose to show it. Rx and scaled are separate lists.

## Owner decisions, 2026-10-28

These came after the list above and win over it and over research.md.

- **Five palettes, not four.** The member picks one in Settings, Appearance; each has
  light and dark. 1 Chalk and Brass and 2 Slate and Ember come from research.md
  with its corrected text colors (brass text `#87590B`, ember fill `#C2410C`);
  their dark modes are defined in the token block. 3 Cedar and Fog, 4 Sand and
  Horizon and 5 Ivory and Iris use the owner's values. Cedar's light muted
  (`#5A6A60`, 4.52:1 on surface) is darkened for headroom. In four of the five,
  accent and PR have nearly equal lightness, so a PR always carries a shape and
  a label, never color alone.
- **Transparency:** a Settings switch for translucent cards and bars with
  backdrop blur. Off by default; forced off under `prefers-reduced-transparency`
  and solid where `backdrop-filter` is unsupported.
- **Font:** Heebo only, self-hosted variable woff2 (Hebrew and Latin subsets),
  no Google Fonts request and no third-party origin. Tabular digits for weights,
  reps and times; numbers and units sit in `bdi`.
- **Tabs:** Home, Circle, a raised center Log button, Progress. Me opens from
  the avatar on Home.
- **Charts:** time axes run right to left.
- **Older browsers:** no `light-dark()` means the light theme only, through an
  `@supports not` block whose values a test keeps equal to the light halves.
- **Logging friction** is the biggest complaint users of other apps report, so
  taps to log one set are measured before and after and reduced.
- **Storage:** palette, theme and transparency live in `localStorage` on the
  device (keys `haimunia-demo:palette`, `:theme`, `:transparency`), because
  `theme-init.js` must read them before first paint. They never sync.
- **Token source:** one `<style id="tokens">` block in `index.html`: primitives
  (`--p-*`), semantic (`--color-*`, `--space-*`, `--radius-*`, `--text-*`,
  `--motion-*`) and component (`--btn-*`, `--card-*`, `--ring-*`, `--tab-*`).
  Every color literal lives there and nowhere else; `test/design-tokens-guard.test.mjs`
  enforces it and `test/design-contrast.test.mjs` computes WCAG 2.2 AA ratios
  for every palette in both modes.

## Owner decisions, 2026-10-28 (after the preview)

- **Classic is the default palette.** Dark navy scene with depth and warm coral, taken from
  the app before the Rebrand (`c5855d3`): navy `#152342`, surface `#1F3057`, coral
  `#E85D3D` with text coral `#FF7F53`, brass `#E8B98A` for PRs; light is `#F2F5FA` and white
  with coral text `#AD4023`. It is the only palette with a scene (tall header image,
  scrim, rounded sheet); the five calm palettes stay as options. The default theme is dark,
  the look the app always opened in; "follow the system" is one tap away.
- **Each tab has its own scene** (Home, Circle, Log, Progress), drawn from the palette until
  photos exist, moving slowly on scroll (parallax and a fade), still under
  `prefers-reduced-motion`. Photos: see [photos.md](photos.md).
- **The PR moment is warm and bright**: a gold-and-coral card, a gold check, a pulse on the
  badge, an exclamation in the headline. The three levels are unchanged.
- **Bottom bar:** a tap on a tab is never lost to a re-render (the bar is rewritten only when
  its markup changes).
