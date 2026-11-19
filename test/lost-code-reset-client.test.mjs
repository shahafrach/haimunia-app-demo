// F19 (2026-11-10) was the lost-code reset on the device. Since Q-38e (2026-11-18) the forgot screen no
// longer offers it and request-reset answers 410 (test/reset-request-edge-function.test.mjs). What stays here:
// a signed-in session still sees the banner of a request opened before the switch and can cancel it, and the
// forgot screen keeps what the member types.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, openCommunityLogin } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { createCirclesMock, bootCircle, click } from "./helpers/circles.mjs";

const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const set = (w, sel, v) => { w.document.querySelector(sel).value = v; };
const text = (w) => w.document.getElementById("content").textContent;
const KEY = "haimunia-demo:resetRequest";
const TOKEN = "c".repeat(64);


// Q-45: the banner of a pending lost-code reset is gone (request-reset answers 410 to every request and
// completion since Q-41, so a pending request can never finish). Nothing asks the server about one any more,
// and a request token an older version left on this device is forgotten.
test("signed in: no reset banner and no my_pending_reset call; an old request token is forgotten", async () => {
  let asked = 0;
  const mock = createCirclesMock({ rpc: { my_pending_reset: () => { asked++; return { data: [], error: null }; } } });
  const window = await bootCircle(mock, { localStorage: { [KEY]: JSON.stringify({ username: "dana", token: TOKEN, readyAt: Date.now() }) } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(window.document.querySelector("[data-reset-banner]"), null);
  assert.equal(asked, 0, "the server is not asked about a pending reset");
  assert.equal(window.localStorage.getItem(KEY), null, "the old request token is gone");
  const src = fs.readFileSync(new URL("../src/community/recovery.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /request-reset|my_pending_reset|cancel_my_reset|communityResetRequest/, "no reset client code left");
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
