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

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

const MGMT_EMAIL = "manage@example.test";
const MEMBER_EMAIL = "shlomi@members.haimuniya.invalid";

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
  // headcoach signs in as `headcoach`; the app maps that onto a synthetic
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

test("the member's own credentials are refused - correct password, wrong account", async () => {
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MEMBER_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => /אינו מורשה/.test(window.document.body.textContent), 4000);
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

test("a management account without the role is refused, in plain words", async () => {
  // Correct password, real management-looking account, wrong job. This is not
  // a probing signal - it is someone who typed the wrong one of their two
  // management logins, and telling them so is a five-second fix instead of a
  // support call.
  const mock = separateIdentitiesMock({ mgmtRole: "member", mgmtIsAdmin: false });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabManageBtn");

  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => /אינו מורשה לנהל את האפליקציה/.test(window.document.body.textContent), 4000);
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
  await waitFor(() => /אינו מורשה לנהל את האפליקציה/.test(window.document.body.textContent), 4000);
  assert.ok(window.document.getElementById("panelUnlock"), "head coach is refused the app panel");

  await openPanel(window, "tabClubManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "and admitted to the club panel, where the roster and invites live");
});

test("the club panel knows which gate it is, and unlocking one does not open the other", async () => {
  const mock = separateIdentitiesMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openPanel(window, "tabClubManageBtn");
  assert.equal(window.document.getElementById("panelUnlock").dataset.panel, "club",
    "the gate knows which panel it guards");

  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.ok(window.document.querySelector('.subtabbtn[data-community-action="set-manage-tab"][data-tab="invites"]'),
    "the club panel opens");

  // The load-bearing property of keying the unlock by panel: one account may
  // well hold both jobs, but opening the club must not silently hand over the
  // app. Same account, same credentials - still asked again.
  await openPanel(window, "tabManageBtn");
  assert.ok(window.document.getElementById("panelUnlock"),
    "the app panel is still locked - the two unlocks are independent");
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
  const td = cloudJs.slice(cloudJs.indexOf("async function mgmtTeardown"), cloudJs.indexOf("async function mgmtTeardown") + 700);
  assert.match(td, /mgmtClient = null/, "the reference is dropped");
  assert.match(td, /panelUnlockedUntil = \{ admin: 0, club: 0 \}/, "BOTH unlocks are cleared");
  assert.match(td, /c\.auth\.signOut\(\)/, "and the refresh token is revoked, not merely forgotten");
});

test("management reads run as the management account, member reads as the member", () => {
  // The routing rule. mgmtDb() is what the panel's own loaders call; plain
  // `client` is what every member surface keeps using. If a management loader
  // were left on `client` it would read as the member - who holds nothing -
  // and the panel would render empty behind a gate it had just opened.
  assert.match(cloudJs, /function mgmtDb\(\) \{ return \(mgmtClient && state\.admin\.mgmt\) \? mgmtClient : client; \}/,
    "mgmtDb() falls back to the member client when nothing is unlocked");
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
  // The one condition that remains is not about powers: it is whether this
  // device has joined the club at all. The offline log works with no account,
  // and two management doors in front of someone who never joined is clutter.
  assert.match(code, /isCommunitySignedIn\(\)/,
    "the rows still require a community session on this device");
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
