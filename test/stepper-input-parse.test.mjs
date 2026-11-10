// Audit M8 (2026-11): typed weights went through replace(",", ".") and
// parseFloat, so "1,250.5" became 1.25 and was clamped up to the minimum, and
// "-5" and Arabic-Indic digits ended the same way, all without a word. One
// parser now lives in src/format.js; an invalid value is flagged and the
// previous value comes back on blur.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";
import { bootApp } from "./helpers/boot.mjs";

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../src/format.js", import.meta.url), "utf8"), ctx);
const parse = ctx.parseLocaleNumber;

test("parseLocaleNumber reads thousands, decimal commas and Arabic-Indic digits", () => {
  const cases = [
    ["1,250.5", 1250.5], ["62,5", 62.5], ["1,250", 1250], ["1,250,000", 1250000],
    ["٢٠", 20], ["۲۰", 20], ["٢٠٫٥", 20.5], ["20", 20], [" 82.5 ", 82.5], [".5", 0.5], ["-5", -5],
  ];
  for (const [raw, want] of cases) assert.equal(parse(raw), want, raw);
});

test("parseLocaleNumber refuses what is not one number", () => {
  for (const raw of ["abc", "", "1.250.5", "12,34,5", "1,2,3", "5kg", "--5", "1,25.0"]) assert.ok(Number.isNaN(parse(raw)), raw);
});

async function typeInto(window, input, value) {
  input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
}
function errorFor(input) {
  const out = input.closest(".stepper").querySelector(".stepper-error");
  return out && !out.hidden ? out.textContent : "";
}

test("a weight with a thousands separator or Arabic-Indic digits is accepted as typed", async () => {
  const window = await bootApp();
  await window.addMovement("Parse Test Squat", "Squat");
  const input = window.document.querySelector("[data-field='weight'].stepper-val");
  await typeInto(window, input, "١٢٢٫٥");
  assert.equal(window.getFieldValue("step", "weight"), 122.5);
  assert.equal(errorFor(input), "");
  await typeInto(window, input, "62,5");
  assert.equal(window.getFieldValue("step", "weight"), 62.5);
});

test("an invalid or negative weight keeps the previous value and says so", async () => {
  const window = await bootApp();
  await window.addMovement("Parse Test Press", "Squat");
  const input = window.document.querySelector("[data-field='weight'].stepper-val");
  await typeInto(window, input, "60");
  assert.equal(window.getFieldValue("step", "weight"), 60);
  for (const bad of ["abc", "-5", "1.250.5"]) {
    await typeInto(window, input, bad);
    assert.equal(window.getFieldValue("step", "weight"), 60, `${bad} must not change the weight`);
    assert.equal(input.getAttribute("aria-invalid"), "true", `${bad} flags the field`);
    assert.match(errorFor(input), /הוחזר הערך הקודם/, `${bad} explains what happened`);
  }
  await typeInto(window, input, "65");
  assert.equal(window.getFieldValue("step", "weight"), 65);
  assert.equal(input.getAttribute("aria-invalid"), null, "a good value clears the flag");
  assert.equal(errorFor(input), "");
});
