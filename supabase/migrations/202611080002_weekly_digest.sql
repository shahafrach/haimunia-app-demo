-- Weekly progress digest (Home port, feature 2).
--
-- The member picks the day and time (reminder_prefs.digest_*); the switch is the weekly_digest notification
-- preference (off until turned on). Home's daily digest counts rows on the server; here the log is private and
-- on the device, so the push is content-free and the progress screen builds the summary locally.
-- reminder_push_due is the same cron job as the workout reminder, now with the digest loop. FORWARD ONLY.
begin;

alter table public.reminder_prefs
  add column digest_day    smallint not null default 5 check (digest_day between 0 and 6),
  add column digest_hour   smallint not null default 10 check (digest_hour between 0 and 23),
  add column digest_minute smallint not null default 0 check (digest_minute in (0, 15, 30, 45));

create or replace function public.reminder_push_due(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_local timestamp := coalesce(p_now, now()) at time zone 'Asia/Jerusalem';
  v_today date := v_local::date;
  v_dow integer := extract(dow from v_local)::integer;
  v_slot integer := extract(hour from v_local)::integer * 60 + (extract(minute from v_local)::integer / 15) * 15;
  v_sid uuid;
  v_written integer := 0;
  r record;
begin
  for r in
    select rp.user_id
      from public.reminder_prefs rp
      join public.profiles pr on pr.id = rp.user_id and pr.deleted_at is null
     where v_dow = any (rp.workout_days)
       and rp.workout_hour * 60 + rp.workout_minute between v_slot and v_slot + 14
       and public.notif_pref_allows(rp.user_id, 'workout_reminder')
  loop
    v_sid := md5(r.user_id::text || ':workout:' || v_today::text)::uuid;
    if exists (select 1 from public.notifications n
                where n.user_id = r.user_id and n.type = 'workout_reminder' and n.source_id = v_sid) then
      continue;
    end if;
    insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
    values (r.user_id, 'workout_reminder', 'training', 'זמן לאימון',
            'הגיע הזמן שבחרתם לאימון. נתראה בסט הראשון.', 'reminder', v_sid, '/tab/add');
    v_written := v_written + 1;
  end loop;

  -- The weekly summary: one push on the day and time the member chose. The numbers are computed on the
  -- device when the screen opens (the training log never reaches the server), so the text has none.
  for r in
    select rp.user_id
      from public.reminder_prefs rp
      join public.profiles pr on pr.id = rp.user_id and pr.deleted_at is null
     where rp.digest_day = v_dow
       and rp.digest_hour * 60 + rp.digest_minute between v_slot and v_slot + 14
       and public.notif_pref_allows(rp.user_id, 'weekly_digest')
  loop
    v_sid := md5(r.user_id::text || ':digest:' || v_today::text)::uuid;
    if exists (select 1 from public.notifications n
                where n.user_id = r.user_id and n.type = 'weekly_digest' and n.source_id = v_sid) then
      continue;
    end if;
    insert into public.notifications (user_id, type, category, title, body, source_type, source_id, deep_link)
    values (r.user_id, 'weekly_digest', 'training', 'הסיכום השבועי שלך מוכן',
            'ראו מה השגתם השבוע. נגיעה אחת פותחת.', 'reminder', v_sid, '/tab/history');
    v_written := v_written + 1;
  end loop;
  return v_written;
end $$;
revoke all on function public.reminder_push_due(timestamptz) from public, anon, authenticated;
grant execute on function public.reminder_push_due(timestamptz) to service_role;

commit;
