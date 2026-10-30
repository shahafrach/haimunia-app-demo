// Where the e2e tests run, and the guards that keep them off production.
//
// These tests drive the real app against a LOCAL Supabase stack started by
// `supabase start`. They never touch box-log.pages.dev or the box-log Supabase
// project: every address below must be loopback, and the page is pointed at
// a stand-in host (FAKE_ORIGIN) that Playwright answers from the local stack.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "../..");
export const RUN_DIR = path.join(E2E_DIR, ".run");
export const ARTIFACTS_DIR = path.join(E2E_DIR, "artifacts");

// cloud.js only treats a backend as configured when the URL is
// https://<ref>.supabase.co. The local stack is http://127.0.0.1, so the page
// is given this made-up host instead and the test runner answers every request
// to it from the local stack (lib/harness.mjs, routeToLocalStack). cloud.js is
// served byte for byte; nothing in the product is edited for the tests.
export const FAKE_HOST = "e2e-local.supabase.co";
export const FAKE_ORIGIN = "https://" + FAKE_HOST;

// The project ref the shipped index.html allows in its Content-Security-Policy.
// The served copy of index.html has it swapped for FAKE_HOST (lib/server.mjs).
export const SHIPPED_HOST_RE = /[a-z0-9]{20}\.supabase\.co/g;

export const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:54321";
export const DB_URL = process.env.E2E_DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const ANON_KEY = process.env.E2E_ANON_KEY || "";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Exit unless every address is the local stack. Called before anything starts. */
export function assertLocalOnly() {
  const problems = [];
  if (!ANON_KEY) problems.push("E2E_ANON_KEY is not set (run `supabase status -o env` and pass ANON_KEY)");
  for (const [name, value] of [["E2E_API_URL", API_URL], ["E2E_DB_URL", DB_URL]]) {
    let host = "";
    try { host = new URL(value).hostname; } catch (e) { problems.push(`${name} is not a URL`); continue; }
    if (!LOOPBACK.has(host)) problems.push(`${name} points at ${host}, not at this machine`);
  }
  // The shipped project ref and publishable key are production's. Seeing either
  // in the environment means something is wired to the wrong place.
  try {
    const shipped = fs.readFileSync(path.join(REPO_ROOT, "cloud-config.js"), "utf8");
    const key = (shipped.match(/supabasePublishableKey:\s*"([^"]+)"/) || [])[1];
    if (key && ANON_KEY === key) problems.push("E2E_ANON_KEY is the shipped production key");
    for (const ref of shipped.match(SHIPPED_HOST_RE) || []) {
      if ([API_URL, DB_URL].some((v) => v.includes(ref.split(".")[0]))) problems.push("an address names the production project");
    }
  } catch (e) { /* no shipped config to compare with */ }
  if (problems.length) {
    console.error("e2e refuses to start:\n - " + problems.join("\n - "));
    process.exit(2);
  }
}

/** The hosts the page may reach. Anything else is aborted and reported. */
export const FORBIDDEN_HOSTS = [/(^|\.)supabase\.co$/i, /(^|\.)box-log\.pages\.dev$/i, /(^|\.)pages\.dev$/i];
