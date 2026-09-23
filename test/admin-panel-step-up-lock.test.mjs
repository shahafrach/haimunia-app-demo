// The lock on the two management panels, and the separate identity behind it.
//
// ASKED FOR IN THREE PASSES, and the third one changed the design:
//   1. "on ניהול מערכת there is need to be separate log in for admin, because
//      this is the area for that."
//   2. "ניהול המועדון needs to also use password."
//   3. "no, i want it to be seperate from the regular user" - together with
//      "because i also train and use the app".
//
// The first two produced a step-up: the panel asked the signed-in member to
// retype their own password. The third retires that. Management is now its
// OWN ACCOUNT with its own email and password, and signing into it must not
// disturb the member session the owner trains on. Those two requirements
// together are why cloud.js runs two Supabase clients - see makeMgmtClient().
//
// WHAT THIS IS NOT, said plainly here because a lock described as more than
// it is becomes the reason nobody adds the real one later: it is not the
// security boundary. is_admin() in the database is, and it is re-checked on
// every action regardless of anything in this file. Nothing here can grant a
// non-admin anything. What it adds is that management credentials are needed
// at all, and that an unattended phone in a gym is not an open admin panel.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, ADMIN_STEP_UP_PASSWORD } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

const MGMT_EMAIL = "manage@example.test";
const MEMBER_EMAIL = "shlomi@members.haimuniya.invalid";
// One answer for every credential failure (launch-readiness S3): a correct
// password on an account without the role reads exactly like a wrong one.
// test/mgmt-login-hardening.test.mjs pins that the two are identical.
const REFUSED = /שם המשתמש או הסיסמה שגויים, או שלחשבון אין הרשאה לאזור הזה/;

const EMPTY = {
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
  coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
  monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
};

// THE FIXTURE THAT MATTERS: the person using the app is a plain member with
// no powers whatsoever - which is exactly the owner's situation now, since
// the whole point is that the account they train on holds nothing. The
// management account is a DIFFERENT row entirely.
function separateIdentitiesMock({ mgmtRole = "admin", mgmtIsAdmin = true } = {}) {
  const mock = createMockSupabase({
    profiles: [
      { id: "member-1", handle: "שלומי", display_name: "שחף", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "mgmt-1", handle: "admin", display_name: "ניהול", is_admin: mgmtIsAdmin, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "member-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
      { user_id: "mgmt-1", invite_id: "i2", role: mgmtRole, redeemed_at: VERIFIED },
    ],
    ...EMPTY,
  });
  // Signed in as the MEMBER. Nothing in the app ever signs in as mgmt-1.
  mock.setUser({ id: "member-1", is_anonymous: false, email: MEMBER_EMAIL });
  mock.seedCredentials("member-1", MEMBER_EMAIL, ADMIN_STEP_UP_PASSWORD);
  mock.seedCredentials("mgmt-1", MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  return mock;
}

async function openPanel(window, rowId) {
  window.document.getElementById(rowId).click();
  await waitFor(() => !!window.document.querySelector("#content .page-title"), 3000);
}
function submitGate(window, email, password) {
  const form = window.document.getElementById("panelUnlock");
  form.elements.email.value = email;
  form.elements.password.value = password;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("the door is visible to a plain member, and it is only a door", async () => {
  // Row visibility cannot be gated on the signed-in member any more: the
  // owner's training account deliberately holds nothing, so a staff check
  // would hide these rows from the one person they exist for. Showing them
  // gives nothing away - what is behind them is a login form.
  const window = await bootCommunity(separateIdentitiesMock(), { syncEnabled: false });
  assert.ok(window.document.getElementById("tabManageBtn"), "ניהול מערכת is reachable");
  assert.ok(window.document.getElementById("tabClubManageBtn"), "ניהול המועדון is reachable");

  await openPanel(window, "tabManageBtn");
  assert.ok(window.document.getElementById("panelUnlock"), "and it opens onto a gate");
  // Not merely collapsed - not rendered at all.
  for (const id of ["manageArea-bugs", "manageArea-audit", "manageArea-settings"]) {
    assert.equal(window.document.getElementById(id), null, `${id} must not render behind the gate`);
  }
});

test("a username works too - the head coach account has no real email address", async () => {
  // The head coach signs in with a bare username; the app maps that onto a synthetic
  // @members.haimuniya.invalid address it has never been shown. Demanding the
  // synthetic form at this gate would lock that account out of its own panel.
  const mock = separateIdentitiesMock({ mgmtRole: "head_coach", mgmtIsAdmin: false });
  mock.seedCredentials("mgmt-1", "headcoach@members.haimuniya.invalid", ADMIN_STEP_UP_PASSWORD);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabClubManageBtn");
  submitGate(window, "headcoach", ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "a bare username opens the panel");
  assert.equal(mock.getUser().id, "member-1", "and still without touching the member session");
});

test("the gate asks for an account as well as a password - it is not a re-check of the member", async () => {
  const window = await bootCommunity(separateIdentitiesMock(), { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  const form = window.document.getElementById("panelUnlock");
  assert.ok(form.elements.email, "there is an email field");
  assert.ok(form.elements.password, "and a password field");
  // It must not prefill or name the signed-in member: suggesting their own
  // address is the exact confusion this redesign removes.
  assert.equal(form.elements.email.value, "", "the member's account is not prefilled");
  assert.ok(!window.document.body.textContent.includes(MEMBER_EMAIL),
    "the gate does not name the member who is signed in");
});

test("the member's own credentials are refused - correct password, wrong account, same answer as a wrong password", async () => {
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MEMBER_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => REFUSED.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "the gate stays up");
  assert.equal(window.document.getElementById("manageArea-bugs"), null, "and nothing behind it rendered");
  // The thing that would matter most if it went wrong: their session.
  assert.equal(mock.getUser().id, "member-1", "the member is still signed in as themselves");
});

test("a wrong password says so without saying which half was wrong, and costs nothing", async () => {
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MGMT_EMAIL, "not-the-password");
  await waitFor(() => /שם המשתמש או הסיסמה שגויים/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "the gate stays up");
  // Losing the session over a mistyped password would be a far worse outcome
  // than the lock prevents. With two clients this is structural: a failed
  // sign-in on the management client cannot touch the member's.
  assert.equal(mock.getUser().id, "member-1", "and it must NOT sign the member out");
});

test("the management account opens the panel WITHOUT taking over the app's session", async () => {
  // This is the whole feature in one assertion pair.
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  // ASSERT THE CONTENT, NOT THE CONTAINER. manageAdminArea() renders its
  // wrapper unconditionally and puts a "no permission" notice inside when the
  // section refuses - so checking for the wrapper alone passes even when every
  // section on the screen is empty. An earlier version of this test did
  // exactly that and missed a real bug: the panel opened, and then refused
  // itself, because the permission helpers were still answering about the
  // member instead of the management account.
  await waitFor(() => mock.callsTo("bug_report_list_all").length > 0, 4000);
  const bugs = window.document.getElementById("manageArea-bugs").textContent;
  assert.ok(!/אין לך הרשאה/.test(bugs), `the bug inbox must actually load, got: ${bugs.trim()}`);
  assert.ok(/אין דיווחים פתוחים|דיווח/.test(bugs), "and render its own empty state or rows");
  assert.ok(mock.callsTo("admin_actions_page").length > 0,
    "the audit log queries as the management account - the member could never read it");
  // "because i also train and use the app" - the account they log workouts
  // on is untouched. If this ever fails, the next workout they log is
  // written to the admin account.
  assert.equal(mock.getUser().id, "member-1",
    "the member session is unchanged - the app is still theirs");
  assert.equal(mock.getUser().email, MEMBER_EMAIL, "right down to the address");
});

test("a management account without the role is refused, with the wrong-password answer", async () => {
  // Correct password, real management-looking account, wrong job. This used
  // to be said plainly ("not authorised"), which also told anyone guessing
  // that the password was right. It now reads exactly like a wrong password,
  // in wording that still covers someone who typed the wrong one of their
  // two management logins.
  const mock = separateIdentitiesMock({ mgmtRole: "member", mgmtIsAdmin: false });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => REFUSED.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "no role, no panel");
  assert.equal(mock.getUser().id, "member-1", "and still no effect on the member");
});

test("a head coach opens the club panel but NOT the app panel", async () => {
  // The two panels are disjoint jobs. head_coach runs the club; it is not
  // admin, and the audit log and password resets are not its business.
  const mock = separateIdentitiesMock({ mgmtRole: "head_coach", mgmtIsAdmin: false });
  const window = await bootCommunity(mock, { syncEnabled: false });

  await openPanel(window, "tabManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => REFUSED.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "head coach is refused the app panel");

  await openPanel(window, "tabClubManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "and admitted to the club panel, where the roster and invites live");
});

test("one login opens every panel that account may use - and only those", async () => {
  // Changed deliberately (2026-09-15, fourth pass). This used to demand a
  // second login for the second panel, on reasoning that belonged to the old
  // step-up design, where the lock was the member's own password and two
  // people could share one account. Against a SEPARATE identity it protects
  // nothing: the session already proves who this is, so a second prompt has
  // exactly one possible answer - the one just given - and on a phone that is
  // friction on a security control, which is how controls get worked around.
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabClubManageBtn");
  assert.equal(window.document.getElementById("panelUnlock").dataset.panel, "club",
    "the gate knows which panel it guards");

  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "the club panel opens");

  await openPanel(window, "tabManageBtn");
  assert.equal(window.document.getElementById("panelUnlock"), null,
    "and the app panel opens too - this account holds admin, and it just proved it");
  assert.ok(window.document.getElementById("manageArea-audit"), "really open, not merely ungated");
});

test("an account entitled to one panel does not slide into the other", async () => {
  // The entitlement is what decides, not which door was knocked on. A head
  // coach signing into the club gets the club - and the app panel stays shut,
  // because the separation that matters is between the two JOBS.
  const mock = separateIdentitiesMock({ mgmtRole: "head_coach", mgmtIsAdmin: false });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabClubManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);

  await openPanel(window, "tabManageBtn");
  assert.ok(window.document.getElementById("panelUnlock"),
    "the app panel is still locked for an account that is not an admin");
  assert.equal(window.document.getElementById("manageArea-audit"), null, "and renders nothing");
});

test("the panel says which account is managing, and can be locked in one tap", async () => {
  // Both were missing. The app is signed in as one person while the panel
  // acts as another, and nothing said so - on a club where the owner holds
  // both logins, "which of my two accounts is this" is a real question, and
  // every action here is recorded against the answer. The lock button is the
  // gate's missing counterpart: before it, the only ways out were to wait,
  // reload, or sign out of the app entirely, so handing the phone to someone
  // meant leaving the panel open.
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.match(window.document.body.textContent, /מנהלים כרגע כ-ניהול/,
    "the panel names the management account it is acting as");

  const lock = window.document.querySelector('[data-community-action="panel-lock"]');
  assert.ok(lock, "a lock control is offered");
  lock.click();
  await waitFor(() => !!window.document.getElementById("panelUnlock"), 4000);
  assert.equal(window.document.getElementById("manageArea-bugs"), null, "one tap and the panel is shut");
  assert.equal(mock.getUser().id, "member-1", "and the member is still signed in, as always");
});

test("the account is remembered on this device; the password never is", async () => {
  // Retyping haimuniya@gmail.com on a phone keyboard, in an LTR field inside
  // an RTL app, every single time, is the friction that stops an owner using
  // the panel at all. The account name is remembered; the password is not,
  // and the fields are marked so the phone's own password manager can offer
  // to save and fill them - autocomplete="off" was what blocked that.
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  const form = window.document.getElementById("panelUnlock");
  assert.equal(form.elements.email.getAttribute("autocomplete"), "username",
    "the phone may fill the account");
  assert.equal(form.elements.password.getAttribute("autocomplete"), "current-password",
    "and the password");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);

  assert.equal(window.localStorage.getItem("haimunia-demo:mgmtAccount"), MGMT_EMAIL,
    "the account is remembered for next time");
  const stored = JSON.stringify(window.localStorage);
  assert.ok(!stored.includes(ADMIN_STEP_UP_PASSWORD),
    "and the password is nowhere in this device's storage");

  window.document.querySelector('[data-community-action="panel-lock"]').click();
  await waitFor(() => !!window.document.getElementById("panelUnlock"), 4000);
  assert.equal(window.document.getElementById("panelUnlock").elements.email.value, MGMT_EMAIL,
    "so the next unlock only needs the password");
});

test("the window measures idle time, not total time", () => {
  // A fixed window is wrong for the job people actually do here - triage the
  // inbox, cross-check the audit log, fix a role, answer a member - which
  // runs past any fixed cutoff routinely. Being asked to retype a password
  // mid-task is what makes an owner stop using the panel. Sliding keeps the
  // property that matters: what this guards is an UNATTENDED phone, and an
  // unattended phone is by definition not being touched.
  const at = cloudJs.indexOf("function mgmtTouch()");
  assert.ok(at > -1, "there is a touch that extends the window");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /if \(u\.admin\) u\.admin = until;/, "extends the app window if it is open");
  assert.match(body, /if \(u\.club\) u\.club = until;/, "and the club window if it is open");
  // The load-bearing half: a zero stays zero. Otherwise a session entitled
  // only to the club would slide its way into the app panel just by sitting
  // on screen.
  for (const line of body.split("\n").filter((l) => l.includes("= until"))) {
    assert.match(line, /^\s*if \(u\.(admin|club)\) u\.\1 = until;\s*$/,
      `every extension must be guarded by the window already being open, got:\n  ${line.trim()}`);
  }
  const render = cloudJs.slice(cloudJs.indexOf("function renderManagePanel"), cloudJs.indexOf("function renderManagePanel") + 3600);
  assert.match(render, /mgmtTouch\(\);/, "every render of an open panel counts as activity");
});

// ===========================================================================
// A management account changes its own password (2026-09-15)
// ===========================================================================
// "How I change the password?" - and the answer was two bad options. The
// roster's איפוס סיסמה works on any account including this one, but the edge
// function generates the password server-side and refuses to take one from
// the client, so it rotates a credential to a random string you then have to
// keep. The alternative was the Supabase dashboard, in a browser, outside the
// app. Neither is acceptable for the credential that guards real database
// authority: a password nobody can comfortably change is one nobody changes.

async function unlockedAdminPanel(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  return window;
}
function submitNewPassword(window, pw, confirm) {
  const form = window.document.getElementById("mgmtPassword");
  form.elements.password.value = pw;
  form.elements.passwordConfirm.value = confirm === undefined ? pw : confirm;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("the management account can change its own password from inside the panel", async () => {
  const mock = separateIdentitiesMock();
  const window = await unlockedAdminPanel(mock);
  window.document.querySelector('[data-community-action="mgmt-password-open"]').click();
  await waitFor(() => !!window.document.getElementById("mgmtPassword"), 4000);

  submitNewPassword(window, "NewManage2026x");
  await waitFor(() => !window.document.getElementById("mgmtPassword"), 4000);
  assert.ok(window.document.getElementById("manageArea-bugs"),
    "the panel stays open - no reason to re-ask someone who just proved who they are");

  // The MANAGEMENT account's credential moved, and the member's did not. This
  // pair is the whole point: on the member client the same call would have
  // changed the password of the person using the app, which is the single
  // worst thing this feature could do.
  const creds = mock.db.__credentials;
  assert.equal(creds.find((c) => c.email === MGMT_EMAIL).password, "NewManage2026x",
    "the management account's password is the new one");
  assert.equal(creds.find((c) => c.email === MEMBER_EMAIL).password, ADMIN_STEP_UP_PASSWORD,
    "and the member's is untouched");
  assert.equal(mock.getUser().id, "member-1", "as is their session");
});

test("the new password is the one that works afterwards, and the old one stops", async () => {
  const mock = separateIdentitiesMock();
  const window = await unlockedAdminPanel(mock);
  window.document.querySelector('[data-community-action="mgmt-password-open"]').click();
  await waitFor(() => !!window.document.getElementById("mgmtPassword"), 4000);
  submitNewPassword(window, "NewManage2026x");
  await waitFor(() => !window.document.getElementById("mgmtPassword"), 4000);

  window.document.querySelector('[data-community-action="panel-lock"]').click();
  await waitFor(() => !!window.document.getElementById("panelUnlock"), 4000);
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => /שם המשתמש או הסיסמה שגויים/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "the old password no longer opens it");

  submitGate(window, MGMT_EMAIL, "NewManage2026x");
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.getElementById("manageArea-bugs"), "the new one does");
});

test("it is held to the same password rule as every other password in the app", async () => {
  const mock = separateIdentitiesMock();
  const window = await unlockedAdminPanel(mock);
  window.document.querySelector('[data-community-action="mgmt-password-open"]').click();
  await waitFor(() => !!window.document.getElementById("mgmtPassword"), 4000);

  // Too short, and no uppercase/digit. The management account is not a quiet
  // exception to the rule the rest of the app states.
  submitNewPassword(window, "short");
  await waitFor(() => /הסיסמה קצרה מדי/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("mgmtPassword"), "the form stays up");
  assert.equal(mock.db.__credentials.find((c) => c.email === MGMT_EMAIL).password, ADMIN_STEP_UP_PASSWORD,
    "and nothing was changed");

  // Mistyped confirmation - caught before anything is sent.
  submitNewPassword(window, "NewManage2026x", "NewManage2026y");
  await waitFor(() => /הסיסמאות לא תואמות/.test(window.document.body.textContent), 4000);
  assert.equal(mock.db.__credentials.find((c) => c.email === MGMT_EMAIL).password, ADMIN_STEP_UP_PASSWORD,
    "still unchanged");
});

test("reusing the current password says so, rather than failing vaguely", async () => {
  // Supabase refuses a password identical to the current one. Someone will do
  // this, and a generic "failed" leaves them with nothing to act on.
  const mock = separateIdentitiesMock();
  const window = await unlockedAdminPanel(mock);
  window.document.querySelector('[data-community-action="mgmt-password-open"]').click();
  await waitFor(() => !!window.document.getElementById("mgmtPassword"), 4000);
  submitNewPassword(window, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => /זהה לנוכחית/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("mgmtPassword"), "the form stays up to try again");
});

test("the head coach gets it too - it is the session's business, not the admin's", async () => {
  // It sits on the session bar rather than inside either panel's areas,
  // because rotating your own credential is not app administration or club
  // administration. The head coach needs it exactly as much.
  const mock = separateIdentitiesMock({ mgmtRole: "head_coach", mgmtIsAdmin: false });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabClubManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('[data-community-action="mgmt-password-open"]'),
    "the club panel offers it as well");
});

test("the change never runs on the member's client", () => {
  // Source-level, because the consequence is bad enough to be worth pinning
  // independently of what any fixture happens to exercise: on `client` this
  // would change the password of the person using the app.
  const at = cloudJs.indexOf("async function mgmtChangePassword");
  assert.ok(at > -1);
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  async function panelUnlock", at));
  assert.match(body, /mgmtClient\.auth\.updateUser/, "it updates the MANAGEMENT account");
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/(?<!mgmt)(?<!\w)client\.auth/.test(code),
    "and never touches the member client's auth");
  assert.match(body, /if \(!mgmtClient \|\| !state\.admin\.mgmt\) return;/,
    "and refuses outright without a management session");
});

// ===========================================================================
// Live bug hunt, fresh round 1 (2026-09-15) - three defects found by agents
// driving the real panel in Chromium, all of them mine from earlier today.
// ===========================================================================

test("the idle window is enforced by mgmtDb() itself, not only by the panel's render", () => {
  // THE DEFECT: mgmtDb() asked only whether a management session object
  // existed. The only thing that ever retired one was renderManagePanel()
  // calling mgmtExpireIfStale(). So a session left idle past its window kept
  // answering mgmtDb() reads fired from elsewhere - reproduced live with a
  // faked clock: unlock, never return to the panel, open Community 35 minutes
  // later, and loadRestrictions()'s second read went out on the management
  // JWT, five minutes past a limit this file documents.
  //
  // Only a read is reachable that way today, because every mgmtDb() write
  // sits behind UI the panel has already expired. That is luck. mgmtDb() gives
  // callers no hint it is panel-scoped, so the next one added outside a panel
  // inherits an unenforced expiry in silence.
  const at = cloudJs.indexOf("function mgmtDb()");
  assert.ok(at > -1, "mgmtDb exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /mgmtExpireIfStale\(\);/,
    "mgmtDb() must retire a lapsed session itself");
  // And the expiry must be asked BEFORE the client is handed back, or it
  // enforces nothing on this call.
  assert.ok(body.indexOf("mgmtExpireIfStale();") < body.lastIndexOf("return"),
    "expiry is checked before the client is returned");
  // The control: the old shape was a single-line ternary on existence alone.
  assert.ok(!/function mgmtDb\(\) \{ return \(mgmtClient && state\.admin\.mgmt\) \? mgmtClient : client; \}/.test(cloudJs),
    "the existence-only version must be gone");
});

test("locking hands the next session a clean slate, not the last one's open form", async () => {
  // THE DEFECT: mgmtTeardown() reset the session but not the change-password
  // form's three state fields. Locking with that form open handed it - still
  // open, still showing the previous account's error - to whoever unlocked
  // next. The worst reproduction was an admin's "this is your current
  // password" error greeting the HEAD COACH by name in their own new session.
  // No value leaked; the inputs are rebuilt empty. But a session bar built to
  // answer "which of my two accounts is this" must not open wearing the
  // other one's state.
  const mock = separateIdentitiesMock();
  const window = await unlockedAdminPanel(mock);
  window.document.querySelector('[data-community-action="mgmt-password-open"]').click();
  await waitFor(() => !!window.document.getElementById("mgmtPassword"), 4000);
  // Leave an error standing, exactly as someone interrupted mid-fix would.
  submitNewPassword(window, "short");
  await waitFor(() => /הסיסמה קצרה מדי/.test(window.document.body.textContent), 4000);

  window.document.querySelector('[data-community-action="panel-lock"]').click();
  await waitFor(() => !!window.document.getElementById("panelUnlock"), 4000);
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);

  assert.equal(window.document.getElementById("mgmtPassword"), null,
    "the new session must not open with the previous one's form already expanded");
  assert.ok(!/הסיסמה קצרה מדי/.test(window.document.body.textContent),
    "nor carrying its error");
});

test("one submit at a time - a double tap cannot strand an authenticated session", async () => {
  // THE DEFECT, found independently by two agents: the busy flag was set after
  // the synchronous prelude rather than checked at the top, and the button is
  // only disabled by the re-render that follows. Two real clicks each built
  // their own client and ran a full sign-in (observed: the mock's client count
  // going 1 -> 3 for one double-click).
  //
  // The visible outcome was benign, which is what made it worth fixing rather
  // than shrugging at: whichever attempt lost the last-write-wins race was
  // left AUTHENTICATED and unreferenced, and mgmtTeardown() only signs out the
  // one client it can still see. A live session nothing can reach is a session
  // nothing can revoke.
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  const form = window.document.getElementById("panelUnlock");
  form.elements.email.value = MGMT_EMAIL;
  form.elements.password.value = ADMIN_STEP_UP_PASSWORD;
  const before = window.__mockClientCount;
  // Two submits with no await between them - the real double-tap interleaving.
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);

  assert.equal(window.__mockClientCount - before, 1,
    `one intent must build one management client, got ${window.__mockClientCount - before}`);
  assert.ok(window.document.getElementById("manageArea-bugs"), "and the panel still opens");
  assert.equal(mock.getUser().id, "member-1", "member session untouched, as always");
});

test("both management submit handlers refuse re-entry while busy", () => {
  // Source-level, because the password form's version of the same gap is
  // awkward to race deterministically in jsdom and the consequence is
  // identical - two updateUser calls for one intent.
  for (const [fn, flag] of [["panelUnlock", "panelUnlockBusy"], ["mgmtChangePassword", "mgmtPasswordBusy"]]) {
    const at = cloudJs.indexOf(`async function ${fn}(form)`);
    assert.ok(at > -1, `${fn} exists`);
    const head = cloudJs.slice(at, at + 1800);
    assert.ok(new RegExp(`if \\(state\\.admin\\.${flag}\\) return;`).test(head),
      `${fn}() must return early while an attempt is already in flight`);
  }
  // And a superseded client is revoked rather than dropped.
  const pu = cloudJs.slice(cloudJs.indexOf("async function panelUnlock(form)"));
  assert.match(pu.slice(0, 9000), /if \(mgmtClient && mgmtClient !== c\)[\s\S]{0,120}?auth\.signOut\(\)/,
    "an overwritten management client must be signed out, not stranded");
});

test("the management session is memory-only and dies with the member's", () => {
  // Persisting it would defeat what it exists for: this guards an already
  // unlocked phone, and a management session that survived a reload would
  // hand the panel over anyway - a worse lock than the 15-minute timer.
  const at = cloudJs.indexOf("function makeMgmtClient");
  assert.ok(at > -1, "the management client exists");
  const body = cloudJs.slice(at, at + 700);
  assert.match(body, /persistSession: false/, "the management session is never persisted");
  assert.match(body, /autoRefreshToken: false/, "and no background timer keeps it alive");
  assert.match(body, /storageKey: "haimunia-mgmt-memory-only"/,
    "and if a future supabase-js touches storage anyway, never on the member's key");

  const region = cloudJs.slice(cloudJs.indexOf("panelUnlockedUntil"), cloudJs.indexOf("panelUnlockedUntil") + 6000);
  assert.ok(!/localStorage[^\n]*panelUnlock/i.test(region), "never localStorage");
  assert.ok(!/sessionStorage[^\n]*panelUnlock/i.test(region), "never sessionStorage");
  // Torn down on sign-out, or the next person to sign in on this device
  // inherits a live management account.
  assert.match(cloudJs, /\n        mgmtTeardown\(\);/, "sign-out tears the management session down");
  const td = cloudJs.slice(cloudJs.indexOf("async function mgmtTeardown"), cloudJs.indexOf("async function mgmtTeardown") + 1800);
  assert.match(td, /mgmtClient = null/, "the reference is dropped");
  assert.match(td, /panelUnlockedUntil = \{ admin: 0, club: 0 \}/, "BOTH unlocks are cleared");
  assert.match(td, /c\.auth\.signOut\(\)/, "and the refresh token is revoked, not merely forgotten");
});

test("management reads run as the management account, member reads as the member", () => {
  // The routing rule. mgmtDb() is what the panel's own loaders call; plain
  // `client` is what every member surface keeps using. If a management loader
  // were left on `client` it would read as the member - who holds nothing -
  // and the panel would render empty behind a gate it had just opened.
  // Falls back to the member client when nothing is unlocked - and since the
  // fresh round-1 hunt, also when the session has gone stale (see the idle
  // window test above).
  const db = cloudJs.slice(cloudJs.indexOf("function mgmtDb()"), cloudJs.indexOf("function mgmtDb()") + 1600);
  assert.match(db, /if \(!mgmtClient \|\| !state\.admin\.mgmt\) return client;/,
    "no management session means the member client");
  assert.match(db, /return \(mgmtClient && state\.admin\.mgmt\) \? mgmtClient : client;/,
    "and a session that just expired means the member client too");
  for (const fn of ["loadBugReports", "loadAuditLog", "loadRoster", "loadModQueue", "adminSetRole",
                    "adminResetPassword", "loadInvites", "toggleClubFeature", "setBugReportStatus"]) {
    const at = cloudJs.indexOf(`function ${fn}(`);
    assert.ok(at > -1, `${fn} exists`);
    const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
    assert.ok(/mgmtDb\(\)\./.test(body), `${fn} must go through mgmtDb()`);
    assert.ok(!/[^t]client\./.test(body.replace(/mgmtDb\(\)/g, "")), `${fn} must not also use the member client`);
  }
});

test("permission questions asked inside a management panel are about the management account", () => {
  // The panel's sections gate themselves on isAdmin()/hasPerm(). Those answer
  // about the signed-in member everywhere else in the app - and the member
  // deliberately holds nothing - so inside a management tab they have to
  // answer about the account that opened the gate, or every section on the
  // screen refuses to render for the person who just proved they may see it.
  assert.match(cloudJs, /function inMgmtContext\(\)/, "there is one definition of 'am I in a management panel'");
  const at = cloudJs.indexOf("function inMgmtContext()");
  const body = cloudJs.slice(at, at + 900);
  assert.match(body, /if \(!state\.admin\.mgmt\) return false;/, "it requires a live management session");
  // window.haimuniaActiveTab, and specifically NOT state.ui.tab. state.ui.tab
  // is cloud.js's own COMMUNITY SUB-TAB (feed / boards / directory) and never
  // holds "manage"; reading it here opened the panel and then rendered every
  // section inside it as "no permission". app.js publishes the real top-level
  // tab on every render pass.
  assert.match(body, /window\.haimuniaActiveTab/, "it reads the top-level tab app.js publishes");
  // Comments stripped first: the comment inside this function names the
  // wrong-signal-it-must-not-use by name, and counting that prose as code is
  // the same mistake the coach-tier test below already made once.
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/state\.ui\.tab/.test(code.slice(0, code.indexOf("}"))),
    "and never cloud.js's own sub-tab, which does not answer this question");
  assert.match(body, /t === "manage" \|\| t === "clubmanage"/, "the two management tabs");
  assert.match(appJs, /window\.haimuniaActiveTab = tab;/, "app.js publishes it");
  for (const fn of ["hasPerm", "isStaff", "isAdmin"]) {
    const i = cloudJs.indexOf(`function ${fn}(`);
    const b = cloudJs.slice(i, cloudJs.indexOf("\n  }", i));
    assert.match(b, /inMgmtContext\(\)/, `${fn}() must know which subject it is being asked about`);
  }
});

test("the gate is the only thing standing in front of the panel, and the panel re-asserts the role", () => {
  // Order matters and is the reverse of what it was. A member-permission
  // check in FRONT of the gate would refuse the page to exactly the people
  // it is for, since management is a separate identity - there would be no
  // way in at all.
  const at = cloudJs.indexOf("function renderManagePanel");
  const body = cloudJs.slice(at, at + 3200);
  const gateAt = body.indexOf("if (!panelUnlocked(panelKey))");
  const roleAt = body.indexOf("isAdminMode ? !mgmtIsAdmin() : !mgmtIsStaff()");
  assert.ok(gateAt > -1, "the gate renders");
  assert.ok(roleAt > -1, "and the panel checks the MANAGEMENT account's role");
  assert.ok(gateAt < roleAt, "the gate comes first; the role check is behind it");
  assert.ok(!/isAdminMode \? !isAdmin\(\) : !isStaff\(\)/.test(body),
    "and it is no longer the signed-in member who is asked");
});

test("the hamburger no longer decides these rows from the signed-in member", () => {
  const at = appJs.indexOf('label: "ניהול מערכת"');
  assert.ok(at > -1, "the row exists");
  const region = appJs.slice(Math.max(0, at - 2600), at + 400);
  const code = region.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/communityIsStaff\(\)/.test(code),
    "row visibility must not depend on the member being staff - that hides it from the owner");
  assert.ok(!/communityIsAdmin\(\)/.test(code),
    "nor on the member being admin, for the same reason");
  // And not on there being a member session at all (2026-09-15, corrected):
  // "they are not related to the actual user using app, it's different."
  // Management is a separate login, and the person who needs it may well not
  // be a member of this club on this device - the owner, signed out, on a
  // freshly wiped phone is exactly the case. Requiring a member session first
  // made the management door reachable only by first becoming the thing
  // management is deliberately not.
  assert.ok(!/isCommunitySignedIn\(\)/.test(code),
    "the rows must not require a member session - that locks the owner out");
});

// ===========================================================================
// The coach board is for coaches (2026-09-15)
// ===========================================================================
test("an admin who does not coach is not offered the coach board", () => {
  // "coach area will be visible only for coach." isStaff() means "coach and
  // above", which sweeps in an admin - and since the panels were split, an
  // admin's job is the app, not the floor. The board is a working surface for
  // whoever actually coaches: congratulate this member, welcome that one,
  // chase the one who has not been in.
  //
  // Note this one is deliberately NOT management-context-aware: the coach
  // board sits on the member's own surfaces and belongs to the person holding
  // the phone, not to whatever account was typed into a gate.
  assert.match(cloudJs, /function isCoachTier\(\)/, "a coach-tier test exists, distinct from isStaff()");
  const at = cloudJs.indexOf("function isCoachTier");
  const body = cloudJs.slice(at, at + 300);
  assert.match(body, /state\.redemption\.role === "coach" \|\| state\.redemption\.role === "head_coach"/,
    "coach-tier is a redeemed ROLE, not the is_admin flag");
  assert.ok(!/is_admin/.test(body), "the is_admin flag alone must NOT make someone a coach");
  const codeLines = cloudJs.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const gates = codeLines.filter((l) => l.includes('isModuleEnabled("coach_tools")'));
  assert.ok(gates.length >= 3, `expected the coach_tools gates to be found, got ${gates.length}`);
  for (const g of gates) {
    assert.ok(g.includes("isCoachTier()"),
      `a coach_tools gate is not coach-tier, so an admin would still be offered the board:\n  ${g.trim()}`);
  }
});
