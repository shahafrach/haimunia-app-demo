// club-admin.yml: the owner's club actions, run through the Supabase Management
// API's SQL endpoint with the existing SUPABASE_ACCESS_TOKEN (docs/club/research.md,
// section C). The functions it calls are granted to no role; the Management API
// runs as the database owner.
//
// The repository is public, so its workflow logs are public. A username never
// reaches SQL, a log or the step summary: it is masked in the workflow, hashed
// here, and sent as 'sha256:<hex>', which owner_user_by_name() accepts. Output
// is the function's one-word status, or totals only (usage_report).
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const ACTIONS = ["create_club", "set_coach", "set_owner", "usage_report"];
export const CLUB_NAME = "האימוניה";

export function whoRef(username) {
  const u = String(username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(u)) throw new Error("the username is 3 to 24 of a-z, 0-9 and _");
  return "sha256:" + createHash("sha256").update(u).digest("hex");
}

/** The one SQL statement for an action. Only a hash and fixed text are interpolated. */
export function actionSql(action, username) {
  switch (action) {
    case "create_club": return `select public.owner_create_club('${whoRef(username)}', '${CLUB_NAME}') as status`;
    case "set_coach": return `select public.owner_set_coach('${whoRef(username)}') as status`;
    case "set_owner": return `select public.owner_set_club_owner('${whoRef(username)}') as status`;
    case "usage_report": return "select public.training_log_usage_report(12) as status";
    default: throw new Error(`unknown action; use one of ${ACTIONS.join(", ")}`);
  }
}

/** create_club succeeds on created or exists; the owner functions on set or already. */
export function isSuccess(action, status) {
  if (action === "usage_report") return status != null && typeof status === "object";
  if (action === "create_club") return status === "created" || status === "exists";
  return status === "set" || status === "already";
}

async function query(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API answered HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const action = process.env.ACTION;
  const sql = actionSql(action, action === "usage_report" ? "" : process.env.WHO);
  const ref = readFileSync(new URL("../supabase/PROJECT_REF", import.meta.url), "utf8").trim();
  const rows = await query(ref, token, sql);
  const status = rows?.[0]?.status ?? null;
  const shown = typeof status === "object" ? JSON.stringify(status, null, 2) : String(status);
  console.log(`${action}: ${shown}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## club-admin: ${action}\n\n\`\`\`\n${shown}\n\`\`\`\n`);
  }
  if (!isSuccess(action, status)) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
