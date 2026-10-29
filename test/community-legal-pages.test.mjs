// privacy.html/terms.html (Hebrew) and PRIVACY.md/TERMS.md (English) say the
// same things. Nothing generates one from the other, so this guards the facts
// that matter against drift: one contact placeholder in one place, the
// copyright line, no gym/coach/club language, and the load-bearing claims.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

// Literal readFileSync paths on purpose: workflow-minutes.test.mjs finds the
// markdown files the suite guards by scanning for them.
const flat = (t) => t.replace(/\s+/g, " ");
const privacyMdRaw = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
const termsMdRaw = fs.readFileSync(new URL("../TERMS.md", import.meta.url), "utf8");
const privacyHtmlRaw = fs.readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const termsHtmlRaw = fs.readFileSync(new URL("../terms.html", import.meta.url), "utf8");
const privacyMd = flat(privacyMdRaw);
const termsMd = flat(termsMdRaw);
const privacyHtml = flat(privacyHtmlRaw);
const termsHtml = flat(termsHtmlRaw);
const all = { "PRIVACY.md": privacyMd, "TERMS.md": termsMd, "privacy.html": privacyHtml, "terms.html": termsHtml };

const PLACEHOLDER = "SUPPORT_ADDRESS_NOT_DECIDED";

test("no page keeps the support-address placeholder: requests go through פנייה in the app", () => {
  for (const [name, t] of Object.entries(all)) assert.doesNotMatch(t, new RegExp(PLACEHOLDER), name);
  assert.match(privacyMd, /Requests, including access and deletion, go through \*\*פנייה\*\* in the app/);
  assert.match(privacyHtml, /בקשות, כולל בקשות גישה למידע ומחיקה, מגישים דרך "פנייה" באפליקציה/);
  assert.match(privacyMd, /no email address or phone number/i);
  assert.match(privacyHtml, /אין כתובת מייל ואין מספר טלפון/);
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
  assert.match(privacyMd, /Body weight never leaves your device/);
  assert.match(privacyHtml, /משקל הגוף לא יוצא מהמכשיר לעולם/);
  assert.doesNotMatch(privacyMd, /body weight(?: and|,) measurements|body weight included/i);
  assert.doesNotMatch(privacyHtml, /משקל גוף ומדידות/);
  assert.match(privacyMd, /No third-party analytics and no ads/);
  assert.match(privacyHtml, /אין אנליטיקה של צד שלישי, אין פרסומות/);
  assert.match(privacyMd, /region is not recorded/);
  assert.match(privacyHtml, /אינו רשום במאגר הקוד/);
});

test("the pages are linked from the app and precached", () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const app = read("app.js");
  assert.match(app, /href="\.\/privacy\.html"/);
  assert.match(app, /href="\.\/terms\.html"/);
  const sw = read("sw.js");
  assert.match(sw, /"\.\/privacy\.html"/);
  assert.match(sw, /"\.\/terms\.html"/);
});

// The English files and the Hebrew pages must keep the same shape. Sections
// are compared by count and by the facts each one carries, not by prose.
const headings = (t, re) => [...t.matchAll(re)].length;
test("PRIVACY.md and privacy.html have the same sections, placeholder and processors", () => {
  const mdSections = headings(privacyMdRaw, /^## /gm);
  const htmlSections = headings(privacyHtmlRaw, /<section class="chart-card"/g);
  assert.equal(mdSections, htmlSections, "section count differs between PRIVACY.md and privacy.html");
  assert.equal(privacyMdRaw.split(PLACEHOLDER).length, privacyHtmlRaw.split(PLACEHOLDER).length);
  for (const processor of ["Supabase", "Cloudflare Pages", "Cloudflare Turnstile"]) {
    assert.ok(privacyMdRaw.includes(processor), `PRIVACY.md lacks ${processor}`);
    assert.ok(privacyHtmlRaw.includes(processor), `privacy.html lacks ${processor}`);
  }
  assert.doesNotMatch(privacyMdRaw + privacyHtmlRaw, /hcaptcha/i);
  // Facts that must be on both sides.
  const pairs = [[/90 days/, /90 יום/], [/within 30 days/, /בתוך 30 יום/], [/Turnstile/, /Turnstile/]];
  for (const [en, he] of pairs) { assert.match(privacyMd, en); assert.match(privacyHtml, he); }
});

test("TERMS.md and terms.html have the same sections and both defer contact to the privacy page", () => {
  const mdSections = headings(termsMdRaw, /^## /gm);
  const htmlSections = headings(termsHtmlRaw, /<section class="chart-card"/g);
  assert.equal(mdSections, htmlSections, "section count differs between TERMS.md and terms.html");
  assert.equal(termsMdRaw.split(PLACEHOLDER).length, termsHtmlRaw.split(PLACEHOLDER).length);
  assert.match(termsMd, /20 members/);
  assert.match(termsHtml, /עד 20 חברים/);
});
