// Reads the unread rows of public.bug_reports through the Supabase Management API and prints them as JSON
// between FEEDBACK-BEGIN and FEEDBACK-END. With MARK_READ=true it then sets read_at on exactly those ids.
// Used by .github/workflows/feedback-inbox.yml. Needs SUPABASE_ACCESS_TOKEN and supabase/PROJECT_REF.
// The reporter's id and the device facts are never selected.
import { readFileSync, appendFileSync } from "node:fs";

export function clampLimit(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 50;
}
export function selectSql(limit) {
  return `select id, created_at, status, tag, left(body, 4000) as body, diagnostics->>'app_version' as app_version
    from public.bug_reports where read_at is null order by created_at limit ${clampLimit(limit)}`;
}
export function markSql(ids) {
  const safe = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(String(id)));
  if (!safe.length) return null;
  return `update public.bug_reports set read_at = now() where read_at is null and id in (${safe.map((i) => `'${i}'`).join(",")})`;
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
  const ref = readFileSync(new URL("../supabase/PROJECT_REF", import.meta.url), "utf8").trim();
  const rows = await query(ref, token, selectSql(process.env.LIMIT));
  const out = JSON.stringify(rows, null, 2);
  console.log("FEEDBACK-BEGIN\n" + out + "\nFEEDBACK-END");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Unread feedback (${rows.length})\n\n\`\`\`json\n${out}\n\`\`\`\n`);
  }
  if (process.env.MARK_READ === "true" && rows.length) {
    const sql = markSql(rows.map((r) => r.id));
    if (sql) await query(ref, token, sql);
    console.log(`Marked ${rows.length} as read.`);
  } else {
    console.log("Left unread (mark_read was not true).");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
