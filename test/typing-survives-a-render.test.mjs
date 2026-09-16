// "When I press the type boxes it jumps of them, and I need to press again."
// Reported from a real phone, on the community sign-in.
//
// Nothing was wrong with the fields. render() replaces #content wholesale, so
// ANY render landing while a member types destroys the node holding their
// focus; the browser drops focus to <body> and the keyboard closes. Worse, a
// login name or invite code lives in the DOM and not in state, so the typed
// text went with it.
//
// Invisible on a fast connection - every request has resolved before a human
// can tap. Over 4G a response arriving 300ms after the tap lands right in the
// middle of it, which is also why the SECOND tap always worked: by then
// nothing was left in flight to trigger another render.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { readFileSync } from "node:fs";

const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");

async function atLogin() {
  const mock = createMockSupabase({ profiles: [], invite_redemptions: [] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await new Promise((r) => setTimeout(r, 300));
  window.document.querySelector('[data-community-action="show-login"]').click();
  await new Promise((r) => setTimeout(r, 300));
  return window;
}

test("a render the member did not ask for does not take the field they are typing in", async () => {
  const window = await atLogin();
  const input = window.document.querySelector('input[name="username"]');
  assert.ok(input, "the login name field is on screen");
  input.focus();
  input.value = "shachaf";
  input.setSelectionRange(4, 4);

  window.render(); // exactly what a late RPC does

  const after = window.document.querySelector('input[name="username"]');
  assert.notEqual(after, input, "the node really was replaced - otherwise this proves nothing");
  assert.equal(window.document.activeElement, after, "focus came back to the same field");
  assert.equal(after.value, "shachaf", "and what they had typed is still there");
  assert.equal(after.selectionStart, 4, "with the caret where they left it, not at the front");
});

test("the field restored is the one they were actually in, not the first one", async () => {
  const window = await atLogin();
  const user = window.document.querySelector('input[name="username"]');
  const pw = window.document.querySelector('input[name="password"]');
  assert.ok(pw, "there is a second field to move to");
  user.value = "shachaf";
  // The member has moved on to the password field by the time the render
  // lands. Putting them back in the first field would be the same theft in
  // the other direction.
  pw.focus();
  pw.value = "secret";
  pw.setSelectionRange(3, 3);

  window.render();

  const afterPw = window.document.querySelector('input[name="password"]');
  assert.equal(window.document.activeElement, afterPw, "focus returns to the password field");
  assert.equal(afterPw.value, "secret", "with what was typed into THAT field");
  assert.equal(afterPw.selectionStart, 3);
  const afterUser = window.document.querySelector('input[name="username"]');
  assert.notEqual(window.document.activeElement, afterUser, "and not to the first field on the form");
});

test("the restore is keyed on identity, and never resurrects a field the app cleared", () => {
  assert.match(appJs, /function focusFieldIdentity\(el\)/);
  // Only inside the region render() replaces - a dialog keeps its own focus.
  assert.match(appJs, /if \(!content \|\| !content\.contains\(el\)\) return null;/);
  // Only when the swap is what took focus away.
  assert.match(appJs, /if \(again && \(!active \|\| active === document\.body\)\)/);
  // The value is carried for the FOCUSED field alone, and only into an empty
  // box. Refilling a whole form would resurrect fields the app cleared on
  // purpose - setFieldErrors' own note says exactly that.
  assert.match(appJs, /if \(typed != null && again\.value === "" && typed !== ""\) again\.value = typed;/);
  // Value before focus, or setting it would move the caret to the end.
  const at = appJs.indexOf("if (typed != null && again.value");
  assert.ok(at < appJs.indexOf("again.focus();", at), "value is restored before focus");
  assert.ok(appJs.indexOf("again.focus();", at) < appJs.indexOf("setSelectionRange", at),
    "and the caret range after both");
});
