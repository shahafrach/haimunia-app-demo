// Launch-readiness audit B5: a backup-only member could not delete their data.
//
// PRIVACY.md tells a member that removing backed-up data means requesting
// account deletion, and that the app lets them. The only button for it was in
// the Community account tab, which needs a profile - a backup-only member
// (an anonymous account, no profile) got the join form there instead, and the
// backup card in Settings had no delete action at all.
//
// These drive window.handleCommunityClick, cloud.js's real action handler,
// the same way community-error-copy.test.mjs drives the backup opt-out.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

function backupOnlyMember(rpcResult) {
  const mock = createMockSupabase();
  mock.setUser({ id: "anon-backup-1", is_anonymous: true, created_at: new Date().toISOString() });
  mock.onRpc("request_account_deletion", () => rpcResult || { data: null, error: null });
  return mock;
}

async function bootedPanel(mock) {
  const window = await bootCommunity(mock, { syncEnabled: true });
  await waitFor(() => typeof window.renderBackupSettingsPanel === "function"
    && /מחיקת הגיבוי מהענן/.test(window.renderBackupSettingsPanel()), 3000);
  return window;
}

const tap = (window, action) => window.handleCommunityClick({ dataset: { communityAction: action } });

test("a backup-only member (anonymous, no profile) sees a delete action on the backup card", async () => {
  const window = await bootedPanel(backupOnlyMember());
  const panel = window.renderBackupSettingsPanel();
  assert.match(panel, /data-community-action="backup-delete"/);
});

test("the first tap only asks; it says what goes, what stays and when, and cancel backs out", async () => {
  const mock = backupOnlyMember();
  const window = await bootedPanel(mock);
  tap(window, "backup-delete");
  const asking = window.renderBackupSettingsPanel();
  assert.match(asking, /data-community-action="backup-delete-confirm"/);
  assert.match(asking, /30 יום/, "says when");
  assert.match(asking, /האימונים שבמכשיר הזה נשארים/, "says the local log is not touched");
  assert.equal(mock.callsTo("request_account_deletion").length, 0, "nothing is requested before the confirm");
  tap(window, "backup-delete-cancel");
  assert.doesNotMatch(window.renderBackupSettingsPanel(), /backup-delete-confirm/);
});

test("confirming calls the existing request_account_deletion(), switches backup off, and signs out", async () => {
  const mock = backupOnlyMember();
  const window = await bootedPanel(mock);
  tap(window, "backup-delete");
  tap(window, "backup-delete-confirm");
  await waitFor(() => mock.getUser() === null, 3000);
  assert.equal(mock.callsTo("request_account_deletion").length, 1, "the same RPC the account tab uses, once");
  assert.equal(window.localStorage.getItem("haimunia-demo:backupOptOut"), "1",
    "backup is opted out, so the next save cannot open a fresh anonymous account and undo the request");
  await waitFor(() => !!window.document.getElementById("appToastBar"), 3000);
  assert.match(window.document.getElementById("appToastBar").textContent, /30 יום/);
});

test("a failed request says so on the card and keeps the session and the backup", async () => {
  const mock = backupOnlyMember({ data: null, error: { message: "network down" } });
  const window = await bootedPanel(mock);
  tap(window, "backup-delete");
  tap(window, "backup-delete-confirm");
  await waitFor(() => /בקשת המחיקה נכשלה/.test(window.renderBackupSettingsPanel()), 3000);
  assert.ok(mock.getUser(), "still signed in");
  assert.notEqual(window.localStorage.getItem("haimunia-demo:backupOptOut"), "1", "backup untouched");
});

test("the Community tab's delete goes through the same function, so it switches backup off too", () => {
  const body = cloudJs.slice(cloudJs.indexOf("async function requestDeletion()"));
  const fn = body.slice(0, body.indexOf("\n  }\n"));
  assert.match(fn, /rpc\("request_account_deletion"\)/);
  assert.match(fn, /localStorage\.setItem\(BACKUP_OPTOUT_KEY, "1"\)/);
  assert.ok(fn.indexOf("BACKUP_OPTOUT_KEY") < fn.indexOf("signOut"), "opted out before the session ends");
  assert.match(cloudJs, /c\.action === "delete-account"\) requestDeletion\(\)/);
  assert.match(cloudJs, /action === "backup-delete-confirm"\) \{[^}]*requestDeletion\(\)/);
});
