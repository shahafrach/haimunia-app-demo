import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270005_coach_tier.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("cloud.js's isStaff() matches is_staff()'s server-side rule: admin OR a coach-rank redemption", () => {
  // COMM-156 exposed head_coach, which is coach rank or above server-side,
  // so isStaff() recognises it too.
  // Two subjects since management became a separate identity (2026-09-15):
  // inside a management panel isStaff() answers about the account that signed
  // into the gate; everywhere else it answers about the member, by the same
  // rule as before - is_admin OR a coach-rank redemption.
  assert.match(cloudJs, /function isStaff\(\) \{\s*if \(inMgmtContext\(\)\) return mgmtIsStaff\(\);/);
  assert.match(cloudJs, /return !!\(state\.profile && \(state\.profile\.is_admin \|\| \(state\.redemption && \(state\.redemption\.role === "coach" \|\| state\.redemption\.role === "head_coach"\)\)\)\);/);
});

test("all three staff-only render gates (announcements composer, challenge setter, the Account tab's staff area) use isStaff(), not a raw is_admin check", () => {
  const renderFn = cloudJs.slice(cloudJs.indexOf("window.renderCommunityApp = function"), cloudJs.indexOf("window.cloudStorageStatusText"));
  assert.doesNotMatch(renderFn, /state\.profile\.is_admin/, "the render function must not check is_admin directly anymore, only through isStaff()");
  assert.match(renderFn, /const staff = isStaff\(\);/);
  const staffGates = (renderFn.match(/\bstaff \?/g) || []).length;
  // WAS FIVE, and is three because three of them became one thing rather than
  // because any of them was dropped. The Account tab's new-members list, its
  // not-logged-in-recently list and the pointer to where the rest of the
  // management tools live were three separate `staff ? ... : ""` slices of
  // this function, rendering as three unlabelled sections among the member's
  // own settings; they are now one `staffArea` slice holding all three under
  // one labelled staff heading. The gate count moves with the grouping - what
  // this test is really pinning is that every one of them goes through
  // isStaff(), which is unchanged.
  assert.equal(staffGates, 3, "expected exactly 3 staff-gated sections: announcements composer, challenge setter, the grouped Account-tab staff area");
  // And the staff area really is all three: the two lists and the pointer.
  assert.match(renderFn, /const staffArea = staff \?/);
  assert.match(renderFn, /renderCoachNewMembersSection\(\)\}\$\{renderCoachAppActivitySection\(\)/);
});

test("the Account tab's pointer names management destinations that actually exist, and does not send a coach to the bottom bar", () => {
  // The regression this pins is a live one, found on a phone at 390px: the
  // note read `כלי ניהול עברו ל"ניהול" בתפריט התחתון` and there has been no
  // "ניהול" in the bottom bar since the 2026-09-15 split. getNavItems() pushes
  // "ניהול המועדון" and "ניהול מערכת" with main:false, and main:false is
  // exactly what keeps a row OUT of the bottom bar (renderBottomTabBar filters
  // on item.main) and in the header's ☰ menu.
  const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const renderFn = cloudJs.slice(cloudJs.indexOf("window.renderCommunityApp = function"), cloudJs.indexOf("window.cloudStorageStatusText"));
  assert.doesNotMatch(renderFn, /בתפריט התחתון/, "the bottom bar is not where the management tools are");
  for (const label of ["ניהול המועדון", "ניהול מערכת"]) {
    assert.ok(renderFn.includes(label), `the pointer names ${label}`);
    // ...and that name is a real nav row, not a label invented by the note.
    assert.match(appJs, new RegExp(`label: "${label}", tint: "[a-z]+", icon: ICONS\\.[A-Za-z]+, main: false`), `${label} is a real main:false nav row, i.e. in the ☰ menu`);
  }
  assert.match(appJs, /getNavItems\(\)\.filter\(\(item\) => item\.main\)/, "main:false is what keeps a row out of the bottom bar");
});

test("is_staff() checks the caller's own admin flag or coach redemption only, and is locked away from anon", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.is_staff"), sql.indexOf("drop policy announcements_insert_admin"));
  assert.match(fn, /exists \(select 1 from public\.profiles where id = p_uid and is_admin and deleted_at is null\)/i);
  assert.match(fn, /exists \(select 1 from public\.invite_redemptions where user_id = p_uid and role = 'coach'\)/i);
  assert.match(fn, /revoke all on function public\.is_staff\(uuid\) from public, anon/i);
  assert.match(fn, /grant execute on function public\.is_staff\(uuid\) to authenticated/i);
});

test("announcements and weekly_challenges insert/update policies now check is_staff(), not a raw is_admin exists()", () => {
  assert.match(sql, /create policy announcements_insert_admin on public\.announcements for insert to authenticated\s*\n\s*with check \(author_id = auth\.uid\(\) and public\.is_staff\(\)\)/i);
  assert.match(sql, /create policy announcements_update_admin on public\.announcements for update to authenticated\s*\n\s*using \(public\.is_staff\(\)\) with check \(public\.is_staff\(\)\)/i);
  assert.match(sql, /create policy weekly_challenges_insert_admin on public\.weekly_challenges for insert to authenticated\s*\n\s*with check \(created_by = auth\.uid\(\) and public\.is_staff\(\)\)/i);
});

test("coach_inactive_members and coach_new_members now self-gate on is_staff(), not a raw is_admin check", () => {
  const inactive = sql.slice(sql.indexOf("create or replace function public.coach_inactive_members"), sql.indexOf("create or replace function public.coach_new_members"));
  const newMembers = sql.slice(sql.indexOf("create or replace function public.coach_new_members"));
  assert.match(inactive, /if not public\.is_staff\(auth\.uid\(\)\) then\s*\n\s*raise exception/i);
  assert.match(newMembers, /if not public\.is_staff\(auth\.uid\(\)\) then\s*\n\s*raise exception/i);
});
