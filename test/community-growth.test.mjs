import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270001_community_growth.sql", import.meta.url), "utf8");
const lockdownSql = fs.readFileSync(new URL("../supabase/migrations/202608270002_lock_anon_defaults.sql", import.meta.url), "utf8");
const expandSql = fs.readFileSync(new URL("../supabase/migrations/202609080005_community_streaks_function_expand.sql", import.meta.url), "utf8");
const contractSql = fs.readFileSync(new URL("../supabase/migrations/202609150001_community_streaks_view_contract.sql", import.meta.url), "utf8");

test("reactions policies now gate on post_visible_to_viewer, not just row existence", () => {
  assert.match(sql, /create policy reactions_visible on public\.reactions for select to authenticated using \(public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /create policy reactions_insert_self on public\.reactions for insert to authenticated with check \(user_id = auth\.uid\(\) and public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /and \(p\.author_id = auth\.uid\(\) or p\.visibility = 'public' or \(p\.visibility = 'followers'/i);
});

test("workout_posts accepts 'achievement' as a source_type", () => {
  assert.match(sql, /add constraint workout_posts_source_type_check check \(source_type in \('strength_entry', 'wod_entry', 'achievement'\)\)/i);
});

test("announcements are admin-write, all-member-read, and RLS is on", () => {
  assert.match(sql, /alter table public\.announcements enable row level security/i);
  assert.match(sql, /create policy announcements_read on public\.announcements for select to authenticated using \(deleted_at is null\)/i);
  assert.match(sql, /announcements_insert_admin[\s\S]*p\.is_admin/i);
  assert.match(sql, /announcements_update_admin[\s\S]*p\.is_admin/i);
});

test("activity_pings is RLS-enabled and self-scoped only, never widened to authenticated-at-large", () => {
  assert.match(sql, /alter table public\.activity_pings enable row level security/i);
  assert.match(sql, /create policy activity_pings_self_select on public\.activity_pings for select to authenticated using \(user_id = auth\.uid\(\)\)/i);
  assert.match(sql, /create policy activity_pings_self_insert on public\.activity_pings for insert to authenticated with check \(user_id = auth\.uid\(\)\)/i);
});

// 202608270001's view is HISTORY as of 202609150001 — it was dropped to close
// the Supabase Security Advisor's "Security Definer View" finding. This
// assertion is kept because it is a true statement about the text of a
// migration that is immutable by policy, and because the property it pins is
// the reason the replacement had to be a definer FUNCTION rather than a
// `security_invoker = true` view: activity_pings' only policy is
// `user_id = auth.uid()`, so invoker semantics would have silently zeroed
// every member's streak but the caller's own, on a surface where 0 is a
// legitimate value and the breakage would not have looked like breakage.
test("the original community_streaks view was not security_invoker, which is why it could aggregate across everyone's private activity_pings rows", () => {
  const viewStart = sql.indexOf("create or replace view public.community_streaks");
  assert.ok(viewStart > -1);
  const viewBlock = sql.slice(viewStart, sql.indexOf("grant select on public.community_streaks"));
  assert.ok(!/security_invoker/i.test(viewBlock), "this view must run with definer rights to see every user's streak, not just the caller's own");
});

// The pair that keeps the Advisor finding closed. Static text assertions
// only — supabase/tests/0068 and 0093 are where the live-Postgres proof
// lives (the view is gone, the function is still definer, and every privacy
// boundary the view enforced is re-asserted through the function).
test("the expand/contract pair replaced that view with a SECURITY DEFINER function and then actually dropped the view", () => {
  assert.match(expandSql, /create or replace function public\.community_streaks\(p_limit int default 50\)/i);
  assert.match(expandSql, /language plpgsql stable security definer set search_path = ''/i);
  assert.match(expandSql, /revoke all on function public\.community_streaks\(int\) from public, anon/i);
  assert.match(expandSql, /grant execute on function public\.community_streaks\(int\) to authenticated/i);

  assert.match(contractSql, /drop view if exists public\.community_streaks/i);
  // The contract migration must not resurrect what it just dropped — a
  // re-created view is a reopened Advisor finding.
  assert.ok(!/create (or replace )?view public\.community_streaks/i.test(contractSql),
    "the contract migration must not re-create the view it exists to drop");
  // And it re-stamps the function comment so the expand-phase promise
  // ("the view is deliberately left in place") does not outlive the view.
  assert.match(contractSql, /CONTRACT phase complete \(202609150001\)/);
});

test("coach_inactive_members self-gates to admins and is locked away from anon", () => {
  assert.match(sql, /if not exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\) then\s*raise exception/i);
  assert.match(sql, /revoke all on function public\.coach_inactive_members\(date\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.coach_inactive_members\(date\) to authenticated/i);
});

test("weekly_challenges is admin-write, all-member-read, and its leaderboard view reuses post visibility rules", () => {
  assert.match(sql, /alter table public\.weekly_challenges enable row level security/i);
  assert.match(sql, /create policy weekly_challenges_read on public\.weekly_challenges for select to authenticated using \(true\)/i);
  assert.match(sql, /weekly_challenges_insert_admin[\s\S]*p\.is_admin/i);
  assert.match(sql, /create or replace view public\.weekly_challenge_leaderboard with \(security_invoker = true\)/i);
});

// Found by live-testing 202608270001 right after applying it: this
// project auto-grants anon SELECT on any newly created table via a
// leftover default privilege, and 202608270001 never re-revoked it for
// its own new objects the way 202608260001 did for the tables that
// existed when *it* ran — activity_pings, announcements,
// weekly_challenges, and community_streaks were all readable with no
// login at all until this follow-up migration.
test("202608270002 revokes anon's leaked read access on every table/view 202608270001 created, and closes the default for future migrations too", () => {
  assert.match(lockdownSql, /revoke all on public\.activity_pings, public\.announcements, public\.weekly_challenges, public\.community_streaks from anon/i);
  assert.match(lockdownSql, /alter default privileges in schema public revoke select, insert, update, delete on tables from anon, authenticated/i);
});
