// migration-status.yml: read-only. Is every migration in supabase/migrations/
// applied on the live project, and does the project have none the repository
// lacks? (docs/club/research.md, "Migration path".) Migrations reach the database
// through the Supabase GitHub integration on merge to main; this is the check
// that it did. It reads supabase_migrations.schema_migrations through the
// Management API's SQL endpoint and changes nothing.
import { readFileSync, readdirSync, appendFileSync } from "node:fs";

export function repoVersions(files) {
  return files.map((f) => /^(\d+)_.+\.sql$/.exec(f)?.[1]).filter(Boolean).sort();
}

/** pending: in the repository, not applied. unknown: applied, not in the repository. */
export function compare(repo, applied) {
  const a = new Set(applied.map(String));
  const r = new Set(repo.map(String));
  return {
    pending: [...r].filter((v) => !a.has(v)).sort(),
    unknown: [...a].filter((v) => !r.has(v)).sort(),
  };
}

export function verdict({ pending, unknown }) {
  if (!pending.length && !unknown.length) return { ok: true, text: "in sync: every repository migration is applied, and nothing else is" };
  const parts = [];
  if (pending.length) parts.push(`PENDING (in the repository, not applied): ${pending.join(", ")}`);
  if (unknown.length) parts.push(`UNKNOWN (applied, not in the repository): ${unknown.join(", ")}`);
  return { ok: false, text: parts.join("\n") };
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const ref = readFileSync(new URL("../supabase/PROJECT_REF", import.meta.url), "utf8").trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "select version from supabase_migrations.schema_migrations order by version" }),
  });
  if (!res.ok) throw new Error(`Management API answered HTTP ${res.status}`);
  const applied = (await res.json()).map((r) => r.version);
  const repo = repoVersions(readdirSync(new URL("../supabase/migrations/", import.meta.url)));
  const v = verdict(compare(repo, applied));
  const line = `${repo.length} in the repository, ${applied.length} applied.\n${v.text}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Migration status\n\n\`\`\`\n${line}\n\`\`\`\n`);
  if (!v.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
