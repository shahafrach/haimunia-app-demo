// Direct database access for the test runner, as the postgres role, against the
// LOCAL stack only. The owner does the same thing in the Supabase SQL editor to
// start the first circle (docs/ops/FIRST_CIRCLE.md); the tests also read rows back
// to confirm what the screen claims.
import { execFileSync } from "node:child_process";
import { DB_URL } from "./config.mjs";

const SEP = "\u001f";

function runPsql(query) {
  try {
    return execFileSync("psql", [DB_URL, "-X", "-A", "-t", "-F", SEP, "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("psql failed: " + String(e.stderr || e.message).trim());
  }
  // No psql on this machine: go through the database container of the local stack.
  const id = execFileSync("docker", ["ps", "--filter", "name=supabase_db_", "--format", "{{.ID}}"], { encoding: "utf8" }).trim().split("\n")[0];
  if (!id) throw new Error("no psql and no supabase_db container");
  return execFileSync("docker", ["exec", "-i", id, "psql", "-U", "postgres", "-X", "-A", "-t", "-F", SEP, "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" });
}

/** Rows as arrays of strings. */
export function sql(query) {
  return runPsql(query).split("\n").filter((l) => l.length).map((l) => l.split(SEP));
}
/** First column of the first row, or null. */
export function one(query) {
  const rows = sql(query);
  return rows.length ? rows[0][0] : null;
}
export function count(query) { return Number(one(query) || 0); }

/** The owner's first-circle link, minted exactly the way FIRST_CIRCLE.md says. */
export function bootstrapToken() {
  const link = one("select public.bootstrap_owner_invite()");
  const m = /#invite=([a-f0-9]{64})/.exec(link || "");
  if (!m) throw new Error("bootstrap_owner_invite() returned " + JSON.stringify(link));
  return m[1];
}

export const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export const userId = (username) => one(`select id from auth.users where email = ${q(username + "@members.haimuniya.invalid")}`);
