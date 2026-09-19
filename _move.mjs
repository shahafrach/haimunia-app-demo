// node _move.mjs <module> <headerFile> <namesFile>
// Moves the named top-level units out of cloud.js into src/community/<module>.js,
// wires index.html, sw.js and test/helpers/community-src.mjs, and proves nothing
// was lost or altered: every moved line must appear in the new file, byte-identical.
import fs from "node:fs";

const DECL = /^  (?:(?:async )?function|const|let|var) ([A-Za-z0-9_$]+)\s*[=(]/;
function parseUnits(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL);
    if (m) units.push({ name: m[1], start: i + 1, kind: /^  (?:async )?function /.test(lines[i]) ? "fn" : "var" });
  }
  for (const u of units) { let s = u.start; while (s - 2 >= 0 && /^\s*\/\//.test(lines[s - 2])) s--; u.cstart = s; }
  for (let i = 0; i < units.length; i++) units[i].end = i + 1 < units.length ? units[i + 1].cstart - 1 : lines.length;
  return { lines, units };
}

const [, , mod, headerFile, namesFile] = process.argv;
const names = fs.readFileSync(namesFile, "utf8").split(/\s+/).filter(Boolean);
const { lines, units } = parseUnits("cloud.js");
const byName = new Map();
for (const u of units) {
  if (byName.has(u.name)) throw new Error(`duplicate top-level name in cloud.js: ${u.name}`);
  byName.set(u.name, u);
}
const picked = names.map((n) => { const u = byName.get(n); if (!u) throw new Error(`no top-level unit named ${n}`); return u; });
picked.sort((a, b) => a.cstart - b.cstart);

// contiguous runs keep their exact text, including the blank lines between them
const runs = [];
for (const p of picked) {
  const last = runs[runs.length - 1];
  if (last && p.cstart === last.end + 1) last.end = p.end;
  else runs.push({ start: p.cstart, end: p.end });
}
const moved = [];
runs.forEach((r, i) => {
  if (i) moved.push("");
  for (let ln = r.start; ln <= r.end; ln++) moved.push(lines[ln - 1]);
});
// a unit's range runs up to the next unit's comment block, so trailing blank
// lines belong to the gap, not to the unit
while (moved.length && moved[moved.length - 1].trim() === "") moved.pop();

const header = fs.readFileSync(headerFile, "utf8").replace(/\n+$/, "");
fs.writeFileSync(`src/community/${mod}.js`, header + "\n\n" + moved.join("\n") + "\n");

const drop = new Set();
for (const r of runs) for (let ln = r.start; ln <= r.end; ln++) drop.add(ln);
const removed = lines.filter((_, i) => drop.has(i + 1));
let kept = lines.filter((_, i) => !drop.has(i + 1));
const collapsed = [];
for (const l of kept) {
  if (l.trim() === "" && collapsed.length && collapsed[collapsed.length - 1].trim() === "") continue;
  collapsed.push(l);
}
fs.writeFileSync("cloud.js", collapsed.join("\n"));

// PROOF: every non-blank line removed from cloud.js appears, byte-identical and
// the same number of times, in the new module file.
const count = (arr) => arr.reduce((m, l) => (l.trim() ? m.set(l, (m.get(l) || 0) + 1) : m), new Map());
const a = count(removed), b = count(moved);
for (const [l, n] of a) if (b.get(l) !== n) throw new Error(`line lost or changed (${n} removed, ${b.get(l) || 0} written):\n${l}`);
for (const [l, n] of b) if (a.get(l) !== n) throw new Error(`line invented (${n} written, ${a.get(l) || 0} removed):\n${l}`);
console.log(`${mod}: ${picked.length} units in ${runs.length} run(s), ${removed.length} lines moved; cloud.js ${lines.length} -> ${collapsed.length}`);

// --- wiring -------------------------------------------------------------
const rel = `./src/community/${mod}.js`;
let html = fs.readFileSync("index.html", "utf8");
const anchor = '<script defer src="./cloud.js"></script>';
if (!html.includes(`src="${rel}"`)) {
  if (!html.includes(anchor)) throw new Error("index.html anchor missing");
  html = html.replace(anchor, `<script defer src="${rel}"></script>\n` + anchor);
  fs.writeFileSync("index.html", html);
}
let sw = fs.readFileSync("sw.js", "utf8");
const swAnchor = '  "./cloud.js",';
if (!sw.includes(`"${rel}"`)) {
  if (!sw.includes(swAnchor)) throw new Error("sw.js anchor missing");
  sw = sw.replace(swAnchor, `  "${rel}",\n` + swAnchor);
  fs.writeFileSync("sw.js", sw);
}
console.log("wired index.html and sw.js (the test helper reads index.html itself)");
