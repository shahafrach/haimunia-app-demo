// Support and bug reporting (2026-09-15).
//
// WHY THIS EXISTS. Before this feature the app had no route whatsoever for
// "this is broken" or "I need help". The four defects found in its first
// real-phone session reached a developer only because the person holding the
// phone was one; a member had nowhere to put the same observation.
//
// WHAT THESE TESTS PIN, beyond "it renders". Three properties that are easy
// to regress and expensive to get wrong:
//   1. It works with Community OFF. The training log needs no account and no
//      network, so asking for help must not require having joined a social
//      feed.
//   2. The diagnostics block carries device facts and NOTHING personal. This
//      text is handed to WhatsApp or mail, so anything that leaks into it
//      leaves the device.
//   3. There is always at least one way to send. An unconfigured club must
//      still get the copy fallback - a support screen with no route out is
//      worse than no support screen.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

async function openSupportSheet(window) {
  window.openSupport();
  const overlay = window.document.getElementById("supportOverlay");
  assert.ok(overlay.classList.contains("open"), "the support overlay should open");
  return overlay;
}

test("a member with Community switched off can still open support and write a report", async () => {
  const window = await bootApp();
  // bootApp() is the offline-only app: no cloud.js session, no network.
  assert.equal(typeof window.cloudSyncActive, "undefined",
    "this fixture must genuinely have no community layer, or the test proves nothing");
  const overlay = await openSupportSheet(window);
  assert.ok(overlay.querySelector("#supportMessage"), "the description field should render");
  assert.match(overlay.textContent, /קהילה: כבויה/, "and the report should say the community layer is off, not crash on it");
  window.closeSupport();
  assert.ok(!overlay.classList.contains("open"), "and it should close again");
});

test("the report carries the device facts a developer needs", async () => {
  const window = await bootApp();
  await openSupportSheet(window);
  const text = window.supportReportText();
  assert.match(text, /גרסה: \d+\.\d+\.\d+/, "the app version is the single most useful line in any bug report");
  assert.match(text, /מותקן במסך הבית: (כן|לא)/, "installed-as-PWA changes real behaviour and must be stated");
  assert.match(text, /חיבור: /, "online/offline changes real behaviour too");
  assert.match(text, /דפדפן: /, "and the engine is what separates an iOS-only defect from a general one");
});

test("the report contains nothing personal - it leaves the device, so this is the load-bearing one", async () => {
  const window = await bootApp();
  // Give the app real, identifiable training data first. If any of it can
  // reach the report, this is where it shows up.
  await window.addMovement("Back Squat Secret", "Squat");
  window.applyFieldValue("step", "weight", 142.5);
  window.applyFieldValue("step", "reps", 3);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  window.closeCelebration();

  await openSupportSheet(window);
  const text = window.supportReportText();
  assert.ok(!/Back Squat Secret/.test(text), "a movement name must never reach the report");
  assert.ok(!/142\.5/.test(text), "nor a logged weight");
  // The member's own typed description is the ONLY free text that travels,
  // and it travels because they wrote it and can read it before sending.
  const field = window.document.getElementById("supportMessage");
  field.value = "לחצתי על העלאת תמונה ולא קרה כלום";
  const withTyped = window.supportReportText();
  assert.match(withTyped, /לחצתי על העלאת תמונה ולא קרה כלום/, "what the member wrote must be in the report");
  assert.ok(!/Back Squat Secret/.test(withTyped), "and typing must not pull training data in with it");
});

test("an empty description still produces a sendable report rather than a blank message", async () => {
  const window = await bootApp();
  await openSupportSheet(window);
  const text = window.supportReportText();
  assert.match(text, /\(לא נכתב תיאור\)/,
    "a member who taps send without typing should still deliver the diagnostics, marked as description-less");
});

test("with no support channel configured there is still a way out - the copy fallback", async () => {
  const window = await bootApp();
  // cloud-config.js ships both channels empty by default, which is exactly
  // the unconfigured-club case this asserts.
  const cfg = window.supportConfig();
  assert.equal(cfg.whatsapp, "", "this fixture should have no WhatsApp number configured");
  assert.equal(cfg.email, "", "nor an email address");
  const overlay = await openSupportSheet(window);
  assert.ok(overlay.querySelector('[data-action="support-copy"]'),
    "the copy fallback must always be offered, or an unconfigured club has a dead-end support screen");
  assert.ok(!overlay.querySelector('[data-action="support-send-whatsapp"]'),
    "and a route that cannot work must not be offered at all");
  assert.ok(!overlay.querySelector('[data-action="support-send-email"]'));
});

test("a configured WhatsApp number is offered, and the number is normalised to wa.me's shape", async () => {
  const window = await bootApp();
  // wa.me rejects +, spaces and dashes; a club owner pasting a human-readable
  // number is the expected input, so the normalisation is the contract.
  window.HAIMUNIA_CONFIG = Object.assign({}, window.HAIMUNIA_CONFIG, { supportWhatsApp: "+972 54-123-4567" });
  assert.equal(window.supportConfig().whatsapp, "972541234567");
  const overlay = await openSupportSheet(window);
  assert.ok(overlay.querySelector('[data-action="support-send-whatsapp"]'), "the WhatsApp route should now be offered");
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
