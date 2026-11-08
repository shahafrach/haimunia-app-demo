// Two-step login (TOTP) in the real app against the mock: the sign-up screen says what sign-up
// involves; a password-only session of a member with a second step sees only the code gate; a wrong
// code is refused and the right one lets the member in; a lost phone is answered by the recovery
// code (mfa-recovery) and a new code is shown; Me can enrol (QR and typed key, then one code),
// turn it off with the current code, and end every session. The Supabase side (aal2 in the database,
// the Edge Function) is covered by supabase/tests/0148_mfa_aal2_test.sql and
// test/mfa-recovery-edge-function.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, waitForCommunityGate, openCommunityLogin } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const set = (w, sel, v) => { w.document.querySelector(sel).value = v; };

/** A mock Auth MFA surface: one verified factor, code 123456. level moves to aal2 on a good code. */
function addMfa(mock, { enrolled }) {
  const s = { enrolled, level: "aal1", factors: enrolled ? [{ id: "f1", status: "verified", factor_type: "totp" }] : [], unenrolled: [], signOutScope: null };
  mock.client.auth.mfa = {
    getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: s.level, nextLevel: s.factors.some((f) => f.status === "verified") ? "aal2" : "aal1" }, error: null }),
    listFactors: async () => ({ data: { all: s.factors, totp: s.factors.filter((f) => f.status === "verified") }, error: null }),
    enroll: async () => { s.factors.push({ id: "f2", status: "unverified", factor_type: "totp" }); return { data: { id: "f2", totp: { qr_code: "data:image/svg+xml;utf8,<svg/>", secret: "JBSWY3DPEHPK3PXP" } }, error: null }; },
    challengeAndVerify: async ({ factorId, code }) => {
      if (code !== "123456") return { data: null, error: { message: "invalid" } };
      s.factors = s.factors.map((f) => (f.id === factorId ? { ...f, status: "verified" } : f));
      s.level = "aal2";
      return { data: {}, error: null };
    },
    unenroll: async ({ factorId }) => { s.unenrolled.push(factorId); s.factors = s.factors.filter((f) => f.id !== factorId); return { data: {}, error: null }; },
  };
  const realSignOut = mock.client.auth.signOut;
  mock.client.auth.signOut = (opts) => { s.signOutScope = (opts && opts.scope) || "global-default"; return realSignOut(); };
  return s;
}

test("the sign-up screen explains what sign-up involves before it starts", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  const box = window.document.querySelector("[data-signup-explainer]");
  assert.ok(box, "the explainer is on the first screen");
  assert.match(box.textContent, /בלי אימייל/);
  assert.match(box.textContent, /קוד שחזור/);
  assert.match(box.textContent, /אימות דו-שלבי/);
});

test("a password-only session of a member with two-step login sees only the code gate, then gets in", async () => {
  const mock = createMockSupabase();
  addMfa(mock, { enrolled: true });
  mock.seedCredentials("u-dana", "dana@members.haimuniya.invalid", "CorrectHorse9");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  set(window, '#communityLogin input[name="username"]', "dana");
  set(window, '#communityLogin input[name="password"]', "CorrectHorse9");
  submit(window, "communityLogin");
  await waitFor(() => !!window.document.getElementById("communityMfaChallenge"), 3000);
  assert.equal(window.document.getElementById("communityProfile"), null, "nothing of the account shows");

  set(window, '#communityMfaChallenge input[name="code"]', "000000");
  submit(window, "communityMfaChallenge");
  await waitFor(() => /הקוד לא נכון/.test(window.document.getElementById("content").textContent), 3000);
  assert.ok(window.document.getElementById("communityMfaChallenge"), "a wrong code keeps the gate");

  set(window, '#communityMfaChallenge input[name="code"]', "123456");
  submit(window, "communityMfaChallenge");
  await waitFor(() => !window.document.getElementById("communityMfaChallenge"), 3000);
});

test("a lost phone: the recovery code removes the second step and a new code is shown once", async () => {
  const mock = createMockSupabase();
  addMfa(mock, { enrolled: true });
  mock.seedCredentials("u-dana", "dana@members.haimuniya.invalid", "CorrectHorse9");
  mock.onFunction("mfa-recovery", (body) => (/^[2-9A-HJ-NP-Z]{16}$/.test(body.recovery_code)
    ? { data: { ok: true, recovery_code: "ABCD-EFGH-JKLM-NPQR" }, error: null } : { data: null, error: { message: "bad" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  set(window, '#communityLogin input[name="username"]', "dana");
  set(window, '#communityLogin input[name="password"]', "CorrectHorse9");
  submit(window, "communityLogin");
  await waitFor(() => !!window.document.getElementById("communityMfaChallenge"), 3000);
  window.document.querySelector('[data-community-action="mfa-recover-open"]').click();
  await waitFor(() => !!window.document.getElementById("communityMfaRecover"), 2000);

  set(window, '#communityMfaRecover input[name="code"]', "short");
  submit(window, "communityMfaRecover");
  await waitFor(() => /16 תווים/.test(window.document.getElementById("content").textContent), 2000);
  assert.equal(mock.functionCalls.filter((c) => c.name === "mfa-recovery").length, 0, "a malformed code never leaves the device");

  set(window, '#communityMfaRecover input[name="code"]', "7k2m-qx9d-4hnc-wb8f");
  submit(window, "communityMfaRecover");
  await waitFor(() => !!window.document.querySelector("[data-recovery-code]"), 3000);
  assert.equal(window.document.querySelector("[data-recovery-code]").textContent.trim(), "ABCD-EFGH-JKLM-NPQR");
  assert.match(window.document.getElementById("content").textContent, /האימות הדו-שלבי כובה/);
  assert.deepEqual(mock.functionCalls.find((c) => c.name === "mfa-recovery").body, { recovery_code: "7K2MQX9D4HNCWB8F" });
});

test("Me: enrol with QR and typed key, turn off with the current code, end every session", async () => {
  const mock = createMockSupabase();
  const s = addMfa(mock, { enrolled: false });
  mock.setUser({ id: "u-dana", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.haimuniaMfa.ui().has !== null, 3000);
  

  assert.ok(/הפעלת אימות דו-שלבי/.test(window.haimuniaMfa.panel()), "off: offers to turn it on");
  await window.haimuniaMfa.beginEnroll();
  const panel = window.haimuniaMfa.panel();
  assert.ok(panel.includes("data:image/svg+xml"), "the QR code");
  assert.ok(panel.includes("JBSWY3DPEHPK3PXP"), "and the key to type");

  // The enrol form, as the member would submit it.
  await window.haimuniaMfa.submitEnroll({ elements: { code: { value: "111111" } } });
  assert.equal(window.haimuniaMfa.ui().has, false, "a wrong code does not turn it on");
  await window.haimuniaMfa.submitEnroll({ elements: { code: { value: "123456" } } });
  assert.equal(window.haimuniaMfa.ui().has, true, "the right code turns it on");
  assert.ok(/כיבוי אימות דו-שלבי/.test(window.haimuniaMfa.panel()));

  await window.haimuniaMfa.submitDisable({ elements: { code: { value: "000000" } } });
  assert.equal(window.haimuniaMfa.ui().has, true, "turning off needs the current code");
  await window.haimuniaMfa.submitDisable({ elements: { code: { value: "123456" } } });
  assert.equal(window.haimuniaMfa.ui().has, false);
  assert.ok(s.unenrolled.includes("f2"));

  await window.haimuniaMfa.signOutAll();
  assert.equal(s.signOutScope, "global", "every device, not just this one");
});

test("an anonymous session has no second step to offer", async () => {
  const mock = createMockSupabase();
  addMfa(mock, { enrolled: false });
  mock.setUser({ id: "anon-1", is_anonymous: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => !!window.document.getElementById("content"), 3000);
  assert.equal(window.haimuniaMfa.panel(), "");
  assert.equal(await window.haimuniaMfa.check(), false);
});
