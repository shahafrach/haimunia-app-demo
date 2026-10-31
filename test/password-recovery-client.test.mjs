// The recovery screens in the real app against the mock: the code is shown once
// after sign-up with a required "שמרתי"; "שכחתי סיסמה" resets with it and shows a
// new one; Me prompts members who have none and rotates after the password.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, waitForCommunityGate, openCommunityLogin, passRecoveryCode } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { createCirclesMock, click } from "./helpers/circles.mjs";

const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const set = (w, sel, v) => { w.document.querySelector(sel).value = v; };
const text = (w) => w.document.getElementById("content").textContent;

test("after the sign-up upgrade the code is shown once and Continue stays locked until שמרתי", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  set(window, '#communityInviteCode input[name="code"]', "CLUBCODE");
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
  set(window, '#communityCredentials input[name="username"]', "dana");
  for (const n of ["password", "passwordConfirm"]) set(window, `#communityCredentials input[name="${n}"]`, "CorrectHorse9");
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.querySelector("[data-recovery-code]"), 3000);
  const code = window.document.querySelector("[data-recovery-code]").textContent.trim();
  assert.match(code, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
  assert.ok(window.document.querySelector('[data-community-action="recovery-copy"]'), "a copy button");
  const go = () => window.document.querySelector('[data-community-action="recovery-continue"]');
  assert.equal(go().disabled, true, "locked until the box is ticked");
  assert.equal(window.document.getElementById("communityProfile"), null, "the next step waits");
  assert.equal(mock.functionCalls.filter((c) => c.name === "issue-recovery-code").length, 1);
  await passRecoveryCode(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(!text(window).includes(code), "the code is gone from the screen");
  assert.ok(!JSON.stringify(Object.entries(window.localStorage)).includes(code.replace(/-/g, "")), "and was never stored on the device");
});

test("a failed code request does not trap the member: retry, or continue and make one in Me", async () => {
  const mock = createMockSupabase();
  mock.onFunction("issue-recovery-code", () => ({ data: null, error: { message: "down" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  set(window, '#communityInviteCode input[name="code"]', "CLUBCODE");
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
  set(window, '#communityCredentials input[name="username"]', "dana");
  for (const n of ["password", "passwordConfirm"]) set(window, `#communityCredentials input[name="${n}"]`, "CorrectHorse9");
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.querySelector("[data-recovery-error]"), 3000);
  click(window, '[data-community-action="recovery-skip"]');
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
});

test("forgot password: username, code and new password twice, then a NEW code once, then sign in with the new password", async () => {
  const mock = createMockSupabase();
  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "OldPassword1");
  mock.db.__recovery = [{ userId: "u1", code: "ABCDEFGHJKLMNPQR" }];
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  assert.ok(window.document.querySelector('[data-community-action="recovery-open"]'), "שכחתי סיסמה on the login screen");
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.getElementById("communityRecover"), 3000);

  // A wrong code is the generic message, in plain Hebrew.
  set(window, '#communityRecover [name="username"]', "dana");
  set(window, '#communityRecover [name="code"]', "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  for (const n of ["password", "passwordConfirm"]) set(window, `#communityRecover [name="${n}"]`, "BrandNewPass1");
  submit(window, "communityRecover");
  await waitFor(() => !!window.document.querySelector("[data-recovery-error]"), 3000);
  assert.match(text(window), /הפרטים לא תואמים/);

  // Local validation: mismatched passwords never reach the server.
  const calls = mock.functionCalls.length;
  set(window, '#communityRecover [name="username"]', "dana");
  set(window, '#communityRecover [name="code"]', "abcd-efgh-jklm-npqr");
  set(window, '#communityRecover [name="password"]', "BrandNewPass1");
  set(window, '#communityRecover [name="passwordConfirm"]', "Different1Pass");
  submit(window, "communityRecover");
  await waitFor(() => /הסיסמאות לא תואמות/.test(text(window)), 3000);
  assert.equal(mock.functionCalls.length, calls);

  set(window, '#communityRecover [name="username"]', "dana");
  set(window, '#communityRecover [name="code"]', "abcd-efgh-jklm-npqr");
  for (const n of ["password", "passwordConfirm"]) set(window, `#communityRecover [name="${n}"]`, "BrandNewPass1");
  submit(window, "communityRecover");
  await waitFor(() => !!window.document.querySelector("[data-recovery-code]"), 3000);
  const fresh = window.document.querySelector("[data-recovery-code]").textContent.trim().replace(/-/g, "");
  assert.notEqual(fresh, "ABCDEFGHJKLMNPQR", "a new code, the old one is dead");
  assert.equal(window.document.querySelector('[data-community-action="recovery-continue"]').disabled, true);
  await passRecoveryCode(window);
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);
  set(window, '#communityLogin [name="username"]', "dana");
  set(window, '#communityLogin [name="password"]', "BrandNewPass1");
  submit(window, "communityLogin");
  await waitFor(() => !!mock.getUser() && !mock.getUser().is_anonymous, 3000);
});

test("Me: a member with no code is prompted once; creating one asks for the password first", async () => {
  const mock = createCirclesMock();
  mock.db.__credentials = [{ userId: "11111111-1111-4111-8111-111111111111", email: "me@members.haimuniya.invalid", password: "CorrectHorse9" }];
  mock.setUser({ id: "11111111-1111-4111-8111-111111111111", is_anonymous: false, email: "me@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-open-me"]'), 4000);
  click(window, '[data-community-action="c-open-me"]');
  await waitFor(() => !!window.document.querySelector('#recoveryPanel[data-recovery-has="0"]'), 4000);
  assert.match(text(window), /עוד אין לך קוד שחזור/);
  click(window, '[data-community-action="recovery-rotate-open"]');
  await waitFor(() => !!window.document.getElementById("communityRecoveryRotate"), 3000);
  set(window, '#communityRecoveryRotate [name="password"]', "wrong");
  submit(window, "communityRecoveryRotate");
  await waitFor(() => /הסיסמה שגויה/.test(text(window)), 3000);
  assert.equal(mock.functionCalls.filter((c) => c.name === "issue-recovery-code").length, 0, "nothing issued on a wrong password");
  set(window, '#communityRecoveryRotate [name="password"]', "CorrectHorse9");
  submit(window, "communityRecoveryRotate");
  await waitFor(() => !!window.document.querySelector("[data-recovery-code]"), 4000);
  await passRecoveryCode(window);
  window.document.getElementById("tabHomeBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="c-open-me"]'), 3000);
  click(window, '[data-community-action="c-open-me"]');
  await waitFor(() => !!window.document.querySelector('#recoveryPanel[data-recovery-has="1"]'), 4000);
  assert.match(text(window), /קוד שחזור חדש/);
});
