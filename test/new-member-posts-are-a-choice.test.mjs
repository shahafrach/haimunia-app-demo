// "There is no need for welcome on feed for every member." Reported looking at
// the live feed, whose first two cards were both "שמחים שהגעת למועדון" - one of
// them for ניהול, the MANAGEMENT account, which is not a member joining a club
// at all (202609150010: management is not a membership).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/202609160004_new_member_posts_are_a_choice.sql", import.meta.url), "utf8");
const cloudJs = readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("the trigger honours a switch, and honours it before doing any work", () => {
  assert.match(sql, /if not public\.club_feature_enabled\('new_member_posts'\) then\s*\n\s*return new;/,
    "the module gate is the first thing the trigger checks");
  const gateAt = sql.indexOf("club_feature_enabled('new_member_posts')");
  const profileLookupAt = sql.indexOf("from public.profiles p");
  assert.ok(gateAt > -1 && gateAt < profileLookupAt,
    "a club with this off pays nothing for it - no profile lookup, no duplicate scan");
});

test("staff are not newcomers to welcome", () => {
  assert.match(sql, /if coalesce\(public\.role_rank\(new\.role\), 10\) >= 20 then/,
    "coach and above never produce a welcome card");
  // A redemption with no resolvable role coalesces to member rank and STILL
  // gets a card - that is a genuine new member, which is who this is for.
  assert.match(sql, /coalesce\(public\.role_rank\(new\.role\), 10\)/);
});

test("the switch is enforced where the row is written, not merely where it is shown", () => {
  // THE POINT. A toggle for this already existed - welcome_flow - and was
  // registered clientOnly, so switching it off hid one client section while
  // the trigger went on writing the posts. A switch that governs less than its
  // label claims is worse than no switch.
  assert.match(cloudJs, /\{ key: "new_member_posts", label: "פוסט הצטרפות בפיד" \}/);
  const at = cloudJs.indexOf('{ key: "new_member_posts"');
  assert.ok(!/clientOnly/.test(cloudJs.slice(at, at + 90)),
    "this key is server-enforced and must not be declared clientOnly");
  // And welcome_flow stays a separate, still-on key: it is the COACH's tool for
  // greeting a newcomer personally, a different question from an automatic card
  // in front of the whole club.
  assert.match(cloudJs, /\{ key: "welcome_flow", label: "קבלת פנים", clientOnly: true \}/);
});

test("the club starts with the posts off, because an unknown key defaults to ON", () => {
  // club_feature_enabled() returns true when no row exists, so "off" only
  // means anything if the row is actually there.
  assert.match(sql, /insert into public\.club_features \(club_id, module_key, enabled\)/);
  assert.match(sql, /'new_member_posts', false/);
  assert.match(sql, /on conflict \(club_id, module_key\) do update set enabled = false/);
});

test("the cards already on the feed are soft-removed, not deleted", () => {
  assert.match(sql, /update public\.workout_posts\s*\n\s*set status = 'removed'/,
    "the same status moderation uses, so the rows stay auditable");
  assert.ok(!/delete from public\.workout_posts/.test(sql),
    "nothing is destroyed - a club that turns the module back on has not lost its history");
});

test("the one-card-per-member guard and the insert are otherwise untouched", () => {
  // The guard is deliberately a check rather than a unique index: a unique
  // violation here would abort the enclosing redemption and block a real
  // person from joining the club over a duplicate feed post.
  assert.match(sql, /where post_type = 'POST_NEW_MEMBER'\s*\n\s*and \(metadata ->> 'member_id'\) = new\.user_id::text/);
  assert.match(sql, /coalesce\(v_name, 'חבר\/ה חדש\/ה'\) \|\| ' הצטרפ\/ה למועדון'/);
});
