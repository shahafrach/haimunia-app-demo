// פנייה (support) from inside the app. Owner decision 2026-10-28: no support
// email and no phone number. A signed-in member writes a message; the app
// sends the message and the app version, nothing else, through
// bug_report_submit (communitySubmitBugReport in cloud.js).
//
// WHAT THESE TESTS PIN:
//   1. Someone who is not signed in sees why, not a form that cannot work.
//   2. Signed in, the form sends the typed text and ONLY {app_version}: no
//      device facts, no training data.
//   3. There is no email or WhatsApp route anywhere, and cloud-config.js has
//      no support address or phone.
//   4. The dialog behaviours the first release got wrong (Escape order, the
//      backdrop guard) still hold.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

async function openSupportSheet(window) {
  window.openSupport();
  const overlay = window.document.getElementById("supportOverlay");
  assert.ok(overlay.classList.contains("open"), "the support overlay should open");
  return overlay;
}

test("someone not signed in is told why there is no form", async () => {
  const window = await bootApp();
  assert.equal(typeof window.cloudSignedIn, "undefined", "this fixture has no community layer");
  const overlay = await openSupportSheet(window);
  assert.ok(!overlay.querySelector("#supportMessage"), "no form that cannot work");
  assert.match(overlay.textContent, /בלי מייל ובלי טלפון/);
  window.closeSupport();
  assert.ok(!overlay.classList.contains("open"), "and it closes again");
});

test("signed in, the form sends the typed text and the app version only", async () => {
  const window = await bootApp();
  window.cloudSignedIn = () => true;
  const sent = [];
  window.communitySubmitBugReport = async (body, diagnostics) => { sent.push({ body, diagnostics }); return true; };
  await window.addMovement("Back Squat Secret", "Squat");
  const overlay = await openSupportSheet(window);
  assert.ok(overlay.querySelector('[data-action="support-send-club"]'), "a send button");
  assert.ok(!overlay.querySelector('[data-action="support-send-whatsapp"]'), "no WhatsApp route");
  assert.ok(!overlay.querySelector('[data-action="support-send-email"]'), "no email route");
  assert.ok(!overlay.querySelector('[data-action="support-copy"]'), "no copy-the-report fallback with device facts");
  assert.match(overlay.textContent, /לא נשלחים פרטי המכשיר ולא יומן האימונים/);

  const field = window.document.getElementById("supportMessage");
  field.value = "   ";
  await window.supportSendToClub();
  assert.equal(sent.length, 0, "an empty message is not sent");

  field.value = "אפשר למחוק לי את החשבון?";
  await window.supportSendToClub();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "אפשר למחוק לי את החשבון?");
  assert.deepEqual(Object.keys(sent[0].diagnostics), ["app_version"], "the only diagnostics key is app_version");
  assert.match(sent[0].diagnostics.app_version, /^\d+\.\d+\.\d+$/);
  assert.ok(!/Back Squat Secret/.test(JSON.stringify(sent[0])), "no training data travels");
  assert.equal(field.value, "", "a sent message clears the field");
});

test("a failed send keeps the text so nothing is lost", async () => {
  const window = await bootApp();
  window.cloudSignedIn = () => true;
  window.communitySubmitBugReport = async () => false;
  await openSupportSheet(window);
  const field = window.document.getElementById("supportMessage");
  field.value = "הודעה ארוכה שלא רוצים לאבד";
  await window.supportSendToClub();
  assert.equal(field.value, "הודעה ארוכה שלא רוצים לאבד");
  assert.match(window.document.getElementById("supportSendNote").textContent, /לא הצלחנו לשלוח/);
});

test("support is registered ahead of settings, so Escape closes the sheet on top", async () => {
  const window = await bootApp();
  // Support is opened FROM settings and both are open at once. The dialog
  // registry returns the FIRST open entry in insertion order, so getting this
  // backwards closes the sheet underneath and leaves the visible one - the
  // exact defect openAchievements() was once fixed for.
  window.openSettings();
  await openSupportSheet(window);
  const current = window.currentAppDialog();
  assert.equal(current.overlayId, "supportOverlay",
    "with both open, the active dialog must be support - not the settings sheet behind it");
});

test("cloud-config.js and the app carry no support email or phone", () => {
  const cfg = fs.readFileSync(new URL("../cloud-config.js", import.meta.url), "utf8");
  assert.ok(!/supportEmail|supportWhatsApp/.test(cfg), "no support address or number in the config");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(!/supportEmail|supportWhatsApp|mailto:|wa\.me/.test(app), "no email or WhatsApp handoff in app.js");
});

test("tapping inside the sheet does NOT close it - the backdrop guard the first release shipped without", async () => {
  // Reported from a real phone the day this shipped: "trying to put text it
  // closes page". #supportOverlay carries data-action="close-support" so the
  // dim backdrop dismisses it, but the click handler resolves actions with
  // e.target.closest("[data-action]"), which walks UP - so a tap on the
  // textarea found the overlay and closed the dialog before a single
  // character could be typed. The feature was unusable on a touch screen.
  const window = await bootApp();
  window.cloudSignedIn = () => true;
  window.openSupport();
  const overlay = window.document.getElementById("supportOverlay");
  const field = window.document.getElementById("supportMessage");
  assert.ok(field, "the description field should render");

  // A real tap on the textarea bubbles to the overlay, exactly as on a phone.
  field.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(overlay.classList.contains("open"),
    "tapping the description field must NOT close the sheet");

  // Typing then survives, which is the thing the member was trying to do.
  field.value = "לחצתי על העלאת תמונה ולא קרה כלום";
  assert.ok(overlay.classList.contains("open"), "and the sheet is still open after typing");
  assert.equal(window.document.getElementById("supportMessage").value, "לחצתי על העלאת תמונה ולא קרה כלום", "and the text is still in the field");

  // The control: the BACKDROP itself must still dismiss it, or the guard
  // would have fixed one bug by removing the way out of the dialog.
  overlay.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(!overlay.classList.contains("open"),
    "a tap on the backdrop itself still closes the sheet");
});

test("every overlay-level close action in app.js carries the backdrop guard", () => {
  // The defect above was a single missing line in one branch, while three
  // sibling branches had it. A per-branch check is what catches the fourth
  // one being written without it.
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  for (const [action, overlayId] of [
    ["close-support", "supportOverlay"],
    ["close-settings", "settingsOverlay"],
    ["close-notifications", "notificationsOverlay"],
    ["close-nav-menu", "navMenuOverlay"],
  ]) {
    const at = src.indexOf(`action === "${action}"`);
    assert.ok(at > -1, `${action} branch should exist`);
    const branch = src.slice(at, at + 900);
    assert.ok(branch.includes(`el.id === "${overlayId}" && e.target !== el`),
      `${action} must return early unless the click was on the backdrop itself, or every tap inside the dialog closes it`);
  }
});
