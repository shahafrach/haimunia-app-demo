// Top-level units of cloud.js, by indentation rather than brace matching.
//
// Every top-level declaration sits at exactly two spaces of indent and
// everything inside it sits deeper, so the declaration lines are the
// boundaries. A unit runs from its own comment block down to its closing
// brace at indent 2 — NOT down to the next declaration, because the gaps
// between declarations hold top-level statements (`window.X = function () {`,
// `document.addEventListener(...)`, `registerOutboxHandlers()`) that belong
// to cloud.js and must not be dragged along by whatever declaration happens
// to precede them.
//
// A simple alias export on the line after a unit (`window.foo = foo;`) IS
// absorbed: it is that unit's export and nothing else's.
import fs from "node:fs";

const DECL = /^  (?:(?:async )?function|const|let|var) ([A-Za-z0-9_$]+)\s*[=(]/;
const CLOSER = /^  [}\])]/;
const ALIAS_EXPORT = /^  window\.[A-Za-z0-9_$]+ = [A-Za-z0-9_$]+;\s*$/;

export function parseUnits(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL);
    if (!m) continue;
    const isFn = /^  (?:async )?function /.test(lines[i]);
    const line = lines[i];
    // Single-line unit: a function whose line already closes, or a
    // declaration statement that already ends.
    const oneLine = isFn ? /\}\s*$/.test(line) : /;\s*$/.test(line);
    let end = i;
    if (!oneLine) { let j = i + 1; while (j < lines.length && !CLOSER.test(lines[j])) j++; end = Math.min(j, lines.length - 1); }
    // absorb this unit's own alias export, and any comment lines leading to it
    let k = end + 1, look = k;
    while (look < lines.length && /^\s*\/\//.test(lines[look])) look++;
    if (look < lines.length && ALIAS_EXPORT.test(lines[look])) end = look;
    let s = i + 1;
    while (s - 2 >= 0 && /^\s*\/\//.test(lines[s - 2])) s--;
    units.push({ name: m[1], start: i + 1, end: end + 1, cstart: s, kind: isFn ? "fn" : "var" });
    i = end;
  }
  return { lines, units };
}
