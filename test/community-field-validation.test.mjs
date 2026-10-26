// Every real-validation input in cloud.js (invite code, handle, announcement
// title/body, weekly challenge fields) now goes through a shared field()
// helper that splices aria-invalid + aria-describedby onto the input when
// state.fieldErrors has an entry for it, and renders the same error text
// visibly right under the field via that id - one message, wired to both a
// screen reader and a sighted user, instead of only a generic banner at the
// top of the form.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const src = cloudSource();

test("a shared field() helper wires aria-invalid/aria-describedby onto the input and renders a matching visible error", () => {
  assert.match(src, /function field\(formId, name, labelText, inputHtml\)/);
  assert.match(src, /aria-invalid="true" aria-describedby="\$\{errId\}"/);
  assert.match(src, /class="field-error" id="\$\{errId\}" role="alert"/);
});

test("state carries per-form field errors, cleared on successful submit and on sign-out", () => {
  assert.match(src, /fieldErrors: \{\}/);
  assert.match(src, /function setFieldErrors\(formId, errors\)/);
  // COMM-365 split the one-line sign-out reset into per-namespace lines, so
  // these two assignments no longer sit side by side.
  assert.match(src, /state\.ui\.fieldErrors = \{\};/);
  assert.match(src, /state\.achievements\.mine = \[\];/);
});

test("the invite code field uses field() instead of a bare labelless input", () => {
  assert.match(src, /field\("communityInviteCode", "code", "קוד פתיחה/);
  assert.match(src, /setFieldErrors\("communityInviteCode", \{ code: "יש להזין קוד פתיחה" \}\)/);
});

test("both handle inputs (profile gate and account tab) route through field() under the same form id, so a duplicate-handle error lands on the right one", () => {
  // The label is CLUB_NAME_LABEL now, not the literal "שם משתמש (handle)":
  // signup asked for a name twice under that same label and the two fields
  // enforced contradictory rules. See the label constants in cloud.js.
  // One name, asked once. The two forms now carry a single club-name field
  // each, and a duplicate still has to land on that field rather than on a
  // generic banner - which was this test's real point all along.
  // The sign-up gate and Me draw the same form (profileFormHtml, keyed by its
  // form id), so there is one field() call and both screens use it.
  const matches = src.match(/field\(formId, "displayName", CLUB_NAME_LABEL/g) || [];
  assert.equal(matches.length, 1);
  assert.equal((src.match(/field\("communityProfile", "handle"/g) || []).length, 0,
    "the member is never asked for a handle");
  assert.match(src, /error\.code === "23505"\) setFieldErrors\(formId, \{ displayName: "השם הזה כבר תפוס/);
});

