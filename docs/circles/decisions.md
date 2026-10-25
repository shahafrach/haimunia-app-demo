# Circles: decisions

Recorded 2026-10-02. These are settled. They are written down so later sessions
build on them and do not reopen them. Open questions live in
[audit.md](audit.md) section 6, not here.

Goal: turn the single-gym community app into a public app where users create
small private circles (a couple, a group of friends). A user can belong to
several circles. Members of a circle see each other's shared activity. Nobody
sees anyone outside their circles. No staff, coaches, gym display or Arbox.

## Decisions

| # | Decision |
|---|---|
| 1 | **A circle is a `clubs` row.** Membership moves to `circle_members(club_id, user_id, role, joined_at)`, `role` is `owner` or `member`. A user can be in several circles. |
| 2 | **A post belongs to exactly one circle.** Sharing a log entry to several circles creates a separate post per circle, each with its own comments and reactions. |
| 3 | **No public visibility at all.** `follows` is dropped. |
| 4 | **Sign-up uses a real email through Supabase Auth.** |
| 5 | **An invite means "join this circle":** a link carrying a token and an expiry. |
| 6 | **Order of work:** strip gym-only code first, then a pgTAP guard over every SECURITY DEFINER function, then circles schema and RLS. |

## Corrections to the first audit

| # | Correction |
|---|---|
| A | The community app has no real users, only test accounts. Real members use only the standalone app, which writes to `training_log_usage`. That table is **keep as is**. |
| B | This repository and this Supabase project are reused. No fresh project. |

## Consequences already visible (details in audit.md)

- Decisions 1 and 2 reuse the existing `club_id` columns (about 36 tables) instead of parallel circle tables.
- Decision 3 removes the `public`, `club`, `followers` and `friends` values of `post_visibility`, `are_friends()`, `relationship_score()` and every follow-based branch.
- Decision 4 reverses the synthetic-address rule in CLAUDE.md and the "Confirm email OFF, never configure SMTP" rule in COMMUNITY_SETUP.md.
- Decision 6 means `is_staff()`, `is_admin()` and `has_perm()` survive the strip as constant-false stubs and are deleted in the schema session. The reason is in audit.md section 5.
- Correction A means `CLAUDE.md` is wrong where it says the repository ships to real members.
