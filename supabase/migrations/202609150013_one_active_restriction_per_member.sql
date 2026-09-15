-- A member can be restricted twice over, and lifting it once does nothing.
--
-- Live bug hunt, fresh round 6 (2026-09-15) - HIGH, reproduced live in a real
-- browser against the real function shapes.
--
-- HOW IT HAPPENS, through ordinary use rather than a race. A report is
-- actioned with a temporary restriction. Someone files a SECOND report about
-- the same member - report()'s own re-open path flips a resolved report back
-- to 'open' whenever a fresh complaint arrives - and a moderator actions that
-- one too, this time permanently. mod_restrict_member() INSERTs
-- unconditionally, so the member now carries two simultaneous active
-- restrictions.
--
-- The panel then renders two "ביטול ההגבלה" buttons for one person, with
-- nothing to say they are the same member's duplicate rows. The moderator
-- lifts one, the toast says the restriction was lifted, the list reloads -
-- and the member is STILL BLOCKED FROM POSTING, because
-- is_posting_restricted() only needs one live row. A moderator who believes
-- they have cleared a sanction, and a member who cannot post and has been
-- told they are no longer restricted, is a worse outcome than the original
-- sanction being slightly wrong.
--
-- SUPERSEDE, RATHER THAN REFUSE OR DEDUPE. Three options were available:
--
--   Refuse the second restriction. Wrong: escalating a temporary restriction
--     to a permanent one is a legitimate and expected moderator action, and
--     refusing it would leave the weaker sanction standing.
--   A partial unique index on (user_id) where lifted_at is null. Wrong: an
--     EXPIRED temporary row is un-lifted but no longer in force, and the index
--     would block a new restriction on a member whose old one simply ran out.
--     The "is it active" test involves now(), which cannot live in an index.
--   Lift the existing one as part of imposing the new one. Correct: it states
--     what actually happened - this sanction replaced that one - keeps exactly
--     one active row per member by construction, and leaves the superseded row
--     in place with its own audit trail rather than deleting history.
--
-- The supersede is attributed to the moderator performing the new action and
-- carries a reason naming it as such, so the audit log reads as the sequence
-- of decisions it was, not as an unexplained lift.
create or replace function public.mod_restrict_member(
  p_user uuid,
  p_type text,
  p_expires_at timestamptz default null,
  p_reason text default '',
  p_report_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_id uuid;
  v_expires timestamptz;
  v_superseded integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.member.restrict') then raise exception 'not authorized'; end if;
  if p_user is null then raise exception 'target member required'; end if;
  if p_user = v_uid then raise exception 'cannot restrict yourself'; end if;
  if p_type not in ('temporary', 'permanent') then
    raise exception 'unknown restriction type %', p_type;
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then
    raise exception 'member not found';
  end if;

  v_expires := case when p_type = 'temporary' then p_expires_at else null end;
  if p_type = 'temporary' and (v_expires is null or v_expires <= now()) then
    raise exception 'a temporary restriction needs an end time in the future';
  end if;

  -- Anything still in force on this member is replaced by what follows.
  -- Same "active" test is_posting_restricted() uses: not lifted, and either
  -- permanent or not yet expired.
  update public.posting_restrictions
     set lifted_at = now(),
         lifted_by = v_uid,
         lift_reason = 'הוחלפה בהגבלה חדשה'
   where user_id = p_user
     and lifted_at is null
     and (expires_at is null or expires_at > now());
  get diagnostics v_superseded = row_count;

  insert into public.posting_restrictions
    (user_id, restriction_type, expires_at, reason, moderator_id, source_report_id)
  values
    (p_user, p_type, v_expires, left(coalesce(p_reason, ''), 500), v_uid, p_report_id)
  returning id into v_id;

  perform public.log_admin_action(
    'member_restrict', 'member', p_user, null,
    jsonb_build_object(
      'restriction_id', v_id,
      'restriction_type', p_type,
      'expires_at', v_expires,
      'reason', left(coalesce(p_reason, ''), 500),
      'source_report_id', p_report_id,
      'superseded_count', v_superseded
    ),
    p_type, p_reason, p_user
  );
  return v_id;
end $$;
revoke all on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) from public, anon;
grant execute on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) to authenticated;

comment on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) is
  'Imposes a posting restriction, and LIFTS any restriction already in force on that member first (202609150013), so a member can never carry two at once. Before that change a second report on an already-actioned member produced two simultaneous active rows, two identical lift buttons in the panel, and a lift that left the member still blocked - is_posting_restricted() needs only one live row. The supersede is attributed to the moderator imposing the new restriction and reasoned ''הוחלפה בהגבלה חדשה'', so the audit log reads as the sequence of decisions it was; after_data carries superseded_count. AUTH: security definer, has_perm(''community.member.restrict''); refuses self-target, an unknown type, a missing member, and a temporary restriction with no future end time.';

-- Existing duplicates: keep the most recently created active restriction per
-- member and lift the rest, so the invariant holds from here rather than only
-- for restrictions imposed after this migration.
with ranked as (
  select id, row_number() over (partition by user_id order by created_at desc, id desc) as rn
  from public.posting_restrictions
  where lifted_at is null and (expires_at is null or expires_at > now())
)
update public.posting_restrictions r
   set lifted_at = now(), lift_reason = 'ניקוי כפילויות'
  from ranked
 where r.id = ranked.id and ranked.rn > 1;
