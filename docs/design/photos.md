# Scene photos

Status: **no photos are in the repository yet.** The Design session could not fetch any.

## Why

The owner asked for scene photos from Unsplash or Pexels under their free licenses,
downloaded into the repo. The cloud environment that ran the session answers `403` to
`CONNECT` for `unsplash.com`, `images.unsplash.com`, `www.pexels.com` and
`images.pexels.com` (network policy, not a fault of the sites). Nothing was hotlinked, no
third-party request was added to the app, and no photo was drawn or faked to fill the gap.

To unblock it: in the cloud environment's settings (Network access) allow those four hosts,
then ask a session to do step 1 below. Or supply the photos yourself.

## What is ready

Classic draws its header scene from the palette (accent glow, fine diagonal lines, a deep
tone) and lays a photo over it when one is set. Each tab has its own slot:

| Tab      | Scene class            | Photo file (to add)           | Subject to look for                                   |
|----------|------------------------|-------------------------------|--------------------------------------------------------|
| Home     | `.scene-page--home`    | `assets/scenes/home.webp`     | morning light, a path or track at sunrise              |
| Circle   | `.scene-page--community` | `assets/scenes/circle.webp` | chalk, hands only, a rack of barbells                  |
| Log      | `.scene-page--add`     | `assets/scenes/log.webp`      | a loaded barbell on the floor, plates close up          |
| Progress | `.scene-page--progress` | `assets/scenes/progress.webp` | a rower, an outdoor run on a long road, from behind    |

## Steps to add one

1. Download the photo into `assets/scenes/<name>.webp`, compressed to **under 120 KB**
   (about 1200 px wide, WebP quality 70 to 80). Pick photos with **no faces** and **no gym
   name or logo** visible.
2. Record it in the table below: source page URL, author, license, date downloaded.
3. In `index.html`, set `--scene-photo: url("./assets/scenes/<name>.webp")` on that tab's
   `.scene-page--…` rule. The scrim and the sheet already sit over it, and the parallax and
   fade already move it (both are off under `prefers-reduced-motion`).
4. Add the file to `OPTIONAL_ASSETS` in `sw.js`. `test/sw-precache.test.mjs` fails if a
   file referenced from the stylesheet is not precached.

If the owner supplies his own photos they replace these files under the same names.

## Licenses

Unsplash License and Pexels License both allow free use, including commercial use, with no
attribution required, but not reselling the photo unaltered and not implying endorsement.
Attribution is still recorded here.

| File | Source URL | Author | License | Downloaded |
|------|------------|--------|---------|------------|
| _none yet_ | | | | |
