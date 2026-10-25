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










