// COMM-335: PRIVACY.md/TERMS.md are the source-of-truth plain-text policies;
// privacy.html/terms.html are hand-maintained styled copies of the same
// content for in-app viewing (see the comment at the top of each .html file).
// Nothing generates one from the other, so the risk is silent drift between
// them. This suite guards the facts that matter most against that drift
// (no leftover placeholders, and the load-bearing facts — the 30-day
// deletion windows, minimum age, hosting region, "contact your coach" —
// agree across all four files) rather than diffing full prose, which would
// be too brittle.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

const privacyMd = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
const termsMd = fs.readFileSync(new URL("../TERMS.md", import.meta.url), "utf8");
const privacyHtml = fs.readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const termsHtml = fs.readFileSync(new URL("../terms.html", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

const bracketPlaceholder = /\[[A-Z][^\]]*\]/;

test("PRIVACY.md and TERMS.md have no leftover bracketed placeholders", () => {
  assert.doesNotMatch(privacyMd, bracketPlaceholder);
  assert.doesNotMatch(termsMd, bracketPlaceholder);
});

test("privacy.html and terms.html have no leftover bracketed placeholders either", () => {
  assert.doesNotMatch(privacyHtml, bracketPlaceholder);
  assert.doesNotMatch(termsHtml, bracketPlaceholder);
});

test("no draft/legal-review disclaimer language remains anywhere", () => {
  const draftLanguage = /this is a draft|requires legal review|not yet reviewed/i;
  for (const [name, text] of [
    ["PRIVACY.md", privacyMd],
    ["TERMS.md", termsMd],
    ["privacy.html", privacyHtml],
    ["terms.html", termsHtml],
  ]) {
    assert.doesNotMatch(text, draftLanguage, `${name} still contains draft/review language`);
  }
});

// All four documents became bilingual (Hebrew first, English second) on
// 2026-09-06: the club's members are Israeli and read Hebrew, so a notice
// they cannot read is not a notice. Every guarantee below is therefore
// asserted in BOTH languages - an English-only assertion would let the
// Hebrew half, which is the half members are actually given, silently lose
// the promise.
//
// Matching runs on a whitespace-normalised copy of each file. That is what
// lets one regex cover the Markdown (hard-wrapped at ~72 columns) and the
// HTML (wrapped differently, and indented inside <p>/<li>) without either a
// reflow or a re-indent breaking a test about legal content. The phrases
// themselves are still required verbatim.
const flat = (text) => text.replace(/\s+/g, " ");
const privacyMdFlat = flat(privacyMd);
const privacyHtmlFlat = flat(privacyHtml);
const termsMdFlat = flat(termsMd);
const termsHtmlFlat = flat(termsHtml);
const privacyBoth = [privacyMdFlat, privacyHtmlFlat];
const termsBoth = [termsMdFlat, termsHtmlFlat];
const allFour = [...privacyBoth, ...termsBoth];

test("all four documents carry both languages, with Hebrew as the members' text", () => {
  for (const text of allFour) {
    assert.match(text, /[֐-׿]/, "no Hebrew at all in a document members are meant to read");
    // Which language wins is itself a legal statement and has to be present
    // in both halves: the Hebrew sentence for the members it binds, and an
    // English one so an English-only reader knows theirs is the translation.
    assert.match(text, /הנוסח העברי הוא הקובע/);
    assert.match(text, /the Hebrew (?:text above )?governs for members/);
  }
});

test("both formats agree there is no separate legal entity, and point to the coach as the real contact path", () => {
  for (const text of privacyBoth) {
    assert.match(text, /no separate (?:company|legal entity)/);
    assert.match(text, /your coach directly/);
    assert.match(text, /אין חברה מאחורי האפליקציה/);
    assert.match(text, /למאמן\/ת שלכם ישירות/);
  }
  for (const text of termsBoth) {
    assert.match(text, /no separate company/);
    assert.match(text, /your coach directly/);
    assert.match(text, /אין חברה מאחורי האפליקציה/);
    assert.match(text, /למאמן\/ת שלכם ישירות/);
  }
});

// NOTE ON THE TWO 30-DAY WINDOWS. There are two, they are different, and
// this assertion deliberately only pins the number. (1) Account deletion you
// ASKED for: the profile is hidden immediately and everything is erased 30
// days later. (2) The abandoned-account clean-up: an EMPTY backup-only
// account is collected after 30 days of dormancy. The scope of (2) is what
// 202609070001 corrected and is asserted in full below, and in
// community-backup-sync.test.mjs.
test("both formats agree on the real, verifiable facts: 30-day deletion windows, minimum age 13, and Supabase's ap-southeast-1 region", () => {
  for (const text of privacyBoth) {
    assert.match(text, /30.days/);
    assert.match(text, /under 13/);
    assert.match(text, /ap-southeast-1/);
    assert.match(text, /30 ימים/);
    assert.match(text, /מתחת לגיל 13/);
  }
  for (const text of termsBoth) {
    assert.match(text, /at least 13/);
    assert.match(text, /בני 13 לפחות/);
  }
});

// The 2026-09-08 correction, and the reason this suite covers .html and not
// only .md: the markdown was corrected in the same pass, and a styled copy
// still promising that a member's log is deleted after 30 days is the same
// harm shipped to the screen members actually read. 202609070001 is the
// source of truth - an account holding any training data is never touched by
// purge_abandoned_profiles(), so only an EMPTY backup-only account is
// collected. Asserted in both languages and both formats, with the retired
// promise blocked from returning.
test("all four documents scope the abandoned-account clean-up to an empty account, and none of them still promises to delete a log", () => {
  for (const text of privacyBoth) {
    assert.match(text, /חשבון גיבוי בלבד וריק נסגר אחרי 30 יום/);
    assert.match(text, /אם שמרתם אליו ולו אימון אחד — הוא לא נמחק/);
    assert.match(text, /an empty backup-only account is closed after 30 days/i);
    assert.match(text, /If you have saved even one workout to it, it is not deleted/);
    // The retention section has to agree with the paragraph above it.
    assert.match(text, /חשבון שגובה אליו משהו לא נמחק על ידי ניקוי החשבונות הנטושים לעולם/);
    assert.match(text, /an account that has anything backed up to it is never deleted by the abandoned-account clean-up/i);
  }
  for (const text of termsBoth) {
    assert.match(text, /אם שמרתם אליו ולו אימון אחד — הוא לא נמחק/);
    assert.match(text, /if you have saved even one workout to it, it is not deleted/i);
  }
  for (const text of allFour) {
    assert.doesNotMatch(text, /חשבון גיבוי בלבד נמחק אחרי 30 יום/);
    assert.doesNotMatch(text, /נמחק אוטומטית 30 יום אחרי שנפתח/);
    assert.doesNotMatch(text, /a backup-only account is deleted after 30 days/i);
    assert.doesNotMatch(text, /deleted automatically 30 days after it was opened/i);
    assert.doesNotMatch(text, /along with everything backed up to it/i);
  }
});

// The 2026-09-06 correction. The policy used to describe the coach-facing
// engagement signal as coming from "your class attendance history (not what
// you view or click in the app)" - the exact inverse of the truth twice
// over: the app has no class-attendance source at all (that is Arbox's, and
// out of scope for this product), and the "not active"/"new members" coach
// lists are built on activity_pings, whose only writer is pingActivity() in
// cloud.js and which records "this member opened the app today".
//
// It also declared two collections that do not exist: class attendance and
// upcoming bookings "tied to your account", and a birthday toggle
// (202608280003 deliberately created no birth-date column anywhere).
//
// These assertions exist so that neither the false denial nor the
// over-declaration can come back by an edit that is not thinking about it.
// THE 2026-09-08 CONSENT CORRECTION, and the most serious of the two
// inaccuracies this pass found, because a false LEGAL BASIS is a claim about
// what members agreed to.
//
// c4cd505 added the S5 backup-consent card and 8136133 made
// maybeAutoStartBackup() return early while window.haimuniaBackupConsentPending()
// is true. On a device that gets asked, no anonymous account exists until the
// member answers - which is consent in the ordinary sense. But app.js:5831
// writes backupConsent = "grandfathered" for any device that is not a fresh
// install, and those members were never asked. So there are genuinely TWO
// populations and the document has to be true for both; picking either single
// basis would be false for the other half. These assertions hold the split in
// place, in both languages and both formats.
test("the basis-for-processing section splits cloud backup by population instead of claiming one basis for everyone", () => {
  for (const text of privacyBoth) {
    assert.match(text, /לגיבוי לענן אין בסיס אחד, כי לא כל החברים נשאלו/);
    assert.match(text, /אם נשאלתם/);
    // Bold in both formats: **הסכמה** in the Markdown, <strong> in the HTML.
    assert.match(text, /הבסיס הוא (?:\*\*|<strong>)הסכמה/);
    assert.match(text, /אם לא נשאלתם/);
    assert.match(text, /cloud backup does not have a single basis, because not every member was asked/i);
    assert.match(text, /If you were asked/);
    assert.match(text, /If you were not asked/);
  }
});

// The old sentence, blocked from returning. It is not merely stale - it is
// the load-bearing premise of the paragraph that followed it, so a revert of
// this one line silently re-declares the basis for every member who WAS asked.
test("the retired 'not based on consent, no screen asks you to agree' claim cannot return to any of the four documents", () => {
  for (const text of allFour) {
    assert.doesNotMatch(text, /אוטומטית, בלי לשאול אתכם קודם/);
    // The retired sentence in either format's bold. The surviving text says
    // the same words in the opposite order ("...נדלק מעצמו..., ולכן אצלכם
    // הוא אינו מבוסס על הסכמה"), and only for the population it is true of,
    // so this pattern is specific to the claim that covered everyone.
    assert.doesNotMatch(text, /(?:\*\*|<strong>)אינו(?:\*\*|<\/strong>) מבוסס על הסכמה, כי הוא נדלק מעצמו/);
    assert.doesNotMatch(text, /אין כרגע מסך שמבקש את אישורכם/);
    assert.doesNotMatch(text, /חשבון נפתח לכם אוטומטית בשמירת האימון הראשון/);
    assert.doesNotMatch(text, /automatically, without asking first/i);
    assert.doesNotMatch(text, /no screen asks you to agree/i);
    assert.doesNotMatch(text, /there is currently no screen that asks for your agreement/i);
    assert.doesNotMatch(text, /An account is opened for you automatically when you save your first workout/i);
    assert.doesNotMatch(text, /back your log up to the cloud, without asking you first/i);
  }
});

// The Terms carry the same fact in a shorter form, and a member who reads
// only the Terms must not be told the account is opened without a question.
test("the Terms describe account creation as asked-or-not, matching the Privacy Policy", () => {
  for (const text of termsBoth) {
    assert.match(text, /חשבון הגיבוי לא נפתח עד שאתם עונים/);
    assert.match(text, /no backup account is opened until you answer/i);
    assert.match(text, /On devices already in use before that card was added, the account is opened automatically/i);
  }
});

// WHY THIS TEST READS THE APP AND NOT THE DOCUMENT. The consent half of the
// basis above is true only while the interlock exists: app.js exposes
// haimuniaBackupConsentPending() and cloud.js's maybeAutoStartBackup()
// refuses to create an anonymous session while it is true (8136133). Delete
// either line and the policy's "no cloud account is opened until you answer"
// becomes exactly the kind of screen-promises-what-the-code-does-not defect
// this audit keeps finding - in the legal basis this time. Asserted here, in
// the suite that owns the sentence, so the failure lands next to the claim.
test("the code that makes the consent half of the legal basis true is still in place", () => {
  // maybeAutoStartBackup() is in src/community/auth.js now.
  const cloudJs = cloudSource();
  assert.match(appJs, /window\.haimuniaBackupConsentPending = function \(\) \{ return backupConsent === null; \};/);
  assert.match(cloudJs, /if \(typeof window\.haimuniaBackupConsentPending === "function" && window\.haimuniaBackupConsentPending\(\)\) return;/);
  // And the other population is real, which is why the document names it:
  // any device that is not a fresh install is grandfathered and never asked.
  assert.match(appJs, /if \(backupConsent === null && !isFreshInstall\) setBackupConsent\("grandfathered"\);/);
});

test("the policy does not re-declare data the app never collects, in either language", () => {
  for (const text of privacyBoth) {
    assert.doesNotMatch(text, /your class attendance history/i);
    assert.doesNotMatch(text, /Class attendance and upcoming bookings/i);
    assert.doesNotMatch(text, /whether your birthday is shown/i);
    assert.doesNotMatch(text, /האם יום ההולדת שלכם מוצג/);
  }
});

test("the policy states what a training day actually is - a logged workout, not a class check-in - in both languages", () => {
  for (const text of privacyBoth) {
    assert.match(text, /"יום אימון" באפליקציה הוא יום שרשמתם בו אימון ביומן/);
    assert.match(text, /לא מחוברת למערכת הרישום או הצ'ק־אין של המועדון/);
    assert.match(text, /a day you logged a workout/);
    assert.match(text, /not connected to the club's class booking or check-in system/);
  }
});

test("the policy keeps the database-enforced promise that coaches see rates, not a log of training days", () => {
  // 202609060013 narrowed attendance_log_staff_select from
  // `has_perm('community.analytics.view') OR is_staff()` down to the
  // permission alone, precisely so this sentence is true in the schema and
  // not only on paper. If the schema is ever widened back, this promise has
  // to be revisited rather than quietly left standing.
  for (const text of privacyBoth) {
    assert.match(text, /הקצב שלכם, לא רשימת האימונים שלכם/);
    assert.match(text, /your rate, not a list of your workouts/);
    assert.match(text, /Reading another member's day-by-day rows requires the admin\/analytics permission/);
  }
});

test("the policy separates the app-open measure from training, and says which coach surfaces come from it", () => {
  for (const text of privacyBoth) {
    assert.match(text, /ימי פתיחת אפליקציה — לא אימונים, לא נוכחות בשיעור ולא פרסום בפיד/);
    assert.match(text, /count days the app was opened — not workouts, not class attendance, and not posting to the feed/);
  }
});

test("app.js's legal links point at the styled HTML pages, not the raw markdown", () => {
  assert.match(appJs, /href="\.\/privacy\.html"/);
  assert.match(appJs, /href="\.\/terms\.html"/);
  assert.doesNotMatch(appJs, /href="\.\/PRIVACY\.md"/);
  assert.doesNotMatch(appJs, /href="\.\/TERMS\.md"/);
});

test("privacy.html and terms.html load theme-init.js and stay RTL/Hebrew-shelled like the rest of the app", () => {
  for (const html of [privacyHtml, termsHtml]) {
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.match(html, /<script src="\.\/theme-init\.js"><\/script>/);
  }
});

// ---------------------------------------------------------------------------
// The two staff free-text fields the policy used to omit, and the retention
// claim that 202609230002 made false.
//
// mod_lift_restriction() writes a SECOND free-text reason (posting_restrictions
// .lift_reason, 500 chars) and mirrors it into admin_actions.note. Neither the
// lifting reason nor the action log itself was described anywhere in the
// policy, while the imposition reason was described in detail.
//
// And 202609230002 added admin_actions_redact_on_user_delete(), which replaces
// that free text when the account goes. Both files said the opposite - that the
// audit copy is never deleted - which is the worse of the two errors: a policy
// understating what it keeps is a nuisance, one overstating it is a promise
// broken in the member's favour that a reader cannot rely on either way.
const redactionMarker = "[הנימוק נמחק יחד עם החשבון]";

// Both documents are hard-wrapped prose, so a fixed-width line break lands in
// the middle of most sentences worth asserting on. flat() (line 57) collapses
// runs of whitespace; match against that, not the raw text.
const flatMd = flat(privacyMd);
const flatHtml = flat(privacyHtml);

test("both files disclose the reason recorded when a restriction is LIFTED", () => {
  assert.match(privacyMd, /סיבה להסרת הגבלה/, "Hebrew, PRIVACY.md");
  assert.match(privacyMd, /reason a restriction is lifted/i, "English, PRIVACY.md");
  assert.match(privacyHtml, /סיבה להסרת הגבלה/, "Hebrew, privacy.html");
  assert.match(privacyHtml, /reason a restriction is lifted/i, "English, privacy.html");
});

test("the lifting reason is described as one the member does NOT see", () => {
  // The imposition reason IS shown, in the account tab, while the restriction
  // is live. The lifting reason never is, and a policy that blurred the two
  // would describe a transparency the app does not offer.
  assert.match(flatMd, /את הסיבה הזו אתם לא רואים באפליקציה/);
  assert.match(flatMd, /You do not see this one in the app/);
});

test("both files describe the staff action log itself, not just the reason in it", () => {
  assert.match(flatMd, /\*\*יומן הפעולות של הצוות\.\*\*/, "Hebrew heading, PRIVACY.md");
  assert.match(flatMd, /\*\*The staff action log\.\*\*/, "English heading, PRIVACY.md");
  assert.match(flatHtml, /<strong>יומן הפעולות של הצוות\.<\/strong>/, "Hebrew heading, privacy.html");
  assert.match(flatHtml, /<strong>The staff action log\.<\/strong>/, "English heading, privacy.html");
  // The 8KB before/after snapshot is the part a reader cannot guess.
  for (const [name, doc] of [["PRIVACY.md", flatMd], ["privacy.html", flatHtml]]) {
    assert.match(doc, /8KB/, `${name} states the snapshot size`);
  }
});

test("no file still claims the audit copy outlives the account", () => {
  // The exact sentences 202609230002 falsified.
  assert.doesNotMatch(flatMd, /לא נמחק, גם לא עם החשבון/,
    "PRIVACY.md Hebrew still says the action-log copy is never deleted");
  assert.doesNotMatch(flatMd, /is not deleted, not even with the account/,
    "PRIVACY.md English still says the action-log copy is never deleted");
  assert.doesNotMatch(flatHtml, /לא נמחק, גם לא עם החשבון/);
  assert.doesNotMatch(flatHtml, /is not deleted, not even with the account/);
});

test("both files name the redaction marker the migration actually writes", () => {
  // SIBLING DRIFT: the marker is a string literal in
  // 202609230002_deletion_reaches_photos_telemetry_and_the_audit_note.sql.
  // If someone changes it there, the policy quotes a marker that never appears.
  const migration = fs.readFileSync(
    new URL("../supabase/migrations/202609230002_deletion_reaches_photos_telemetry_and_the_audit_note.sql",
      import.meta.url), "utf8");
  assert.ok(migration.includes(redactionMarker),
    "the migration no longer writes the marker the policy quotes");
  assert.ok(privacyMd.includes(redactionMarker), "PRIVACY.md quotes the marker");
  assert.ok(privacyHtml.includes(redactionMarker), "privacy.html quotes the marker");
});

test("the three redacted action types are the three the trigger covers", () => {
  // member_restrict, member_unrestrict, report_review. The policy lists them in
  // prose; if the trigger ever covers a fourth, this fails and the prose moves.
  const migration = fs.readFileSync(
    new URL("../supabase/migrations/202609230002_deletion_reaches_photos_telemetry_and_the_audit_note.sql",
      import.meta.url), "utf8");
  for (const t of ["member_restrict", "member_unrestrict", "report_review"]) {
    assert.ok(migration.includes(t), `trigger still covers ${t}`);
  }
});

// ---------------------------------------------------------------------------
// S13, S14, S15: three statements that had drifted away from the code.
// Each is pinned to the CODE that makes it true, not just to its own wording,
// because the failure mode here is the code moving and the prose staying.
// ---------------------------------------------------------------------------
const swJs = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");

test("S13: the policy no longer claims nothing leaves the phone while browsing", () => {
  // sw.js fetches cloud-config.js with cache:"no-store" on EVERY load and
  // revalidates shell assets, so the host sees an IP and a user-agent every
  // time the app opens. The old wording ("שום מידע לא יוצא מהטלפון" / "nothing
  // leaves your phone") was simply false.
  assert.match(swJs, /cloud-config\.js/, "the config fetch is what makes the old claim false");
  assert.match(swJs, /cache:\s*["']no-store["']/, "and it is unconditional, not cached");

  assert.doesNotMatch(flatMd, /שום מידע לא יוצא מהטלפון/, "Hebrew still makes the absolute claim");
  assert.doesNotMatch(flatMd, /nothing leaves your phone/, "English still makes the absolute claim");
  assert.doesNotMatch(flatHtml, /שום מידע לא יוצא מהטלפון/);
  assert.doesNotMatch(flatHtml, /nothing leaves your phone/);

  // And the honest replacement is present in all four places.
  for (const [name, doc] of [["PRIVACY.md", flatMd], ["privacy.html", flatHtml]]) {
    assert.match(doc, /שום נתון שלכם לא יוצא מהטלפון/, `${name} Hebrew states the narrower truth`);
    assert.match(doc, /none of your data leaves your phone/, `${name} English states the narrower truth`);
    assert.match(doc, /כמו כל אתר/, `${name} Hebrew admits the app is fetched like any site`);
    assert.match(doc, /exactly like any website/, `${name} English admits the same`);
  }
});

test("S14: Turnstile is disclosed for backup start, not only the sign-in screens", () => {
  // src/community/auth.js runs signInAnonymously - the account cloud backup
  // opens - inside withCaptcha(), so the captcha loads there too.
  const authJs = fs.readFileSync(new URL("../src/community/auth.js", import.meta.url), "utf8");
  assert.match(authJs, /withCaptcha\(\(captchaToken\)\s*=>\s*\n?\s*client\.auth\.signInAnonymously/,
    "the anonymous backup sign-in still goes through the captcha");
  for (const [name, doc] of [["PRIVACY.md", flatMd], ["privacy.html", flatHtml]]) {
    assert.match(doc, /וגם כשהגיבוי לענן נפתח בפעם הראשונה/, `${name} Hebrew names backup start`);
    assert.match(doc, /also when cloud backup first starts/, `${name} English names backup start`);
  }
});

test("S15: the backup copy does not promise an automatic backup while consent is pending", () => {
  // app.js owns the pending state; cloud.js must branch on it rather than
  // telling a member their next save will be backed up when it will instead
  // show them a card and wait.
  const cloud = cloudSource();
  assert.match(cloud, /window\.haimuniaBackupConsentPending/,
    "cloud.js reads the pending state app.js owns");
  assert.match(cloud, /backupConsentPending\(\)\s*\n?\s*\?/,
    "and branches the copy on it rather than asserting the automatic case");
  assert.match(cloud, /נשאל אתכם על גיבוי לענן אחרי השמירה הבאה/,
    "the pending-state status line says a question is coming, not a backup");
});
