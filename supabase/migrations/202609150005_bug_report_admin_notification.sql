-- Tell the admin when a bug report arrives (2026-09-15), at the owner's
-- request after using the inbox for the first time.
--
-- THE PROBLEM THIS SOLVES, reported directly: the inbox only showed anything
-- after tapping "טעינת דיווחים", and even loaded it only tells you what is
-- there if you have already decided to go and look. A queue nobody is told
-- about is a queue nobody reads, and a bug-report channel that nobody reads
-- is worse than none - it collects the member's effort and returns silence.
-- The client half of the fix makes the inbox load itself; this is the half
-- that reaches the admin when they are not on that screen.
--
-- ADMINS ONLY, deliberately, and not the same audience as the moderation
-- alert beside it. mod_alert_recipients() notifies everyone who can action
-- the moderation queue, which includes coaches. A bug report is not a
-- moderation matter: closing one is is_admin() gated (202609150002), and
-- since the panel split the app itself is the admin's job while the club is
-- the head coach's. Notifying a head coach about something only an admin can
-- action would be an interruption they cannot act on.

create or replace function public.bug_report_alert_recipients()
returns setof uuid
language sql stable security definer set search_path = '' as $$
  -- Resolved the same way mod_alert_recipients() does it, because there is no
  -- "role of an arbitrary member" helper - my_role_code() answers only for the
  -- CALLER, and this runs inside a trigger on somebody else's insert. So the
  -- two sources of admin-ness are checked directly: the legacy profiles.is_admin
  -- flag, and a redeemed role whose rank clears 50 (admin/owner), which is
  -- exactly is_admin()'s own definition expressed over the roster.
  --
  -- Kept as its own function rather than parameterising mod_alert_recipients(),
  -- so a future change to who moderates cannot silently change who hears
  -- about bugs. They are different questions with different answers.
  select p.id
  from public.profiles p
  where p.deleted_at is null
    and (
      p.is_admin
      or exists (
        select 1 from public.invite_redemptions ir
        where ir.user_id = p.id
          and coalesce(public.role_rank(ir.role) >= 50, false)
      )
    )
  order by p.id;
$$;
revoke all on function public.bug_report_alert_recipients() from public, anon, authenticated;
comment on function public.bug_report_alert_recipients() is
  'Every admin/owner (role_rank >= 50) eligible to hear about a new bug report (202609150005). Deliberately NOT mod_alert_recipients(), which includes coaches: closing a bug report is is_admin() gated, so alerting anyone who cannot action it is an interruption without a remedy.';

create or replace function public.notif_on_bug_report() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v_who text;
begin
  -- The reporter's club name is not used: there is one club, and the useful
  -- fact in the notification line is WHO reported, so the admin can judge
  -- urgency before opening anything.
  select coalesce(pr.display_name, pr.handle, 'חבר/ה') into v_who
  from public.profiles pr where pr.id = new.reporter_id;

  for v_admin in select * from public.bug_report_alert_recipients() loop
    perform public.notif_create(
      v_admin, 'new_bug_report', 'community',
      'דיווח תקלה חדש',
      coalesce(v_who, 'חבר/ה') || ' דיווח/ה על תקלה',
      -- source_type/source_id are the client's documented fallback when a
      -- deep link cannot be parsed. 'bug_report' matches the target_type this
      -- schema already uses for the audit row on the same object.
      'bug_report', new.id, '/community/manage?area=bugs'
    );
  end loop;
  return null;
end $$;
revoke all on function public.notif_on_bug_report() from public, anon, authenticated;
comment on function public.notif_on_bug_report() is
  'AFTER INSERT ON public.bug_reports, FOR EACH ROW (202609150005). Notifies every bug_report_alert_recipients() admin with a ''new_bug_report'' notification (category ''community'') through notif_create(), which applies the self-notify, block-edge, preference and de-dupe filters unchanged - so an admin filing their own bug report is not notified about it, and ten reports in an hour collapse rather than becoming ten alerts. Deep link /community/manage?area=bugs opens the admin panel''s inbox. Returns NULL (AFTER trigger). Writes nothing but notifications.';

drop trigger if exists notif_bug_report_after_insert on public.bug_reports;
create trigger notif_bug_report_after_insert
  after insert on public.bug_reports
  for each row
  execute function public.notif_on_bug_report();
