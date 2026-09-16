-- A stale write never wins (2026-09-16). Round 10 of the bug hunt, data pass.
--
-- THE BUG, reproduced live: a member deleted a logged set on one device and it
-- came back. Not "failed to delete" — deleted, synced, gone, and then present
-- again days later with older numbers in it.
--
-- WHY. flushOutbox() pushes with a bare upsert:
--   .upsert(payload, { onConflict: "user_id,record_type,record_id" })
-- so the row is simply whatever push physically landed last. Two things follow.
-- First, a device holding a long-stale queued edit for a record another device
-- has since DELETED pushes `deleted_at: null` and un-deletes it. Second, and
-- quieter, an older edit's content overwrites a newer edit's, so the cloud copy
-- (and therefore every new device and every restore) adopts the wrong number
-- permanently, with nothing surfaced anywhere.
--
-- WHY updated_at CANNOT ARBITRATE THIS. The client does send a real
-- modification time (updated_at = the outbox row's queuedAt), but
-- private_records_touch (202608260001) is a BEFORE UPDATE trigger running
-- `new.updated_at = now()`, so on the update path the client's value is
-- discarded before it is ever stored. That is correct and necessary for its
-- actual job — the pull cursor pages on updated_at and needs a server-monotonic
-- clock, not a fleet of unsynchronised device clocks — but it does mean the row
-- itself remembers only WHEN A WRITE ARRIVED, never when the member made it.
-- So the arbitration here reads the device-authored stamp out of the payload:
-- updatedAt (added to strength and WOD entries the same day as this migration,
-- because their ts is frozen at creation to keep History in order), falling
-- back to ts for bodyweight and measurements, which restamp ts on every save.
--
-- DELIBERATELY CONSERVATIVE: this only ever blocks a write it can PROVE is
-- stale. A payload carrying no device stamp at all (movements, custom WODs) is
-- passed through exactly as before rather than guessed about. The goal is to
-- stop provable data loss, not to become a new way to lose a write.
--
-- A blocked write returns NULL, so the UPDATE is skipped silently and the
-- pushing client sees no error. That is the intended contract: the client's own
-- copy is the loser of the comparison, there is nothing for it to repair, and
-- the next pull will bring it the winning row.

-- Pure, no data access: pulls the device-authored modification time (epoch ms)
-- out of a payload, or NULL when the record carries no stamp to judge by. The
-- regex guard is what makes it safe on hand-edited or imported JSON — a
-- ::numeric cast on arbitrary text would raise and take the member's whole sync
-- down with it.
create or replace function public.pr_payload_mod_ms(p jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select nullif(
    coalesce(
      case when p->>'updatedAt' ~ '^[0-9]{1,17}$' then (p->>'updatedAt')::numeric end,
      case when p->>'ts'        ~ '^[0-9]{1,17}$' then (p->>'ts')::numeric end
    ), 0);
$$;
comment on function public.pr_payload_mod_ms(jsonb) is
  'The device-authored modification time (epoch ms) inside a private_records payload: updatedAt, else ts, else NULL (202609160001). NULL means "this record carries no stamp to judge recency by" and callers must treat it as unknown, never as zero.';

create or replace function public.private_records_reject_stale_write() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_new_ms numeric := public.pr_payload_mod_ms(new.payload);
  v_old_ms numeric := public.pr_payload_mod_ms(old.payload);
begin
  -- 1. Resurrection. The row is a tombstone and this write would un-delete it.
  --    Allowed only when the write can prove it is NEWER than the deletion:
  --    that is a genuine "edited after the delete" and should win. Anything
  --    older is the stale-queued-edit case and is dropped.
  if old.deleted_at is not null and new.deleted_at is null then
    if v_new_ms is not null and to_timestamp(v_new_ms / 1000.0) <= old.deleted_at then
      return null;
    end if;
  end if;

  -- 2. A stale DELETE must not destroy a newer edit. The mirror of case 1, and
  --    the most damaging of the three, because unlike a resurrection there is
  --    no copy of the data left anywhere once it lands.
  if new.deleted_at is not null and old.deleted_at is null
     and v_old_ms is not null
     and new.deleted_at < to_timestamp(v_old_ms / 1000.0) then
    return null;
  end if;

  -- 3. Stale content. Both sides live, both stamped, and this write is older
  --    than what is already stored: last-arrived becomes newest-authored.
  if new.deleted_at is null and old.deleted_at is null
     and v_new_ms is not null and v_old_ms is not null
     and v_new_ms < v_old_ms then
    return null;
  end if;

  return new;
end $$;
comment on function public.private_records_reject_stale_write() is
  'BEFORE UPDATE ON public.private_records, FOR EACH ROW (202609160001). Drops a write that is provably older than the row it would replace, in all three directions: un-deleting a tombstone with a pre-deletion edit, deleting a row that has been edited since, and overwriting newer content with older. Judges recency by pr_payload_mod_ms() on the payload, NOT by updated_at, which private_records_touch() overwrites with now() on every update. Unstamped payloads pass through unchanged. Returns NULL to skip the UPDATE silently.';

-- Fires before private_records_touch (alphabetical: r < t), so a dropped write
-- never reaches the touch trigger and the row keeps the updated_at it had.
drop trigger if exists private_records_reject_stale_write on public.private_records;
create trigger private_records_reject_stale_write
  before update on public.private_records
  for each row
  execute function public.private_records_reject_stale_write();
