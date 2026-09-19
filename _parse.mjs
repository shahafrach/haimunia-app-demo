// Top-level units of cloud.js, by indentation rather than brace matching.
//
// Every top-level declaration in this file sits at exactly two spaces of
// indent; everything inside one sits deeper. So the declaration lines alone
// are the boundaries: a unit runs from its own comment block down to the line
// before the next unit's comment block. No brace/string/regex scanning, which
// is what a hand-rolled matcher gets wrong on one-line functions and on
// template literals full of Hebrew apostrophes.
import fs from "node:fs";

const DECL = /^  (?:(?:async )?function|const|let|var) ([A-Za-z0-9_$]+)\s*[=(]/;

export function parseUnits(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL);
    if (m) starts.push({ name: m[1], start: i + 1, kind: /^  (?:async )?function /.test(lines[i]) ? "fn" : "var" });
  }
  for (const u of starts) {
    let s = u.start;
    while (s - 2 >= 0 && /^\s*\/\//.test(lines[s - 2])) s--;
    u.cstart = s;
  }
  for (let i = 0; i < starts.length; i++) {
    starts[i].end = i + 1 < starts.length ? starts[i + 1].cstart - 1 : null;
  }
  return { lines, units: starts };
}
