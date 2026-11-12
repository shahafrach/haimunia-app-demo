// auth-launch-limit.yml: owner decision 6. Anonymous sign-ins are allowed 300 an
// hour for launch week (set-auth-config.yml with anon_limit = 300), then 60.
// Every day this reads the live limit; if it is above 60 and the last
// set-auth-config run that raised it finished more than seven days ago, it sets
// 60 and reads it back. Nothing for the owner to remember.
//
// The raise is found by run name: set-auth-config.yml names each run
// "set-auth-config anon_limit=<n>", because the Actions API does not return a
// run's inputs.
import { readFileSync, appendFileSync } from "node:fs";

export const LAUNCH_LIMIT_DAYS = 7;
export const NORMAL_LIMIT = 60;

/** The newest successful run that raised the limit above normal, or null. runs: newest first. */
export function lastRaise(runs) {
  for (const r of runs) {
    const m = /anon_limit=(\d+)/.exec(r.name || r.display_title || "");
    if (r.conclusion !== "success" || !m) continue;
    const n = Number(m[1]);
    if (n > NORMAL_LIMIT) return { limit: n, at: Date.parse(r.updated_at || r.created_at) };
    return null; // the newest limit-setting run already set normal or lower
  }
  return null;
}

/** "lower" | "wait" | "nothing" */
export function decide(current, raise, now) {
  if (!(Number(current) > NORMAL_LIMIT)) return "nothing";
  if (!raise) return "lower"; // above normal with no recorded raise: not a launch, put it back
  return now - raise.at >= LAUNCH_LIMIT_DAYS * 86400e3 ? "lower" : "wait";
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const gh = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const ref = readFileSync(new URL("../supabase/PROJECT_REF", import.meta.url), "utf8").trim();
  const api = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = async () => {
    const res = await fetch(api, { headers: auth });
    if (!res.ok) throw new Error(`GET auth config answered HTTP ${res.status}`);
    return (await res.json()).rate_limit_anonymous_users;
  };
  const current = await read();
  const runsRes = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/set-auth-config.yml/runs?per_page=50`,
    { headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json" } });
  if (!runsRes.ok) throw new Error(`GitHub runs API answered HTTP ${runsRes.status}`);
  const raise = lastRaise((await runsRes.json()).workflow_runs || []);
  const action = decide(current, raise, Date.now());
  let after = current;
  if (action === "lower") {
    const res = await fetch(api, { method: "PATCH", headers: auth, body: JSON.stringify({ rate_limit_anonymous_users: NORMAL_LIMIT }) });
    if (!res.ok) throw new Error(`PATCH auth config answered HTTP ${res.status}`);
    after = await read();
  }
  const line = `anonymous sign-ins per hour: ${current} -> ${after} (${action}${raise ? `, raised to ${raise.limit} on ${new Date(raise.at).toISOString().slice(0, 10)}` : ""})`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Launch sign-in limit\n\n${line}\n`);
  if (action === "lower" && Number(after) !== NORMAL_LIMIT) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
