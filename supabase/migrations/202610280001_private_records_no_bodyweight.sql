-- Body weight never leaves the device (decisions.md, 2026-10-28).
--
-- The client no longer queues, uploads or restores 'bodyweight' records. This
-- is the server half: delete every bodyweight row an earlier build uploaded,
-- and tighten the CHECK so the type cannot be inserted again, by any caller.
--
-- FORWARD ONLY. The original CHECK (202608260001) is replaced here, not edited.
-- Measurements ('measure_type', 'measurement') stay in the private backup.
begin;

delete from public.private_records where record_type = 'bodyweight';

alter table public.private_records
  drop constraint private_records_record_type_check;

alter table public.private_records
  add constraint private_records_record_type_check
  check (record_type in ('movement','custom_wod','strength_entry','wod_entry','measure_type','measurement','session_note'));

commit;
