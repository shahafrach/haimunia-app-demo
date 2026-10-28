// privacy.html/terms.html (Hebrew) and PRIVACY.md/TERMS.md (English) say the
// same things. Nothing generates one from the other, so this guards the facts
// that matter against drift: one contact placeholder in one place, the
// copyright line, no gym/coach/club language, and the load-bearing claims.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const flat = (t) => t.replace(/\s+/g, " ");
const privacyMd = flat(read("PRIVACY.md"));
const termsMd = flat(read("TERMS.md"));
const privacyHtml = flat(read("privacy.html"));
const termsHtml = flat(read("terms.html"));
const all = { "PRIVACY.md": privacyMd, "TERMS.md": termsMd, "privacy.html": privacyHtml, "terms.html": termsHtml };

const PLACEHOLDER = "SUPPORT_ADDRESS_NOT_DECIDED";

test("the contact placeholder lives in privacy.html and PRIVACY.md only, once each", () => {
  assert.equal(privacyHtml.split(PLACEHOLDER).length - 1, 1);
  assert.equal(privacyMd.split(PLACEHOLDER).length - 1, 1);
  assert.doesNotMatch(termsHtml, new RegExp(PLACEHOLDER));
  assert.doesNotMatch(termsMd, new RegExp(PLACEHOLDER));
});

test("the terms read the contact from the privacy page", () => {
  assert.match(termsHtml, /href="\.\/privacy\.html#contact"/);
  assert.match(termsMd, /PRIVACY\.md#contact/);
  assert.match(privacyHtml, /id="contact"/);
});

test("every page carries the copyright line", () => {
  for (const [name, t] of Object.entries(all)) {
    assert.match(t, /© Shahaf Rachmany, all rights reserved\.|&copy; Shahaf Rachmany, all rights reserved\./, name);
  }
});

test("no gym-era language remains", () => {
  const gone = /coach|gym|class attendance|מאמן|מועדון|חדר כושר|Arbox/i;
  for (const [name, t] of Object.entries(all)) {
    // "no gym, no coach, no club" is the intended disclaimer.
    const stripped = t.replace(/There is no gym, (?:no )?coach(?:,| or| and) (?:no )?club behind it\./g, "")
      .replace(/אין חדר כושר, אין מאמנים ואין מועדון מאחורי האפליקציה\.|אין חדר כושר, מאמנים או מועדון מאחוריה\./g, "");
    assert.doesNotMatch(stripped, gone, name);
  }
});

test("Hebrew privacy page states the same load-bearing facts as the English file", () => {
  for (const re of [/Supabase/, /Cloudflare Pages/, /Turnstile/, /30/, /90/]) {
    assert.match(privacyMd, re);
    assert.match(privacyHtml, re);
  }
  assert.match(privacyMd, /No email address/);
  assert.match(privacyHtml, /לא נשמרת כתובת מייל/);
  assert.match(privacyMd, /Body weight is never shared with a circle/);
  assert.match(privacyHtml, /משקל הגוף לא משותף לעולם עם מעגל/);
  assert.match(privacyMd, /No third-party analytics and no ads/);
  assert.match(privacyHtml, /אין אנליטיקה של צד שלישי, אין פרסומות/);
  assert.match(privacyMd, /region is not recorded/);
  assert.match(privacyHtml, /אינו רשום במאגר הקוד/);
});

test("the pages are linked from the app and precached", () => {
  const app = read("app.js");
  assert.match(app, /href="\.\/privacy\.html"/);
  assert.match(app, /href="\.\/terms\.html"/);
  const sw = read("sw.js");
  assert.match(sw, /"\.\/privacy\.html"/);
  assert.match(sw, /"\.\/terms\.html"/);
});
