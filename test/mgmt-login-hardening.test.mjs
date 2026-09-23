// The management login, hardened (launch-readiness S2, S3, S4).
//
// The gate in front of both management panels is on a screen every member
// can open. Three things made it easier to attack than the member login it
// sits beside:
//   S2  its username field's placeholder was the real head coach username;
//   S3  a correct password on an account without the role got a different
//       answer ("not authorised") from a wrong password, so the gate told a
//       guesser when a guess was right - by its words, and by its timing,
//       since only the correct password goes on to read three rows;
//   S4  it had no captcha, while member sign-in does.
// The tests below drive the real gate through the mock, not the source text,
// except where the property is a line of source (the placeholder, the wrap).
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, ADMIN_STEP_UP_PASSWORD } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const cloudJs = cloudSource();
const VERIFIED = new Date().toISOString();
const MGMT_EMAIL = "manage@example.test";
const MEMBER_EMAIL = "shlomi@members.haimuniya.invalid";
const REFUSED_TEXT = "שם המשתמש או הסיסמה שגויים, או שלחשבון אין הרשאה לאזור הזה";

function mockWith({ mgmtRole = "admin", mgmtIsAdmin = true } = {}) {
  const mock = createMockSupabase({
    profiles: [
      { id: "member-1", handle: "שלומי", display_name: "שחף", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "mgmt-1", handle: "admin", display_name: "ניהול", is_admin: mgmtIsAdmin, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "member-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
      { user_id: "mgmt-1", invite_id: "i2", role: mgmtRole, redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  });
  mock.setUser({ id: "member-1", is_anonymous: false, email: MEMBER_EMAIL });
  mock.seedCredentials("member-1", MEMBER_EMAIL, ADMIN_STEP_UP_PASSWORD);
  mock.seedCredentials("mgmt-1", MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  return mock;
}

// Wraps every management client the app builds from here on, recording each
// sign-in's arguments and, optionally, slowing the role reads that only a
// CORRECT password ever reaches - which is what makes a timing leak visible.
function instrumentMgmtClients(window, { roleReadDelayMs = 0 } = {}) {
  const calls = [];
  const orig = window.supabase.createClient;
  const delay = (v) => (roleReadDelayMs ? new Promise((r) => setTimeout(() => r(v), roleReadDelayMs)) : v);
  window.supabase.createClient = (...args) => {
    const c = orig(...args);
    const signIn = c.auth.signInWithPassword;
    c.auth.signInWithPassword = (creds) => { calls.push(creds); return signIn(creds); };
    // my_permissions is read in the same Promise.all as the two role rows,
    // so slowing it slows the whole correct-password path.
    const rpc = c.rpc;
    c.rpc = (n, a) => Promise.resolve(rpc(n, a)).then(delay);
    return c;
  };
  return calls;
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
function gateError(window) {
  const el = window.document.querySelector("#content .field-error[role=alert]");
  return el ? el.outerHTML : null;
}
// Submits and measures, to the poll interval, how long until the gate answers.
async function timedAttempt(window, email, password) {
  const t0 = Date.now();
  submitGate(window, email, password);
  await waitFor(() => gateError(window) !== null, 6000, 2);
  return { ms: Date.now() - t0, html: gateError(window) };
}

// ---------------------------------------------------------------- S2
test("S2: the management username field names no real account", async () => {
  const window = await bootCommunity(mockWith(), { syncEnabled: false });
  await openPanel(window, "tabManageBtn");
  const input = window.document.getElementById("panelUnlock").elements.email;
  const ph = input.getAttribute("placeholder");
  assert.ok(ph === null || !/coach|admin|owner|manage/i.test(ph),
    `the placeholder must not suggest an account name, got: ${ph}`);
  assert.equal(input.value, "", "and nothing is prefilled on a device that never unlocked");
  // Source-level too, because every committed file is served: the real
  // username must not appear anywhere in the community layer, comments included.
  assert.ok(!/headcoach/i.test(cloudJs), "the head coach's real username is not in the served source");
});

// ---------------------------------------------------------------- S4
test("S4: the management sign-in is wrapped in the same captcha as member sign-in", () => {
  assert.match(cloudJs,
    /withCaptcha\(\(captchaToken\) => \{\s*\n\s*sentAt = Date\.now\(\);\s*\n\s*return c\.auth\.signInWithPassword\(Object\.assign\(\s*\n\s*\{ email, password \},\s*\n\s*captchaToken \? \{ options: \{ captchaToken \} \} : \{\},/,
    "the management sign-in passes the token the way the member login does");
  // No auth call anywhere in the layer is left outside withCaptcha().
  const bare = cloudJs.split("\n").filter((l) => /\.auth\.(signInWithPassword|signInAnonymously|signUp)\(/.test(l));
  for (const line of bare) {
    const at = cloudJs.indexOf(line);
    assert.match(cloudJs.slice(Math.max(0, at - 200), at), /withCaptcha\(/,
      `an auth sign-in is not wrapped in withCaptcha():\n  ${line.trim()}`);
  }
});

function enableTurnstile(window, behave) {
  window.HAIMUNIA_CONFIG.captchaSiteKey = "0xTESTSITEKEY0000000000";
  window.HAIMUNIA_CONFIG.captchaProvider = "turnstile";
  // jsdom never loads the real script; an existing tag is what
  // loadCaptchaScript() treats as already loaded.
  const s = window.document.createElement("script");
  s.dataset.captcha = "turnstile";
  window.document.head.appendChild(s);
  const renders = [];
  window.turnstile = {
    render(host, opts) { renders.push(opts); queueMicrotask(() => behave(opts)); },
  };
  return renders;
}

test("S4: with a site key, the gate obtains a Turnstile token and sends it with the sign-in", async () => {
  const mock = mockWith();
  const window = await bootCommunity(mock, { syncEnabled: false });
  const renders = enableTurnstile(window, (o) => o.callback("tok-123"));
  const calls = instrumentMgmtClients(window);
  await openPanel(window, "tabManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 4000);
  assert.equal(renders.length, 1, "one challenge per attempt");
  assert.equal(renders[0].sitekey, "0xTESTSITEKEY0000000000");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { captchaToken: "tok-123" }, "the token rides the sign-in");
  assert.equal(mock.getUser().id, "member-1", "and the member session is untouched");
});

test("S4: a failed challenge never reaches the password check, and says what failed", async () => {
  const window = await bootCommunity(mockWith(), { syncEnabled: false });
  enableTurnstile(window, (o) => o["error-callback"]());
  const calls = instrumentMgmtClients(window);
  await openPanel(window, "tabManageBtn");
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => /אימות האבטחה נכשל, נסו שוב/.test(window.document.body.textContent), 4000);
  assert.equal(calls.length, 0, "fails closed: no sign-in without a token");
  assert.ok(window.document.getElementById("panelUnlock"), "the gate stays up");
  assert.ok(!window.document.body.textContent.includes(REFUSED_TEXT),
    "and it is not reported as a wrong password");
});

// ---------------------------------------------------------------- S3
test("S3: a wrong password and a correct password on an unentitled account get the identical answer", async () => {
  // Three refusals that used to differ: wrong password; the member's own
  // (correct) password; and a head coach's correct password at the app panel.
  const results = [];
  for (const [label, opts, email] of [
    ["wrong password", {}, MGMT_EMAIL],
    ["correct password, no role", { mgmtRole: "member", mgmtIsAdmin: false }, MGMT_EMAIL],
    ["correct password, head coach at the app panel", { mgmtRole: "head_coach", mgmtIsAdmin: false }, MGMT_EMAIL],
    ["correct password, the member's own account", {}, MEMBER_EMAIL],
  ]) {
    const mock = mockWith(opts);
    const window = await bootCommunity(mock, { syncEnabled: false });
    window.MGMT_UNLOCK_FAILURE_FLOOR_MS = 50;
    await openPanel(window, "tabManageBtn");
    const pw = label === "wrong password" ? "not-the-password" : ADMIN_STEP_UP_PASSWORD;
    const { html } = await timedAttempt(window, email, pw);
    assert.ok(window.document.getElementById("panelUnlock"), `${label}: the gate stays up`);
    assert.equal(mock.getUser().id, "member-1", `${label}: the member session is untouched`);
    results.push([label, html]);
  }
  for (const [label, html] of results) {
    assert.ok(html.includes(REFUSED_TEXT), `${label}: says the shared refusal, got ${html}`);
    assert.equal(html, results[0][1], `${label}: rendered byte-for-byte like a wrong password`);
  }
  assert.doesNotMatch(cloudJs, /אינו מורשה לנהל את (האפליקציה|המועדון)/,
    "the old role-specific refusal is gone from the source");
});

test("S3: a correct password is not refused measurably later than a wrong one", async () => {
  // Make the leak real before checking it is closed: only a CORRECT password
  // reaches the role reads, and here they cost 400ms. Without the
  // floor the correct-password refusal lands ~400ms after the wrong one.
  const FLOOR = 900, SLOW = 400;
  const time = async (opts, password) => {
    const window = await bootCommunity(mockWith(opts), { syncEnabled: false });
    window.MGMT_UNLOCK_FAILURE_FLOOR_MS = FLOOR;
    instrumentMgmtClients(window, { roleReadDelayMs: SLOW });
    await openPanel(window, "tabManageBtn");
    return (await timedAttempt(window, MGMT_EMAIL, password)).ms;
  };
  const wrong = await time({}, "not-the-password");
  const rightNoRole = await time({ mgmtRole: "member", mgmtIsAdmin: false }, ADMIN_STEP_UP_PASSWORD);
  assert.ok(wrong >= FLOOR - 5, `a wrong password waits out the floor (${wrong}ms)`);
  assert.ok(rightNoRole >= FLOOR - 5, `so does a refused correct one (${rightNoRole}ms)`);
  assert.ok(Math.abs(rightNoRole - wrong) < 100,
    `the two refusals must land together: wrong ${wrong}ms, correct-but-refused ${rightNoRole}ms`);
});

test("S3: the default floor is long enough to matter, and a success is never delayed by it", async () => {
  assert.match(cloudJs, /return Number\.isFinite\(v\) && v >= 0 \? v : 1500;/,
    "failures are held to 1.5s after the sign-in request by default");
  // THE ONLY WALL-CLOCK UPPER BOUND IN THE SUITE, and it was the tightest
  // thing in it: floor 3000ms, budget 2500ms, so a machine 1.2x slower than
  // the author's failed a correct login. The assertion is real - a success
  // must not serve the failure floor - so it stays; what changes is the
  // MARGIN. With the floor at 30s and the bound at 10s, a regression that
  // applies the floor overshoots by 3x and still fails, while a machine four
  // times slower than this one still passes. The gap between "correct" and
  // "broken" is now 3x rather than 1.2x, which is what makes it a test rather
  // than a stopwatch race.
  const window = await bootCommunity(mockWith(), { syncEnabled: false });
  window.MGMT_UNLOCK_FAILURE_FLOOR_MS = 30000;
  await openPanel(window, "tabManageBtn");
  const t0 = Date.now();
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 10000,
    5, "the management panel to open on a correct password");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10000,
    `a correct, entitled login opens at once (took ${elapsed}ms; the failure floor is 30000ms, `
    + "so anything near that means the floor is being served on success)");
});

// ------------------------------------------------ the existing guards still hold
test("the one-attempt-at-a-time guard holds through the whole refusal wait", async () => {
  // The floor lengthens every failed attempt, so the busy flag must cover it:
  // a second submit during the wait may not build a second client.
  const window = await bootCommunity(mockWith(), { syncEnabled: false });
  window.MGMT_UNLOCK_FAILURE_FLOOR_MS = 300;
  await openPanel(window, "tabManageBtn");
  const before = window.__mockClientCount;
  submitGate(window, MGMT_EMAIL, "not-the-password");
  await new Promise((r) => setTimeout(r, 100));
  const form = window.document.getElementById("panelUnlock");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => gateError(window) !== null, 3000);
  assert.equal(window.__mockClientCount - before, 1, "one attempt, one management client");
  // And the gate is usable again afterwards, with the right password.
  submitGate(window, MGMT_EMAIL, ADMIN_STEP_UP_PASSWORD);
  await waitFor(() => !window.document.getElementById("panelUnlock"), 3000);
});
