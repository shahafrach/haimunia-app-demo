# Scene photos

Status: **four photos are in the repository** (2026-10-29), one per tab. The Design session could not fetch them; they were added from a session whose network policy allowed `images.unsplash.com`.

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
| `assets/scenes/home.webp` | https://images.unsplash.com/photo-1476480862126-209bfaa8edc8 | not recorded (unsplash.com page lookup was blocked) | Unsplash License | 2026-10-29 |
| `assets/scenes/circle.webp` | https://images.unsplash.com/photo-1583454110551-21f2fa2afe61 | not recorded | Unsplash License | 2026-10-29 |
| `assets/scenes/log.webp` | https://images.unsplash.com/photo-1517963879433-6ad2b056d712 | not recorded | Unsplash License | 2026-10-29 |
| `assets/scenes/progress.webp` | https://images.unsplash.com/photo-1552674605-db6ffd4facb5 | not recorded | Unsplash License | 2026-10-29 |

All four are free Unsplash photos (served from images.unsplash.com, not plus.unsplash.com). Checked by eye: no faces (the runners are backlit silhouettes), no gym name or logo. Home: running up stone stairs. Circle: hands on a dumbbell rack. Log: a deadlift from above. Progress: three runners at sunrise. Sizes: 114, 38, 101 and 34 KB.
