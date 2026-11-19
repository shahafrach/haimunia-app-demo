// request-reset (F19, 2026-11-10) is OFF since Q-38e (2026-11-18, owner): a reset with no proof is an account
// takeover, since anyone who knew a username could take the account after the hour. Recovery is a passkey,
// the recovery code, or a new account. Both actions answer 410, so a request opened before the switch can no
// longer complete. What stays pinned: the switch itself, and that the function is still deployed (an old app
// that calls it gets a clear answer, not a 404 that looks like an outage).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { handleResetRequest, handleRecover, RESET_REQUEST_DISABLED } from "../supabase/functions/_shared/recovery.mjs";

const SECRET = "test-secret-not-a-real-one";
const untouched = new Proxy({}, { get: () => () => { throw new Error("the store must not be touched"); } });

test("both actions answer 410 reset_disabled and touch nothing", async () => {
  assert.equal(RESET_REQUEST_DISABLED, true);
  for (const body of [
    { action: "request", username: "dana" },
    { action: "complete", username: "dana", request_token: "c".repeat(64), new_password: "Newpassw0rd!" },
    {}, null,
  ]) {
    assert.deepEqual(await handleResetRequest({ body, ip: "203.0.113.7" }, { secret: SECRET, store: untouched }), { status: 410, body: { error: "reset_disabled" } });
  }
});

test("the recovery code path is a different handler and is not switched off", () => {
  assert.equal(typeof handleRecover, "function");
  const src = fs.readFileSync(new URL("../supabase/functions/_shared/recovery.mjs", import.meta.url), "utf8");
  const recover = src.slice(src.indexOf("export async function handleRecover"), src.indexOf("// ---- Lost recovery code"));
  assert.doesNotMatch(recover, /RESET_REQUEST_DISABLED|reset_disabled/);
});

test("the Edge Function is still wired and deployed, so an old app gets the clear 410", () => {
  const src = fs.readFileSync(new URL("../supabase/functions/request-reset/index.ts", import.meta.url), "utf8");
  assert.match(src, /handleResetRequest\(\{ body, ip \}/);
  const cfg = fs.readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(cfg, /\[functions\.request-reset\]\s*\nverify_jwt = false/);
  const deploy = fs.readFileSync(new URL("../.github/workflows/deploy-edge-functions.yml", import.meta.url), "utf8");
  assert.match(deploy, /options: \[[^\]]*request-reset[^\]]*\]/);
});

test("BOX-LOG's forgot screen no longer offers the self-service reset", () => {
  const ui = fs.readFileSync(new URL("../src/community/recovery.js", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /data-community-action="recovery-lost-open">/, "no button opens it");
});
