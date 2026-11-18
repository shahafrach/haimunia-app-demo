// Q-38d/e (202611180003): the purge deletes exactly what delete_my_account deletes, through ONE body
// (delete_account_now). Behaviour is pinned in pgTAP 0162 (CI); this pins the shape so a second copy of the
// deletion cannot grow back (sibling drift).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const sql = fs.readFileSync(new URL("202611180003_purge_abandoned_club_accounts.sql", dir), "utf8");
const body = (name) => {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n(?:end \\$\\$|\\$\\$);`));
  assert.ok(m, name);
  return m[0];
};

test("one deletion body: delete_my_account keeps its checks and calls delete_account_now; so does the purge", () => {
  const mine = body("delete_my_account");
  assert.match(mine, /if not public\.aal_satisfied\(\) then raise exception 'not authorized'/);
  assert.match(mine, /check_rate_limit\('delete_my_account', 3, 60\)/);
  assert.match(mine, /perform public\.delete_account_now\(v_uid\);/);
  assert.doesNotMatch(mine, /delete from /, "no deletion of its own");
  assert.match(body("purge_abandoned_club_accounts"), /perform public\.delete_account_now\(v_id\);/);
  assert.equal((sql.match(/delete from auth\.users/g) || []).length, 1, "the auth user is deleted in one place");
  const now = body("delete_account_now");
  for (const t of ["circle_members", "workout_posts", "reactions", "post_training_partners", "push_subscriptions", "notifications", "profiles"]) {
    assert.match(now, new RegExp(`delete from public\\.${t}\\b`), t);
  }
});

test("365 days, every kind of activity, data-holding accounts kept, granted to no role", () => {
  assert.match(sql, /cron\.schedule\('purge-abandoned-club-accounts', '41 4 \* \* \*', \$\$select public\.purge_abandoned_club_accounts\(365\)\$\$\)/);
  const act = body("account_last_activity");
  for (const src of ["u.last_sign_in_at", "auth.sessions", "s.refreshed_at", "auth.refresh_tokens", "public.workout_posts", "public.reactions"]) assert.ok(act.includes(src), src);
  const purge = body("purge_abandoned_club_accounts");
  assert.match(purge, /greatest\(coalesce\(p_days, 365\), 90\)/, "never under 90 days");
  assert.match(purge, /not coalesce\(u\.is_anonymous, false\)/);
  assert.match(purge, /exists \(select 1 from public\.circle_members m where m\.user_id = u\.id\)/);
  assert.match(purge, /if public\.account_holds_training_data\(v_id\) then v_kept/);
  for (const f of ["delete_account_now\\(uuid\\)", "account_last_activity\\(uuid\\)", "purge_abandoned_club_accounts\\(integer\\)"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${f} from public, anon, authenticated, service_role;`), f);
  }
  assert.doesNotMatch(sql, /\bgrant execute\b/i, "nothing new is granted");
});
