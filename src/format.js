function estimate1RM(weight, reps) {
  if (reps <= 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}
// Matches the box's own shorthand for holds: seconds alone under a minute,
// M:SS once it crosses one — e.g. 20" for a 20-second hold, 1:15 for longer.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  if (s < 60) return `${s}"`;
  const m = Math.floor(s / 60), rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
// Live bug hunt, round 10 (2026-09-11): always omitted the year, so two
// same-day-of-month entries logged years apart (a real thing at this app's
// intended multi-year lifespan) rendered as the exact same label - confirmed
// live, a chart plotting a 3-years-apart 1RM gain showed two identical
// "11.03" x-axis points with no way to tell the gain happened over years
// rather than weeks, and the same ambiguity hit History rows and
// delete-confirmation dialogs. Appends the year, but ONLY when it differs
// from the current one: the common case (this year's own training log) is
// unaffected, unambiguous, and no more cluttered than before.
function fmtDate(iso) {
  const d = new Date(iso);
  const opts = { day: "2-digit", month: "2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("he-IL", opts);
}
// One number parser for every typed numeric field (audit M8, 2026-11).
// parseFloat("1.250.5") is 1.25 and parseFloat("٢٠") is NaN, and both used to
// end as the field minimum with no warning. Returns a finite number or NaN;
// the caller decides what an invalid or out-of-range value does.
//   Arabic-Indic (٠-٩) and Persian (۰-۹) digits count as digits, and the Arabic
//   decimal separator (٫) as a point.
//   Both "," and "." present: commas are thousands separators ("1,250.5").
//   Only commas: groups of exactly three digits are thousands ("1,250",
//   "1,250,000"); a single other comma is a decimal point ("62,5").
function parseLocaleNumber(raw) {
  let t = String(raw == null ? "" : raw).trim()
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, ".").replace(/[\u066C\u00A0\u202F\s']/g, "")
    .replace(/^\u2212/, "-");
  if (t.includes(",") && t.includes(".")) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return NaN;
    t = t.replace(/,/g, "");
  } else if (t.includes(",")) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, "");
    else if (/^-?\d*,\d+$/.test(t)) t = t.replace(",", ".");
    else return NaN;
  }
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO() { return localISODate(new Date()); }
// esc() moved to src/shared/safe-helpers.js in COMM-368 (one HTML escape for
// both Box Log clients, and, since COMM-367, for cloud.js too — which had its
// own byte-identical copy named safeText). It is bound as a bare `esc`
// identifier at the top of src/constants.js, which loads before this file,
// so every call site in this file and in app.js is unchanged.
