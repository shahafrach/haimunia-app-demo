// Every Edge Function needs two files nobody thinks about until a deploy
// fails: deno.json and deno.lock.
//
// deploy-edge-functions.yml runs `deno cache --frozen --lock=deno.lock` for
// each function before deploying any of them, so a function added without a
// lockfile fails the whole workflow - including the deploys of the functions
// that were fine. And deno.json is not optional either: without it Deno walks
// up to the repo's package.json, treats the function as part of that
// workspace, and writes the NODE test suite's dependencies into deno.lock,
// which then fails --frozen every time package.json moves. That is a real
// outage this repo already had; the reason is written out in each deno.json.
//
// notif_push_send was written without either of them (2026-09-17). Caught by
// reading the workflow rather than by the workflow, which is luck, not a
// process - hence this file.
import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, existsSync, readFileSync } from "node:fs";

const dir = new URL("../supabase/functions/", import.meta.url);
const functions = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "_shared")
  .map((e) => e.name)
  .filter((name) => existsSync(new URL(`${name}/index.ts`, dir)));

test("there are functions to check", () => {
  assert.ok(functions.length >= 2, `expected the Edge Functions, found ${JSON.stringify(functions)}`);
});

for (const name of functions) {
  test(`${name} ships the two files its deploy needs`, () => {
    assert.ok(existsSync(new URL(`${name}/deno.json`, dir)),
      `${name}/deno.json is missing - Deno will walk up to the repo package.json and lock the wrong dependencies`);
    assert.ok(existsSync(new URL(`${name}/deno.lock`, dir)),
      `${name}/deno.lock is missing - \`deno cache --frozen\` fails, and it takes every other function's deploy with it`);
  });
}

test("functions importing only supabase-js share one lockfile, byte for byte", () => {
  // Not a style rule: it is how a new function can be given a correct lock
  // without running Deno. The moment one of them takes a different
  // dependency this assertion should fail and be replaced with a real
  // `deno cache` run, not deleted.
  const simple = functions.filter((name) => {
    const src = readFileSync(new URL(`${name}/index.ts`, dir), "utf8");
    const remote = [...src.matchAll(/^import .* from "(https?:[^"]+)"/gm)].map((m) => m[1]);
    return remote.length === 1 && remote[0] === "https://esm.sh/@supabase/supabase-js@2.57.4";
  });
  assert.ok(simple.length >= 2, `expected several single-dependency functions, found ${simple.length}`);
  const locks = new Set(simple.map((name) => readFileSync(new URL(`${name}/deno.lock`, dir), "utf8")));
  assert.equal(locks.size, 1,
    "these functions import exactly the same one module and must resolve to the same lock; "
    + `they do not: ${simple.join(", ")}`);
});
