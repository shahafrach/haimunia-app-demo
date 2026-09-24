// The "קובץ גיבוי להורדה" card in Settings, and the file it downloads.
//
// import-export-ui.test.mjs already drives the ייצוא גיבוי click and checks
// that the export TIME is recorded. What nothing opened was the file itself:
// the card's own copy promises the full training log, the member's custom
// movements and WODs, bodyweight and measurements - "בלי השם שלכם ובלי
// הגדרות" - and every one of those halves is a claim about the payload. This
// file catches the Blob the real button hands the browser and reads it.
//
// Server-side "download my data" (cloud.js, S16) is a different file with a
// different promise and lives in self-export.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, waitFor } from "./helpers/boot.mjs";

// jsdom has no URL.createObjectURL, so downloadBackup() would return false
// and produce nothing. Stub it to capture the Blob and the anchor's filename -
// exactly the two things a real browser turns into the downloaded file.
function captureDownloads(window) {
  const got = [];
  window.URL.createObjectURL = (blob) => { got.push({ blob }); return `blob:test/${got.length}`; };
  window.URL.revokeObjectURL = () => {};
  const origClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    if (this.download && got.length) got[got.length - 1].filename = this.download;
    else return origClick.call(this);
  };
  return got;
}
async function readJson(blob) {
  return JSON.parse(await blob.text());
}
async function openSettingsCard(window) {
  window.openSettings();
  await waitFor(() => !!window.document.querySelector("[data-action='export-data']"), 2000);
}

test("the card is in Settings, titled as a file to download, with export and import side by side", async () => {
  const window = await bootApp();
  await openSettingsCard(window);
  const exportBtn = window.document.querySelector("[data-action='export-data']");
  const block = exportBtn.closest(".settings-block");
  assert.ok(block, "the export button lives in a settings block");
  assert.equal(block.querySelector(".settings-block-title").textContent.trim(), "קובץ גיבוי להורדה");
  assert.ok(block.querySelector("[data-action='import-data']"), "import sits on the same card");
});

test("ייצוא גיבוי downloads one dated JSON file holding every record group", async () => {
  const window = await bootApp();
  const got = captureDownloads(window);
  await window.addMovement("Settings Export Squat", "Squat");
  window.applyFieldValue("step", "weight", 60);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  await window.saveSessionNote("2026-09-01", "שורה ראשונה\nשורה שנייה");

  await openSettingsCard(window);
  window.document.querySelector("[data-action='export-data']").click();
  await waitFor(() => got.length === 1 && got[0].filename, 2000);

  assert.match(got[0].filename, /^box-log-backup-\d{4}-\d{2}-\d{2}\.json$/, "a dated .json filename");
  assert.equal(got[0].blob.type, "application/json");
  const data = await readJson(got[0].blob);
  assert.equal(data.app, "box-log", "carries the app id import checks for");
  assert.equal(data.version, 1);
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)), "exportedAt is a real timestamp");
  for (const key of ["entries", "customMovements", "wodEntries", "customWods", "bodyweightEntries", "measureTypes", "measureEntries"]) {
    assert.ok(Array.isArray(data[key]), `${key} is in the file as an array`);
  }
  assert.ok(data.customMovements.some((m) => m.name === "Settings Export Squat"), "the member's custom movement is in it");
  assert.ok(data.entries.some((e) => Number(e.weight) === 60 && Number(e.reps) === 5), "the logged set is in it");
  assert.equal(data.sessionNotes["2026-09-01"], "שורה ראשונה\nשורה שנייה",
    "session notes are training-log content and keep their line breaks");
});

test("the file keeps the card's promise: no name, no settings", async () => {
  const window = await bootApp();
  const got = captureDownloads(window);
  window.saveUserName("דנה ישראלי");
  await window.dbSetSetting("haimunia-demo:barWeight", 15);
  await openSettingsCard(window);
  window.document.querySelector("[data-action='export-data']").click();
  await waitFor(() => got.length === 1 && got[0].filename, 2000);

  const raw = await got[0].blob.text();
  assert.ok(!raw.includes("דנה ישראלי"), "the member's name is not anywhere in the file");
  const data = JSON.parse(raw);
  assert.deepEqual(Object.keys(data).sort(), [
    "app", "bodyweightEntries", "customMovements", "customWodMovementTags", "customWods", "entries",
    "exportedAt", "measureEntries", "measureTypes", "sessionNotes", "version", "wodEntries",
  ], "exactly the documented groups - a new top-level key has to be a decision, not an accident");
  assert.ok(!/barWeight|userName|theme|clubFeatures/.test(raw), "no settings rows ride along");
});

test("the exported file imports back into a fresh device", async () => {
  const source = await bootApp();
  const got = captureDownloads(source);
  await source.addMovement("Round Trip Row", "Pull");
  await openSettingsCard(source);
  source.document.querySelector("[data-action='export-data']").click();
  await waitFor(() => got.length === 1 && got[0].filename, 2000);
  const text = await got[0].blob.text();

  const target = await bootApp();
  await target.importDataFromFile({ size: text.length, text: async () => text });
  const movements = await target.dbLoadMovements();
  assert.ok(movements.some((m) => m.name === "Round Trip Row"), "what Settings exports, Settings can import");
});

test("the cloud panel's download reports failure honestly and does not mark a backup it never made", async () => {
  const window = await bootApp();
  // No createObjectURL - the jsdom default, and a real old browser.
  delete window.URL.createObjectURL;
  const ok = await window.haimuniaExportBackup();
  assert.equal(ok, false, "no file was produced, and the caller is told so");
  assert.equal(await window.dbGetSetting("haimunia-demo:lastExportAt"), undefined,
    "the stale-backup reminder must keep nagging when nothing was downloaded");

  const got = captureDownloads(window);
  assert.equal(await window.haimuniaExportBackup(), true);
  assert.equal(got.length, 1, "with a download path it produces exactly one file");
  const stored = await window.dbGetSetting("haimunia-demo:lastExportAt");
  assert.ok(typeof stored === "number" && stored > 0, "and records the export time");
});
