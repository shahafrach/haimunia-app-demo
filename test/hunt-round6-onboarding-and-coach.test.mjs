// Live bug hunt, fresh round 6 (2026-09-15) — the new member's first month,
// and the coach board that watches over it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("the first-month card counts the member's own rows, not last week's recap", () => {
  // HIGH. It used to sum weekly_recaps, which the Monday cron writes for the
  // most recently COMPLETED ISO week - while the card fires the moment 30 days
  // elapse, which is always inside an in-progress week. Up to six days of the
  // most recent and most relevant training was invisible.
  //
  // At worst it was not an undercount but a falsehood: a member who started
  // training three days ago, including that morning, had no recap row at all
  // and was told "0 אימונים ... כל הכבוד!". The common case, not an edge one -
  // day 30 almost never lands on a freshly-recapped Monday.
  const at = cloudJs.indexOf("async function loadOnboardingFirstMonthSummary");
  assert.ok(at > -1, "the loader exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.ok(!/from\("weekly_recaps"\)/.test(body),
    "weekly_recaps carries a completed-week cutoff and must not be the source");
  assert.match(body, /from\("attendance_log"\)/, "sessions come from the member's own attendance rows");
  assert.match(body, /from\("member_achievements"\)/, "achievements from their own unlocked rows");
  assert.match(body, /\.gte\("occurred_on", startIso\)\.lte\("occurred_on", endIso\)/,
    "bounded to the member's own first month");
});

test("a member who has not trained is invited, not congratulated", () => {
  // The RECAP-1 rule, which this project established for the weekly push and
  // never applied here: do not praise someone for a zero.
  const at = cloudJs.indexOf("function renderOnboardingFirstMonthStep");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /summary\.sessions === 0/, "zero is its own case");
  assert.match(body, /עוד לא רשמתם אימון/, "and reads as an invitation");
  // The praise line must be unreachable at zero.
  const praiseAt = body.indexOf("כל הכבוד!");
  const zeroAt = body.indexOf("summary.sessions === 0");
  assert.ok(zeroAt > -1 && zeroAt < praiseAt, "the zero branch is tested before the praise branch");
});

test("the PR figure is gone rather than quietly wrong", () => {
  // There is no complete client-side source for it - weekly_recaps.prs is
  // computed inside the recap Edge Function and carries the same cutoff. Two
  // true numbers beat three where one is wrong three weeks in four.
  const at = cloudJs.indexOf("function renderOnboardingFirstMonthStep");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.ok(!/summary\.prs/.test(body), "no PR count is claimed any more");
});

test("all three member-of-week detail branches agree with their own numbers", () => {
  // Round 4 fixed consistency_streak and left the two siblings in the same
  // function untouched - the drift shape this hunt keeps finding, committed
  // by the fix itself. A member's FIRST PR of the week is exactly === 1.
  const at = cloudJs.indexOf("function memberOfWeekCandidateDetailText");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /=== 1 \? "שבוע אחד"/, "consistency_streak");
  assert.match(body, /=== 1 \? "שיא אישי אחד השבוע"/, "most_prs");
  assert.match(body, /n === 1 \? "השלמת אתגר אחת"/, "challenge_completion");
  assert.ok(!/\$\{Number\(d\.pr_count\) \|\| 0\} שיאים אישיים השבוע`;/.test(cloudJs),
    "no raw plural left");
});

test("a coach can act on two new members at once without losing a tap", () => {
  // busy held a single memberId and every guard tested it for truthiness, so
  // while one member's action was in flight a tap on ANY other returned
  // silently - while the row renderer disabled only the row actually in
  // flight, so the other buttons still looked live. A coach working down a
  // list believed they had welcomed someone the app never touched.
  assert.match(cloudJs, /contactDrafts: \{\}, busy: \{\}, welcomed: \{\} \}/,
    "busy is a per-member map, like resetPasswordBusy and challengeJoinBusy");
  const guards = cloudJs.split("state.coach.welcome.busy[memberId]").length - 1;
  assert.ok(guards >= 6, `every guard and setter must be keyed by member, found ${guards}`);
  assert.ok(!/state\.coach\.welcome\.busy = memberId;/.test(cloudJs), "no scalar assignment left");
  assert.ok(!/state\.coach\.welcome\.busy = null;/.test(cloudJs), "no scalar clear left");
  assert.match(cloudJs, /const busy = !!state\.coach\.welcome\.busy\[m\.id\];/,
    "and the row's disabled state reads the same map");
});

test("losing the member-of-week race refreshes the list instead of re-offering it", () => {
  // The success path reloads; the error path did not, and the loader is gated
  // on !loaded so nothing else ever would. A second coach publishing first
  // left this one tapping the same doomed button forever.
  const at = cloudJs.indexOf("async function publishMemberOfWeek");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /state\.coach\.memberOfWeek\.loaded = false;/,
    "the load-once gate is released so the list can actually reload");
  assert.match(body, /already published\|כבר פורסם/,
    "only for a conflict - a network failure should stay retryable");
});

// ===========================================================================
// Moderation and member administration, round 6
// ===========================================================================
const modSql = fs.readFileSync(new URL("../supabase/migrations/202609150013_one_active_restriction_per_member.sql", import.meta.url), "utf8");

test("a new restriction supersedes any already in force on that member", () => {
  // HIGH. mod_restrict_member() INSERTed unconditionally, so a second report
  // on an already-actioned member - report()'s own re-open path makes that
  // ordinary, not a race - left TWO simultaneous active restrictions. The
  // panel rendered two identical lift buttons for one person, and lifting one
  // left them still blocked, because is_posting_restricted() needs only one
  // live row. A moderator who believes they cleared a sanction and a member
  // who cannot post and has been told they are free is worse than the
  // original sanction being wrong.
  assert.match(modSql, /update public\.posting_restrictions\s*\n\s*set lifted_at = now\(\)/,
    "existing restrictions are lifted as part of imposing the new one");
  assert.match(modSql, /and lifted_at is null\s*\n\s*and \(expires_at is null or expires_at > now\(\)\)/,
    "using the same 'still in force' test is_posting_restricted() uses - an EXPIRED row is not superseded");
  assert.match(modSql, /lift_reason = 'הוחלפה בהגבלה חדשה'/,
    "and says what happened, so the audit log reads as a sequence of decisions");
  assert.match(modSql, /'superseded_count', v_superseded/, "the audit row records how many were replaced");
  // The supersede must happen BEFORE the insert, or it lifts the new row too.
  assert.ok(modSql.indexOf("get diagnostics v_superseded") < modSql.indexOf("insert into public.posting_restrictions"),
    "superseding runs before the insert");
  // Existing duplicates are cleaned up once, so the invariant holds from here
  // rather than only for future restrictions.
  assert.match(modSql, /row_number\(\) over \(partition by user_id/, "existing duplicates are reconciled");
});

test("a temporary restriction that simply expired is not treated as superseded", () => {
  // The reason this is a function change and not a unique index: an expired
  // temporary row is un-lifted but no longer in force, and an index on
  // (user_id) where lifted_at is null would block a new restriction on a
  // member whose old one merely ran out. The active test needs now(), which
  // cannot live in an index.
  assert.ok(!/create unique index[^;]*posting_restrictions/i.test(modSql),
    "no partial unique index - it cannot express 'still in force'");
});

test("the temp-password card says whose password it is", () => {
  // It showed a bare secret and nothing else - not a name, not a handle, not
  // even the id already in state. A screenshot taken a moment too late was
  // ambiguous about whose password it was.
  assert.match(cloudJs, /state\.admin\.passwordResetResult = \{ userId, name: subjectNameFor\(userId\), tempPassword/,
    "the name is carried, using the same resolver the confirm dialog already used");
  assert.match(cloudJs, /הסיסמה של \$\{pr\.name \|\| "חבר\/ה"\} אופסה/, "and rendered on the card");
});

test("resetting a second password does not silently destroy an unread one", () => {
  // One reveal slot. Resetting another member while the first card was still
  // up replaced it silently, and the first password was unrecoverable - the
  // server had already rotated it.
  const at = cloudJs.indexOf("async function adminResetPassword");
  const body = cloudJs.slice(at, at + 1600);
  assert.match(body, /const pending = state\.admin\.passwordResetResult;/, "it looks before overwriting");
  assert.match(body, /if \(pending && pending\.userId !== userId\)/,
    "another member's unread secret blocks the reset");
  assert.match(body, /סגרו אותה קודם/, "and the admin is told what to do about it");
});

test("the ghost-reclaim countdown does not say 'עוד 1 ימים'", () => {
  assert.match(cloudJs, /=== 1 \? "יום אחד" : `\$\{Math\.max\(1, GHOST_GRACE_DAYS - stalled\)\} ימים`/,
    "one day is singular, next to the helper that already got this right");
});
