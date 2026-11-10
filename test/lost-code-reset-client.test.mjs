// F19 (fix plan, 2026-11-10): the lost-code reset on the device. "אין לי קוד
// שחזור" on the forgot screen asks with the username alone; the request token
// stays on this device; after 12 hours the same screen sets a new password and
// shows a new recovery code once. A signed-in session of the account sees a
// banner and can cancel.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, openCommunityLogin } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { createCirclesMock, bootCircle, click } from "./helpers/circles.mjs";

const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const set = (w, sel, v) => { w.document.querySelector(sel).value = v; };
const text = (w) => w.document.getElementById("content").textContent;
const KEY = "haimunia-demo:resetRequest";
const TOKEN = "c".repeat(64);

async function openLost(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.querySelector('[data-community-action="recovery-lost-open"]'), 3000);
  click(window, '[data-community-action="recovery-lost-open"]');
}

test("no code: the username alone starts a request, and the device waits 12 hours", async () => {
  const mock = createMockSupabase();
  const readyAt = new Date(Date.now() + 12 * 3600e3).toISOString();
  mock.onFunction("request-reset", (body) => body.action === "request"
    ? { data: { ok: true, request_token: TOKEN, ready_at: readyAt }, error: null }
    : { data: null, error: { message: "unexpected" } });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openLost(window);
  await waitFor(() => !!window.document.getElementById("communityResetRequest"), 3000);

  set(window, '#communityResetRequest [name="username"]', "דנה");
  submit(window, "communityResetRequest");
  await waitFor(() => /אותיות אנגליות/.test(text(window)), 3000);
  assert.equal(mock.functionCalls.filter((c) => c.name === "request-reset").length, 0, "a Hebrew username never reaches the server");

  set(window, '#communityResetRequest [name="username"]', "dana");
  submit(window, "communityResetRequest");
  await waitFor(() => !!window.document.querySelector("[data-reset-wait]"), 3000);
  assert.deepEqual(mock.functionCalls.find((c) => c.name === "request-reset").body, { action: "request", username: "dana" });
  const stored = JSON.parse(window.localStorage.getItem(KEY));
  assert.equal(stored.username, "dana");
  assert.equal(stored.token, TOKEN, "the token stays on this device");
  assert.equal(window.document.getElementById("communityResetComplete"), null, "no password form before the wait ends");
});

test("after the wait: a new password, then the new recovery code once", async () => {
  const mock = createMockSupabase();
  mock.onFunction("request-reset", (body) => body.action === "complete" && body.request_token === TOKEN && body.username === "dana"
    ? { data: { ok: true, recovery_code: "ABCD-EFGH-JKLM-NPQR" }, error: null }
    : { data: null, error: { message: "nope" } });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.localStorage.setItem(KEY, JSON.stringify({ username: "dana", token: TOKEN, readyAt: Date.now() - 60e3 }));
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.getElementById("communityResetComplete"), 3000);

  set(window, '#communityResetComplete [name="password"]', "BrandNewPass1");
  set(window, '#communityResetComplete [name="passwordConfirm"]', "Different1Pass");
  submit(window, "communityResetComplete");
  await waitFor(() => /הסיסמאות לא תואמות/.test(text(window)), 3000);
  assert.equal(mock.functionCalls.length, 0, "mismatched passwords never reach the server");

  set(window, '#communityResetComplete [name="passwordConfirm"]', "BrandNewPass1");
  submit(window, "communityResetComplete");
  await waitFor(() => !!window.document.querySelector("[data-recovery-code]"), 3000);
  assert.equal(window.document.querySelector("[data-recovery-code]").textContent.trim(), "ABCD-EFGH-JKLM-NPQR");
  assert.equal(window.localStorage.getItem(KEY), null, "the spent request is forgotten");
});

test("a failed completion is one plain message and keeps the request", async () => {
  const mock = createMockSupabase();
  mock.onFunction("request-reset", () => ({ data: null, error: { message: "recovery_failed" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.localStorage.setItem(KEY, JSON.stringify({ username: "dana", token: TOKEN, readyAt: Date.now() - 60e3 }));
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.getElementById("communityResetComplete"), 3000);
  for (const n of ["password", "passwordConfirm"]) set(window, `#communityResetComplete [name="${n}"]`, "BrandNewPass1");
  submit(window, "communityResetComplete");
  await waitFor(() => !!window.document.querySelector("[data-reset-error]"), 3000);
  assert.match(text(window), /אולי הבקשה בוטלה/);
  assert.ok(window.localStorage.getItem(KEY), "kept, so the member can see what happened or ask again");
});

test("signed in: a pending reset shows a banner, and cancelling it calls cancel_my_reset", async () => {
  let cancelled = 0;
  const mock = createCirclesMock({
    rpc: {
      my_pending_reset: () => ({ data: [{ ready_at: new Date(Date.now() + 6 * 3600e3).toISOString(), created_at: new Date().toISOString() }], error: null }),
      cancel_my_reset: () => { cancelled++; return { data: true, error: null }; },
    },
  });
  const window = await bootCircle(mock);
  await waitFor(() => !!window.document.querySelector('[data-reset-banner="pending"]'), 3000);
  assert.match(text(window), /התבקש איפוס לסיסמה שלך/);
  click(window, '[data-community-action="recovery-reset-cancel"]');
  await waitFor(() => !!window.document.querySelector('[data-reset-banner="cancelled"]'), 3000);
  assert.equal(cancelled, 1);
});

test("signed in with nothing pending: no banner", async () => {
  const mock = createCirclesMock({ rpc: { my_pending_reset: () => ({ data: [], error: null }) } });
  const window = await bootCircle(mock);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.querySelector("[data-reset-banner]"), null);
});
