-- Blocking someone should end the following relationship in BOTH directions.
--
-- Live bug hunt, fresh round 5 (2026-09-15). An agent hunting privacy flagged
-- this and was careful not to claim it: the browser mock has no
-- community_profile stand-in, so it could not be reproduced live. Confirmed
-- afterwards by reading the deployed SQL instead.
--
-- WHAT IS ACTUALLY WRONG. cloud.js's block() deletes my follow of the person
-- I blocked, and stops there - it has no choice, because follows_delete_self
-- (202608260001) only permits deleting a row whose follower_id is my own.
-- Their follow of ME survives, and nothing on the server cleaned it up.
--
-- The visible consequence is a count that disagrees with its own list.
-- community_profile's follower_count is a plain `count(*) from follows` inside
-- a SECURITY DEFINER function, so it counts that surviving row; the follower
-- LIST beside it is resolved through public.profiles under RLS, whose block
-- predicate is bidirectional, so the blocked member is absent from the names.
-- "עוקבים (3)" expanding to two people.
--
-- WHAT IS NOT WRONG, and is worth stating so nobody "fixes" it twice: there is
-- no privacy hole here. Every block predicate in this schema tests both
-- directions - `(blocker_id = auth.uid() and blocked_id = id) or (blocker_id =
-- id and blocked_id = auth.uid())` - so a blocked member reads nothing of mine
-- whether or not a stale follow row exists. The row is bookkeeping that
-- outlived its meaning, not access.
--
-- FIXED AT THE CAUSE. Filtering the two counts would hide the symptom and
-- leave the row for the next surface to trip over. A block already means "no
-- relationship", and the client already deletes the half it is allowed to, so
-- this simply completes the same intent on the side the client cannot reach.
-- Runs as the table owner, which is why it can delete a row the blocker has no
-- direct DELETE permission on.
create or replace function public.blocks_clear_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.follows f
   where (f.follower_id = new.blocker_id and f.followed_id = new.blocked_id)
      or (f.follower_id = new.blocked_id and f.followed_id = new.blocker_id);
  return null;
end $$;
revoke all on function public.blocks_clear_follows() from public, anon, authenticated;
comment on function public.blocks_clear_follows() is
  'AFTER INSERT ON public.blocks, FOR EACH ROW (202609150012). Deletes any follow edge between the two members in EITHER direction. cloud.js''s block() already removes the blocker''s own follow - follows_delete_self permits only that one - and this removes the reverse, which no client can. Without it community_profile''s follower_count (an unfiltered count(*)) disagreed with the follower list beside it, which RLS block-filters bidirectionally. Not a privacy fix: every block predicate in this schema is already bidirectional, so a stale row granted no access. Returns NULL (AFTER trigger).';

drop trigger if exists blocks_clear_follows_after_insert on public.blocks;
create trigger blocks_clear_follows_after_insert
  after insert on public.blocks
  for each row
  execute function public.blocks_clear_follows();

-- Existing rows: the same cleanup, once, for blocks already in place.
delete from public.follows f
 using public.blocks b
 where (f.follower_id = b.blocker_id and f.followed_id = b.blocked_id)
    or (f.follower_id = b.blocked_id and f.followed_id = b.blocker_id);
