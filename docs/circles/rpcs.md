# Circles: the RPC contract

What the database offers the Circles client, as built by migrations
`202610250004` to `202610250006`. [decisions.md](decisions.md) says why; this
file says how to call it. Every function is `SECURITY DEFINER` with
`search_path ''` (except `circle_feed`, which is invoker and limited by RLS),
executable by `authenticated` only, and listed in `tests.definer_reviewed`.
A refusal is `raise exception 'not authorized'` (SQLSTATE P0001) unless
stated; `join_circle` returns a status instead of raising, on purpose.

| Call | Who | Notes |
|---|---|---|
| `create_circle(p_type, p_name, p_emoji)` → uuid | someone who got in by invite (member of a circle, or redeemed the bootstrap code) | type `couple` or `friends`; name 1 to 40; errors `too_many_circles` at 10 |
| `update_circle(p_club_id, p_settings jsonb)` | owner | keys: `name`, `emoji`, `mode`, `benchmark_enabled`, `invite_policy`, `welcome_line`, `benchmark` (one of `fran grace helen diane cindy murph isabel karen`, or null) |
| `leave_circle(p_club_id)` | member | deletes their posts, reactions, tags and benchmark results there; owner leaves, longest-standing member becomes owner; last member leaving deletes the circle |
| `remove_member(p_club_id, p_user_id)` | owner | same clean-up; an owner cannot be removed |
| `create_circle_invite(p_club_id, p_max_uses default null)` → text | per `invite_policy` | the raw 64-hex token, **once**; 7 days; default 1 use (couple) or 5 (friends), max 20; errors `circle_full`, `invite_limit` (20 per circle per day) |
| `join_circle(p_token)` → jsonb | any signed-in user | `{status, club_id?}`; status `joined`, `already_member`, `circle_full`, `too_many_circles`, `rate_limited` (10 per user per hour, every call counts), `invalid` (unknown, expired and used-up look the same). Creates a bare profile for a fresh anonymous account. |
| `redeem_invite_code(p_code, p_actor_key)` → text | any signed-in user | bootstrap of the first circle owner only; grants no circle access |
| `set_share_defaults(p_club_id, p_defaults jsonb)` | member | merged; keys `share_workouts share_prs share_percent share_weekly_count show_weights`, booleans |
| `set_weekly_target(p_target)` / `set_pause(p_until date)` | member | 1 to 21; pause up to 180 days, null resumes; a pause with no target creates target 3 |
| `post_create(p_club_id, body, p_idempotency_key)` | member | text post; one call per circle |
| `pr_share(p_club_id, record_id, note, p_weight, p_idempotency_key)` | member | send `p_weight` **only** if the member chose to show weights; otherwise the post carries the lift and `+x.x%` |
| `ach_share(p_club_id, member_achievement_id, caption, p_idempotency_key)` | member | |
| `toggle_reaction(p_post_id, p_idempotency_key, p_kind default 'cheer')` → bool | member of the post's circle | kinds `cheer` (fist bump) `fire` `strong` `clap` `heart`; at most two kinds besides `cheer` per post (`reaction_limit`) |
| `post_tag_training_partners(p_post_id, p_members)` | post author | creates **pending** tags for members of the post's circle |
| `confirm_trained_together(p_post_id)` | the tagged member | only then does it count in `circle_week` and show on the card |
| `post_training_partner_remove(p_post_id, p_user_id default null)` | author, or the tagged member for themselves | |
| `circle_week(p_club_id)` | member | rows `user_id, display_name, emoji, workouts, target (own row only), percent, paused, weeks_met`; week starts Sunday, Asia/Jerusalem; hidden numbers are null |
| `circle_feed(p_club_id, p_cursor timestamptz, p_limit)` | member | newest first, page of at most 50, pass the last `published_at` as the cursor; `unreacted_pr` flags PRs over a day old nobody else reacted to |
| table `benchmark_results` | member | direct select, insert, update, delete under RLS; insert only for the circle's current benchmark and month; others' rows appear only after you logged your own |

Share-defaults keys, per circle type, at creation: couple shares workouts, PRs,
percent and the weekly count; friends share PRs, percent and the weekly count
(workouts only as a count). `show_weights` is false in both.

## Calls that no longer match what the client sends

For the Circles client session. None of these was edited here.

- `pr_share`, `ach_share`, `post_create`: now take `p_club_id`; `pr_share` and
  `ach_share` lost `media`; `post_create` lost `visibility`, `media`, `links`.
  Sources: `src/community/posts.js` (pr_share), `src/community/achievements.js`
  (ach_share), the `OUTBOX_ACTIONS` queue in `cloud.js`.
- `workout_posts` upserts (`src/community/posts.js:38`,
  `src/community/achievements.js:20`) use `onConflict:
  "author_id,source_type,source_record_id"`. The key is now
  `author_id,club_id,source_type,source_record_id`, and the rows need a `club_id`.
- `toggle_reaction`: still works unchanged; pass `p_kind` for the extra emoji.
- `post_tag_training_partners` now creates pending tags; the client needs a
  confirm button (`confirm_trained_together`) and a tags query.
- `create_member_invite` is gone (replaced by `create_circle_invite`);
  `scripts/seed-local-personas.sql` still calls it and was already stale from
  the strip.
- `is_community_member()` is true for any member of a circle, whatever their
  recovery state; the client's recovery gating is its own.
