// F19 (2026-11-10) was the lost-code reset on the device. Since Q-38e (2026-11-18) the forgot screen no
// longer offers it and request-reset answers 410 (test/reset-request-edge-function.test.mjs). What stays here:
// a signed-in session still sees the banner of a request opened before the switch and can cancel it, and the
// forgot screen keeps what the member types.
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

test("a re-render while the member types on the forgot screen keeps what was typed (E2E 02-friend, step 18)", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await openCommunityLogin(window);
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.getElementById("communityRecover"), 3000);
  const typeIn = (name, v) => {
    const el = window.document.querySelector(`#communityRecover [name="${name}"]`);
    el.value = v;
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  typeIn("username", "dana");
  typeIn("code", "ABCD-EFGH-JKLM-NPQR");
  typeIn("password", "BrandNewPass1");
  window.render();
  assert.equal(window.document.querySelector('#communityRecover [name="code"]').value, "ABCD-EFGH-JKLM-NPQR");
  assert.equal(window.document.querySelector('#communityRecover [name="password"]').value, "BrandNewPass1");
  click(window, '[data-community-action="recovery-close"]');
  click(window, '[data-community-action="recovery-open"]');
  await waitFor(() => !!window.document.getElementById("communityRecover"), 3000);
  assert.equal(window.document.querySelector('#communityRecover [name="code"]').value, "", "closing the screen forgets it");
});
