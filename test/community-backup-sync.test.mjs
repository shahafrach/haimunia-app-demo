// iOS Safari evicts a site's IndexedDB after ~7 days without a visit, and
// until now the only path to cloud backup ran through the Community tab's
// full invite-code join flow - so anyone who never touched Community had
// zero protection. This adds a second, independent path: a backup-only
// anonymous session that starts itself the first time a member actually
// saves something (not on page load - an empty visit creating a cloud
// account has no upside), auto-enables forward sync with no click, and
// stays entirely decoupled from posting/feed/profile/invite codes. See
// COMMUNITY_SETUP.md's "Offline synchronization" section and PRIVACY.md.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const privacyMd = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");

test("maybeAutoStartBackup only fires when there's no session yet, the member hasn't opted out, and consent has actually been asked - and is wired to the sync-needed event (not page load)", () => {
  // The first two guards are unchanged. The third landed with the first-run
  // sequence (c4cd505): consent is asked AFTER the member's first saved
  // entry, but this function fires ON that same first write - so without the
  // guard an anonymous account already existed by the time the card appeared,
  // and "לא עכשיו" was answering a question the app had already answered for
  // them. The screen would promise something the code broke, which is the
  // defect class this audit kept finding (see a42f9d1's account-security
  // screen, which claimed browse-only access the database refused).
  //
  // Asserted as three separate guards rather than one whitespace-exact block,
  // because the previous single-regex form pinned the function's LAYOUT and
  // broke on a comment - which tells you nothing about behaviour. Each of
  // these is a real precondition and each can now fail independently.
  const fn = cloudJs.match(/function maybeAutoStartBackup\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, "maybeAutoStartBackup must exist");
  assert.match(fn[0], /if \(!client \|\| state\.user \|\| backupOptedOut\(\)\) return;/,
    "still refuses without a client, with a session, or after an opt-out");
  assert.match(fn[0], /window\.haimuniaBackupConsentPending\(\)\) return;/,
    "and must not create an anonymous account while the consent card is still unanswered");
  assert.match(fn[0], /ensureAnonymousSession\(\);/, "otherwise it starts the session");
  // "not asked yet" and "asked and declined" are deliberately different
  // states: collapsing them would make a member who has never seen the card
  // indistinguishable from one who said no.
  assert.match(appJs, /window\.haimuniaBackupConsentPending = function \(\) \{ return backupConsent === null; \};/,
    "pending means unanswered, not declined");
  assert.match(cloudJs, /window\.addEventListener\("haimunia-sync-needed", \(\) => \{ maybeAutoStartBackup\(\); flushOutbox\(\); \}\);/);
});

test("enableSyncIfAllowed only turns sync on, never off, and respects the opt-out", () => {
  const fn = cloudJs.slice(cloudJs.indexOf("function enableSyncIfAllowed"), cloudJs.indexOf("function maybeAutoStartBackup"));
  assert.match(fn, /if \(state\.syncEnabled \|\| backupOptedOut\(\)\) return;/);
  assert.match(fn, /state\.syncEnabled = true;/);
});

test("enableSyncIfAllowed runs on both session-hydration paths (refreshSession and onAuthStateChange), not just one", () => {
  const refreshSessionBody = cloudJs.slice(cloudJs.indexOf("async function refreshSession"), cloudJs.indexOf("async function loadProfile()"));
  assert.match(refreshSessionBody, /enableSyncIfAllowed\(\);/);
  const authChangeBody = cloudJs.slice(cloudJs.indexOf('client.auth.onAuthStateChange'), cloudJs.indexOf('refreshSession();'));
  assert.match(authChangeBody, /enableSyncIfAllowed\(\);/);
});

test("backup-only bootstrap never touches invite codes, redemption, or profiles - purely private_records via the outbox", () => {
  const start = cloudJs.indexOf("function maybeAutoStartBackup");
  const fn = cloudJs.slice(start, cloudJs.indexOf("\n  }\n", start) + 5);
  assert.doesNotMatch(fn, /redeem_invite_code|invite_redemptions|profiles/);
});

test("Settings exposes an on/off toggle for automatic backup, fully independent of joining Community", () => {
  assert.match(cloudJs, /window\.renderBackupSettingsPanel = function/);
  const fn = cloudJs.slice(cloudJs.indexOf("window.renderBackupSettingsPanel = function"), cloudJs.indexOf("window.renderBackupSettingsPanel = function") + 2000);
  assert.match(fn, /data-community-action="backup-enable"/);
  assert.match(fn, /data-community-action="backup-optout"/);
  // Never an invite code or a feed/profile reference - this panel must
  // stand on its own, never look like the same action as joining Community.
  assert.doesNotMatch(fn, /קוד הזמנה|invite/);
});

test("backup-enable clears the opt-out and starts or resumes sync; backup-optout remembers the choice and stops future syncing", () => {
  assert.match(cloudJs, /action === "backup-enable"\) \{\s*\n\s*localStorage\.removeItem\(BACKUP_OPTOUT_KEY\);/);
  assert.match(cloudJs, /action === "backup-optout"\) \{\s*\n\s*localStorage\.setItem\(BACKUP_OPTOUT_KEY, "1"\);/);
});

test("the anonymous backup session and the Community join flow use the same underlying session without duplicating it", () => {
  // The Community tab's login-or-start gate has to keep showing for a
  // backup-only anonymous session (is_anonymous, signupStarted still
  // false, and no redemption on file either) rather than skipping straight
  // past it as if start-signup had been clicked. Live bug hunt
  // (2026-09-11) widened the condition to also fall through for a
  // CONFIRMED server-side redemption (state.redemption) - a backup-only
  // session has none, so it is unaffected and still hits this same gate.
  const ui = fs.readFileSync(new URL("../src/community/circles-ui.js", import.meta.url), "utf8");
  assert.match(ui, /if \(!state\.user \|\| \(state\.user\.is_anonymous && !state\.signupStarted && !state\.redemption && !inAny\)\) \{/);
});

test("setCredentials (the anonymous-to-permanent-account upgrade) is reusable from the standalone backupCredentials form in Settings, not only the Community onboarding gate", () => {
  assert.match(cloudJs, /event\.target\.id === "backupCredentials"\) \{ event\.preventDefault\(\); setCredentials\(event\.target\); \}/);
});

test("navigator.storage.persist() is requested at boot, best-effort", () => {
  assert.match(appJs, /navigator\.storage && navigator\.storage\.persist/);
  assert.match(appJs, /navigator\.storage\.persist\(\)\.catch/);
});

test("an iOS-specific install banner exists, independent of the Chrome/Android beforeinstallprompt banner", () => {
  assert.match(appJs, /function isIOSDevice\(\)/);
  assert.match(appJs, /function maybeShowIOSInstallBanner\(\)/);
  assert.match(appJs, /if \(!isIOSDevice\(\) \|\| isStandalone\(\)\) return;/);
});

test("the stale-local-export reminder threshold tightens for anyone not already covered by automatic cloud sync", () => {
  const fn = appJs.slice(appJs.indexOf("function renderSettingsBody"), appJs.indexOf("function renderSettingsBody") + 1200);
  assert.match(fn, /window\.cloudSyncActive/);
  assert.match(fn, /cloudCovered \? 30 : 5/);
});

// PRIVACY.md (English) and privacy.html (Hebrew, the text members read) carry
// the same backup promises: automatic and private, begins at the first saved
// workout, asks first on a device that shows the card, reversible in
// Settings, unrecoverable if it is an anonymous account and the device is
// lost, and an empty backup-only account is the only thing the 30-day clean-up
// closes. Matched on whitespace-normalised copies; phrases are verbatim.
const privacyText = privacyMd.replace(/\s+/g, " ");
const privacyHtmlText = fs.readFileSync(new URL("../privacy.html", import.meta.url), "utf8").replace(/\s+/g, " ");

test("the privacy pages disclose the backup account: first save, asks first, reversible, unrecoverable, empty-only clean-up - in Hebrew", () => {
  assert.match(privacyHtmlText, /הגיבוי לענן מתחיל באימון הראשון שאתם שומרים/);
  assert.match(privacyHtmlText, /עד שאתם עונים, האפליקציה לא פותחת עבורכם חשבון גיבוי ולא מעלה שום רשומה/);
  assert.match(privacyHtmlText, /אם כבר נכנסתם למעגל עם קישור הזמנה, חשבון כבר נפתח לכם באותה כניסה/);
  assert.match(privacyHtmlText, /אפשר לכבות או להפעיל בכל רגע בהגדרות/);
  assert.match(privacyHtmlText, /אם תאבדו את המכשיר או תמחקו את נתוני הדפדפן/);
  assert.match(privacyHtmlText, /אף אחד — גם לא אנחנו — לא יוכל לשחזר אותו עבורכם/);
  assert.match(privacyHtmlText, /חשבון גיבוי בלבד וריק נסגר אחרי 30 יום/);
  assert.match(privacyHtmlText, /אם שמרתם אליו ולו אימון אחד — הוא לא נמחק/);
});

test("the privacy pages disclose the backup account - in English", () => {
  assert.match(privacyText, /Cloud backup starts at the first workout you save/);
  assert.match(privacyText, /until you answer, the app opens no backup account for you and uploads no record/i);
  assert.match(privacyText, /If you have already joined a circle with an invite link, an account was opened for you at that step/);
  assert.match(privacyText, /turn it off or on at any time in Settings/);
  assert.match(privacyText, /if you lose this device or clear its data, nobody — including us — can restore it to you/i);
  assert.match(privacyText, /An empty backup-only account is closed after 30 days/);
  assert.match(privacyText, /If you have saved even one workout to it, it is not deleted/);
  assert.match(privacyText, /set a username and password/);
});

test("the retired claims cannot return to either privacy file", () => {
  for (const text of [privacyText, privacyHtmlText]) {
    assert.doesNotMatch(text, /automatically, without asking first/i);
    assert.doesNotMatch(text, /a backup-only account is deleted after 30 days/i);
    assert.doesNotMatch(text, /along with everything backed up to it/i);
    assert.doesNotMatch(text, /חשבון גיבוי בלבד נמחק אחרי 30 יום/);
    assert.doesNotMatch(text, /אוטומטית, בלי לשאול אתכם קודם/);
  }
});
