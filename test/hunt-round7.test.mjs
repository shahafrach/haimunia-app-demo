// Live bug hunt, fresh round 7 (2026-09-15).
//
// Three agents: sibling drift (third pass, aimed at categories the first two
// missed), search/profiles with realistic Hebrew names, and realistic volume -
// the last made possible only because round 3 fixed a mock cursor that used
// Node's Buffer inside a browser page, which had made feed paging impossible
// to test at all.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const pagingSql = fs.readFileSync(new URL("../supabase/migrations/202609150015_paging_cursors_break_ties.sql", import.meta.url), "utf8");

test("paging cursors identify a ROW, so a tied timestamp cannot hide one", () => {
  // Measured: 300 audit rows seeded, 296 rendered; 200 notifications, 199.
  // A row sharing the last-shown row's created_at was on neither page - not
  // on that one (past the limit), not on the next (not strictly less than the
  // cursor). Ties are the NORMAL case: actioning a report writes two audit
  // rows in one transaction, and notif_create fans one event out in a loop.
  for (const fn of ["admin_actions_page", "notif_list"]) {
    const at = pagingSql.indexOf(`create or replace function public.${fn}`);
    assert.ok(at > -1, `${fn} is rewritten`);
    const body = pagingSql.slice(at, pagingSql.indexOf("$$;", at));
    assert.match(body, /p_cursor_id uuid default null/, `${fn} takes a row identity`);
    assert.match(body, /\(a?n?\.?created_at, a?n?\.?id\) < \(p_cursor, p_cursor_id\)/,
      `${fn} compares the composite, not the timestamp alone`);
    assert.match(body, /order by \w+\.created_at desc, \w+\.id desc/,
      `${fn} must ORDER by the same composite it pages on, or the walk is not stable`);
    // Optional, so a cached old client that sends only a timestamp still works.
    assert.match(body, /p_cursor_id is null and \w+\.created_at < p_cursor/,
      `${fn} keeps the old behaviour when no id is sent`);
  }
});

test("the client sends and remembers the row identity", () => {
  assert.match(cloudJs, /rpc\("admin_actions_page", \{ p_cursor: state\.admin\.auditCursor, p_cursor_id: state\.admin\.auditCursorId/,
    "the audit log sends both halves");
  assert.match(cloudJs, /state\.admin\.auditCursorId = rows\.length \? rows\[rows\.length - 1\]\.id/,
    "and remembers the last row's id");
  assert.match(cloudJs, /rpc\("notif_list", \{ p_cursor: c\.cursor, p_cursor_id: c\.cursorId \|\| null/,
    "the notification centre sends both halves");
  assert.match(cloudJs, /c\.cursor = rows\[rows\.length - 1\]\.created_at; c\.cursorId = rows\[rows\.length - 1\]\.id;/,
    "and remembers both");
});

test("a failed 'load more' does not erase the rows already on screen", () => {
  // One error flag serves the first load and every subsequent page, so a blip
  // on page three replaced three loaded pages with an error box. The
  // directory has carried the guard since COMM-377, with a comment saying
  // why; three paginated siblings never got it.
  assert.match(cloudJs, /\} else if \(iv\.error && !iv\.items\.length\) \{/, "person invites");
  assert.match(cloudJs, /\} else if \(state\.admin\.auditError && !state\.admin\.auditLog\.length\) \{/, "audit log");
  assert.match(cloudJs, /\} else if \(r\.error && !r\.items\.length\) \{/, "member roster");
  assert.match(cloudJs, /else if \(d\.error && !d\.items\.length\)/, "and the directory keeps its own");
});

test("typing the handle the app shows you finds the member", () => {
  // "@handle" is the form this app displays wherever a display name is
  // missing, so it is the form members copy. The ILIKE pattern became
  // %@ritz% against a column that never contains "@": zero results for
  // typing exactly what was on screen.
  const at = cloudJs.indexOf("function sanitizeSearchQuery");
  const line = cloudJs.slice(at, cloudJs.indexOf("\n", at));
  assert.match(line, /replace\(\/\^@\+\/, ""\)/, "a leading @ is stripped");
  assert.ok(!/replace\(\/@\/g/.test(line), "only the leading one - an @ inside a query is ordinary text");
});

test("the directory search box is debounced like the box beside it", () => {
  // searchPeople() was debounced under PERF-3 with a comment noting a typed
  // word "used to be 8 round trips... now costs one". The directory box calls
  // the SAME RPC and was never given it: measured 3 requests to the main
  // box's 1 for four characters.
  assert.match(cloudJs, /function directorySearchDebounced\(query\)/, "there is a debounced entry point");
  assert.match(cloudJs, /directorySearchTimer = setTimeout\(\(\) => \{/, "with a timer");
  assert.match(cloudJs, /dirInput\.addEventListener\("input", \(\) => directorySearchDebounced\(dirInput\.value\)\)/,
    "and the input is wired to it, not to the raw fetch");
});

test("a long unbroken name cannot bleed out of a member row", () => {
  // An 80-character single-token Hebrew name rendered as one 800px line
  // inside a 354px row, measured bleeding to -440px - off the viewport and
  // under the row's own buttons. The overflow-wrap fix existed but was
  // scoped to one selector on one screen.
  assert.match(indexHtml, /\.member-name\{ overflow-wrap:anywhere; min-width:0; \}/,
    "the rule exists for server-supplied names");
  assert.match(cloudJs, /<div class="member-name" style="font-weight:700;">\$\{nameHtml/,
    "search and directory rows use it");
  assert.match(cloudJs, /class="member-name"[^>]*id="profileViewTitle"|id="profileViewTitle" class="member-name"/,
    "and so does the profile header");
});

test("a follow list distinguishes two members who share a display name", () => {
  // Two members called נועם is ordinary in a thirty-person club. Search rows
  // and suggestion cards show @handle; this row showed the bare name, so
  // there was no way to tell which one you were unfollowing.
  const at = cloudJs.indexOf("function followListRowHtml");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /const handleLine = \(m\.handle && m\.display_name\)/,
    "the handle is shown - and suppressed when the NAME is already the handle fallback");
  assert.match(body, /<bdi>@\$\{esc\(m\.handle\)\}<\/bdi>/, "isolated for RTL, like every other handle");
});

test("the follower count moves with the list it labels", () => {
  const at = cloudJs.indexOf("async function unfollowFromFollowingList");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /pv\.data\.following_count = Math\.max\(0, pv\.data\.following_count - 1\)/,
    "the count drops with the row");
  assert.match(body, /pv\.data\.following_count \+= 1;/,
    "and is restored on the same failure path that restores the row");
});

test("blocking from the directory clears the directory, not just search", () => {
  const at = cloudJs.indexOf("state.members.people = state.members.people.filter");
  const body = cloudJs.slice(at, at + 700);
  assert.match(body, /dir\.items = dir\.items\.filter/, "the directory list");
  assert.match(body, /dir\.searchResults = dir\.searchResults\.filter/, "and its search results");
});

test("a handle-only profile header is not flipped by RTL", () => {
  // The header built the same "@handle" fallback nameHtml() builds and then
  // rendered it with a bare esc(), so the @ painted to the right: the member
  // saw their own title as "noam-cohen@".
  assert.match(cloudJs, /\(!d\.first_name && !d\.last_name && !d\.display_name\) \? nameHtml\(null, d\.handle\) : esc\(name\)/,
    "the handle fallback goes through nameHtml, which wraps it in <bdi>");
});

test("the shared invite-codes panel can be retried, like its sibling", () => {
  // loadInviteCodes() marks itself loaded even on failure and the lazy-load
  // guard only checks !loaded, so an admin was stuck until a full reload
  // while the person-invites panel beside it recovered in one tap.
  assert.match(cloudJs, /data-community-action="invite-codes-retry"/, "the button exists");
  assert.match(cloudJs, /action === "invite-codes-retry"\) \{ state\.admin\.inviteCodes\.loaded = false; loadInviteCodes\(\); \}/,
    "and resets loaded, or the retry would do nothing");
});
