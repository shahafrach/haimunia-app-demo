-- Founder link (202610290002): any member can send a friend a "start your own
-- circle" link. Owner decision 2026-10-29: no open sign-up.
--
-- create_founder_invite() mints a row in invite_codes, the same bootstrap path
-- bootstrap_owner_invite() (202610290001) uses and redeem_invite_code() already
-- spends. There is no second redemption path: the friend's token is redeemed by
-- redeem_invite_code(), which writes one invite_redemptions row, and that row is
-- what create_circle() accepts from a person who is in no circle yet.
--
-- What the token grants: the right to sign up and create circles. It joins no
-- circle and reads nothing; is_community_member() ignores the redemption row, so
-- the friend sees none of the sender's data, and the sender is not recorded on
-- the code (invite_codes has no column for it, and none is added), so the sender
-- sees nothing of what the friend builds either.
--
-- Differences from the owner bootstrap: callable by a signed-up member (not
-- anonymous, with a profile), 7 days instead of 1 hour, and at most 3 per member
-- per day through rate_limits. One use, only the sha256 stored, token after #.
--
-- FORWARD ONLY.

create or replace function public.create_founder_invite()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = 'P0001'; end if;
  -- A signed-up member with a profile, in a circle or not. An anonymous session
  -- (mid sign-up) is not one.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.deleted_at is null) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;

  -- check_rate_limit RETURNS false when over the limit; it does not raise.
  if not public.check_rate_limit('founder_invite', 3, 1440) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invite_codes (code_hash, role, active, expires_at, max_uses)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), 'member', true,
          now() + interval '7 days', 1);
  return 'https://box-log.pages.dev/#invite=' || v_token;
end $$;

revoke all on function public.create_founder_invite() from public, anon;
grant execute on function public.create_founder_invite() to authenticated;

comment on function public.create_founder_invite() is
  'Founder link (202610290002). A signed-up member with a profile mints a one-use, 7-day invite_codes row and gets the full invite URL, token after #, once. Only the sha256 is stored; the sender is not recorded. 3 per member per day (rate_limits). Redeeming it (redeem_invite_code) lets the friend sign up and create their own circle and grants nothing else: no membership, no read of the sender''s data. Raises ''not authorized'' and ''rate_limited'', both P0001.';
