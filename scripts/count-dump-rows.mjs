// Rows per table in a pg_dump --data-only file of INSERT statements, as the restore drill needs them
// (Q-50, backup-database.yml): the drill restores the dump and then asserts that every table holds
// exactly this many rows. `supabase db dump --data-only` writes multi-row INSERTs, so counting
// statements is not counting rows; this walks the VALUES list and counts its top-level tuples,
// skipping parentheses inside string literals ('' is an escaped quote).
//
// Usage: node scripts/count-dump-rows.mjs data.sql  ->  one "schema.table<TAB>rows" line per table.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HEAD = /INSERT INTO "([^"]+)"\."([^"]+)"(?:\s*\([^)]*\))?\s*VALUES\s*/gy;

/** Map of "schema.table" -> rows. */
export function countDumpRows(sql) {
  const counts = new Map();
  let i = 0;
  while (i < sql.length) {
    const at = sql.indexOf("INSERT INTO ", i);
    if (at < 0) break;
    HEAD.lastIndex = at;
    const m = HEAD.exec(sql);
    if (!m) { i = at + 12; continue; }
    const key = `${m[1]}.${m[2]}`;
    let j = HEAD.lastIndex;
    let depth = 0;
    let rows = 0;
    let inStr = false;
    for (; j < sql.length; j++) {
      const c = sql[j];
      if (inStr) {
        if (c === "'") {
          if (sql[j + 1] === "'") j++;
          else inStr = false;
        }
        continue;
      }
      if (c === "'") inStr = true;
      else if (c === "(") { if (depth === 0) rows++; depth++; }
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) break;
    }
    if (inStr || depth !== 0) throw new Error(`unterminated INSERT into ${key}`);
    counts.set(key, (counts.get(key) || 0) + rows);
    i = j + 1;
  }
  return counts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: count-dump-rows.mjs <data.sql>"); process.exit(2); }
  for (const [k, n] of [...countDumpRows(readFileSync(file, "utf8"))].sort()) console.log(`${k}\t${n}`);
}
