// The gym display (202609230005) — a screen in a public room.
//
// The database owns the hard guarantees (pgTAP 0129): who may call the board,
// which members appear, and that names are masked before they leave Postgres.
// This file pins the client half that a server test cannot see — that the
// display really does take the page over, that it holds no Supabase client of
// its own, and that it is wired into the precache and the stylesheet the way
// CLAUDE.md requires.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const src = readFileSync(new URL("src/community/gym-display.js", root), "utf8");
const cloud = readFileSync(new URL("cloud.js", root), "utf8");
const html = readFileSync(new URL("index.html", root), "utf8");
const sw = readFileSync(new URL("sw.js", root), "utf8");

test("it only takes over on ?display=1, never by accident", () => {
  assert.match(src, /GYM_DISPLAY_PARAM = "display"/, "the parameter is ?display");
  assert.match(src, /\.get\(GYM_DISPLAY_PARAM\) === "1"/,
    "and the route is an explicit ===\"1\", not a truthiness check - ?display=0 must not open it");
  assert.match(src, /if \(!gymDisplayWanted\(\)\) return;/,
    "and start() is a no-op on every other page load");
});

test("it hides the whole app shell, because there is nothing to tap on a wall", () => {
  for (const id of ["appShell", "bottomNavWrap", "loading"]) {
    assert.ok(src.includes(`getElementById("${id}")`), `it hides #${id}`);
  }
});

test("it never holds the Supabase client, only one published function", () => {
  assert.ok(!/createClient|\.rpc\(/.test(src),
    "the display must not create a client or call .rpc directly");
  assert.match(src, /window\.gymDisplayBoard\(\)/, "it calls the one published door");
  assert.match(cloud, /window\.gymDisplayBoard = async function/, "which cloud.js publishes");
  const door = cloud.slice(cloud.indexOf("window.gymDisplayBoard"));
  assert.match(door.slice(0, 400), /client\.rpc\("gym_display_board"\)/,
    "and that door calls exactly the one RPC, nothing parameterised");
});

test("it renders text as text, so a member's name cannot become markup", () => {
  // A screen nobody is watching is a bad place for an injection. Everything
  // goes through textContent; there is no innerHTML in this file.
  assert.ok(!/innerHTML/.test(src), "no innerHTML anywhere in the display");
  assert.match(src, /n\.textContent = text/, "the element helper sets textContent");
});

test("a failure backs off instead of hammering a paused project", () => {
  const backoff = Number(src.match(/GYM_DISPLAY_BACKOFF_MS = (\d+)/)[1]);
  const refresh = Number(src.match(/GYM_DISPLAY_REFRESH_MS = (\d+)/)[1]);
  assert.ok(backoff > refresh, "the failure interval is longer than the happy one");
  assert.match(src, /gymDisplayRender\(root, null, true\)/, "and it says so on screen rather than going blank");
});

test("it says why a member might be missing from the board", () => {
  // An absence on a wall reads as a slight unless the screen explains it.
  assert.ok(src.includes("מוצגים רק מי שבחרו להופיע בלוחות"),
    "the footer names the in_leaderboards opt-in");
});

test("it obeys the community layer's script convention", () => {
  // The first draft was an IIFE with top-level `render`, `start` and `el`.
  // These modules share ONE global lexical scope, so those are redeclarations
  // that take down whichever script loads second, and an IIFE would cut the
  // file off from state/client/esc the way its siblings reach them. The suite
  // caught all three at once; this keeps them caught here too.
  assert.match(src, /^"use strict";/, "opens with its own use strict");
  assert.doesNotMatch(src, /^\(function \(\) \{/m, "no IIFE");
  assert.doesNotMatch(src, /^\s*(?:import|export)\s/m, "no ES module syntax");
  for (const bare of ["function render(", "function start(", "function mount(", "function el("]) {
    assert.ok(!src.includes(bare), `no bare top-level ${bare} - every name is gymDisplay-prefixed`);
  }
  assert.ok(!src.includes('"האימוניה"'),
    "the product name comes from brandName(), never a literal");
});

test("it is precached and stylesheet-clean, per CLAUDE.md", () => {
  assert.ok(html.includes('src="./src/community/gym-display.js"'), "index.html loads it");
  assert.ok(sw.includes('"./src/community/gym-display.js"'), "sw.js precaches it");
  // OPTIONAL, not REQUIRED: the app runs fine without it, and a wall screen
  // must never be the reason the training log fails to boot offline.
  const optional = sw.slice(sw.indexOf("OPTIONAL_ASSETS"));
  assert.ok(optional.includes('"./src/community/gym-display.js"'),
    "in OPTIONAL_ASSETS - the training log must not depend on it");

  // Every .gd- rule is built from tokens, which is why none of them is
  // repeated in the two dark blocks. A literal colour here would render one
  // theme's text on the other theme's background.
  const block = html.slice(html.indexOf(".gd-root{"), html.indexOf(".gd-foot{") + 200);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), "no literal hex colour in the display CSS");
  assert.ok(!/\brgba?\(/.test(block), "and no literal rgb()/rgba()");
  assert.match(block, /var\(--club-navy\)/);
  assert.match(block, /var\(--chalk\)/);
});
