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
