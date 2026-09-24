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
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

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
  const ids = /for \(const id of (\[[^\]]+\])\)/.exec(src);
  assert.ok(ids, "the mount walks one list of shell ids");
  for (const id of ["appShell", "bottomNavWrap", "loading"]) {
    assert.ok(ids[1].includes(`"${id}"`), `it hides #${id}`);
  }
});

test("the switch wins over the URL: the gate is clubFeatureOn, which defaults off", () => {
  // isModuleEnabled() defaults ON before the feature map loads - the wrong
  // direction for a surface that takes the whole page over.
  assert.match(src, /clubFeatureOn\("gym_display"\)/, "gated through app.js's default-off reader");
  assert.ok(!src.includes('isModuleEnabled("gym_display")'), "not through the default-on one");
  assert.match(src, /if \(!gymDisplayOn\(\)\) \{/, "sync() refuses to mount while the switch is off");
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

// ===========================================================================
// Behaviour, not text: the real app booted at ?display=1
// ===========================================================================

const VERIFIED = new Date().toISOString();
function displayMock(enabled, board) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "tv", display_name: "מסך", recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    club_features: [{ club_id: "club-1", module_key: "gym_display", enabled, config: {} }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "tv@members.haimuniya.invalid" });
  mock.onRpc("gym_display_board", board || (() => ({ data: { wod: null, results: [] }, error: null })));
  return mock;
}
const shown = (w) => !!w.document.querySelector(".gd-root");
const shellHidden = (w) => w.document.getElementById("appShell").style.display === "none";

test("?display=1 with the switch OFF is the ordinary app", async (t) => {
  const calls = [];
  const w = await bootCommunity(displayMock(false, () => { calls.push(1); return { data: null, error: null }; }),
    { url: "https://example.test/?display=1" });
  t.after(() => w.close());
  // Past the point the feature map has answered, so "not mounted" is the
  // switch's answer and not merely "not yet".
  await waitFor(() => w.clubFeatureOn && w.document.querySelector("#content")?.children.length > 0, 5000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(shown(w), false, "no board on the page");
  assert.equal(shellHidden(w), false, "the app shell is visible");
  assert.equal(w.document.documentElement.hasAttribute("data-gym-display"), false);
  assert.equal(calls.length, 0, "and the board is never even asked for");
});

test("?display=1 with the switch ON takes the page over", async (t) => {
  const w = await bootCommunity(displayMock(true), { url: "https://example.test/?display=1" });
  t.after(() => w.close());
  await waitFor(() => shown(w), 5000, 5, "the board mounts once the switch answers on");
  assert.equal(shellHidden(w), true, "and the app shell is hidden behind it");
  assert.equal(w.document.documentElement.getAttribute("data-gym-display"), "1");
});

test("the switch going off under a running screen hands the page back to the app", async (t) => {
  const w = await bootCommunity(displayMock(true), { url: "https://example.test/?display=1" });
  t.after(() => w.close());
  await waitFor(() => shown(w), 5000);
  w.setClubFeatureFlags({ gym_display: false });
  assert.equal(shown(w), false, "the board is gone");
  assert.equal(shellHidden(w), false, "the shell is back");
  assert.equal(w.document.documentElement.hasAttribute("data-gym-display"), false);
});

test("the server refusing the board as disabled also stands the screen down", async (t) => {
  // A stale cached map can say on after an admin turned it off; the server's
  // copy of the switch outranks it rather than leaving "no connection" up.
  const calls = [];
  const w = await bootCommunity(displayMock(true, () => { calls.push(1); return { data: null, error: { message: "gym_display disabled" } }; }),
    { url: "https://example.test/?display=1" });
  t.after(() => w.close());
  await waitFor(() => calls.length > 0, 5000, 5, "the board mounted and asked for its data");
  await waitFor(() => !shown(w), 5000, 5, "the board unmounts on the server's refusal");
  assert.equal(shellHidden(w), false, "the shell is back");
  assert.equal(w.document.documentElement.hasAttribute("data-gym-display"), false);
});

test("without ?display=1 the switch being on changes nothing", async (t) => {
  const w = await bootCommunity(displayMock(true));
  t.after(() => w.close());
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(shown(w), false);
});
