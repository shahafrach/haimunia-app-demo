// Reported from a real phone as "can't sign in", with a screenshot of the
// invite-code gate carrying a red "לא ניתן לטעון את הקהילה כרגע" underneath it.
//
// Sign-in had worked. The account simply had no invite redemption yet - which
// is the NORMAL state of every member on that screen, and the deliberate state
// of the management account ("management is not a membership", 202609150010).
// feed_page is gated on is_community_member(), so loadFeed() called it, was
// refused exactly as designed, and wrote the failure into state.ui.message -
// the same field the invite gate renders at its foot.
//
// Nothing was broken. The app just told the reader it was, at the one moment
// they most need to believe the next step will work.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const cloudJs = readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("loadFeed does not call the feed RPC for a member who has not redeemed an invite", () => {
  const at = cloudJs.indexOf("async function loadFeed()");
  assert.ok(at > -1, "loadFeed exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));

  // The guard must come BEFORE the message can be written, and must leave the
  // feed in a clean not-an-error state rather than an error one.
  const guardAt = body.indexOf("if (!state.redemption)");
  assert.ok(guardAt > -1, "a non-member returns early");
  assert.match(body.slice(guardAt, guardAt + 160), /state\.feed\.error = false/,
    "and is NOT recorded as a feed error - there is no error, only a non-member");

  const messageAt = body.indexOf('state.ui.message = ok ? ""');
  assert.ok(messageAt > -1, "the message assignment is still there for real failures");
  assert.ok(guardAt < messageAt, "the early return happens before anything can write that message");
});

test("the guard sits with the module gate, not somewhere a later edit would miss", () => {
  const at = cloudJs.indexOf("async function loadFeed()");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  const moduleGate = body.indexOf('if (!isModuleEnabled("feed"))');
  const memberGate = body.indexOf("if (!state.redemption)");
  assert.ok(moduleGate > -1 && memberGate > moduleGate,
    "both 'this RPC can only be refused' guards sit together in the same shape");
  // Both must return the same clean shape, or the two reasons to skip the feed
  // would leave the UI in two different states for no reason a reader could name.
  const mod = body.slice(moduleGate, moduleGate + 140);
  const mem = body.slice(memberGate, memberGate + 140);
  for (const frag of ["state.feed.items = []", "state.feed.error = false", "state.feed.loading = false"]) {
    assert.ok(mod.includes(frag) && mem.includes(frag), `both guards reset ${frag}`);
  }
});

test("a real feed failure still reports itself", () => {
  // The fix must not have bought a quiet invite gate at the cost of silencing
  // genuine breakage for members who ARE in the club.
  const at = cloudJs.indexOf("async function loadFeed()");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /state\.feed\.error = !ok;/, "a genuine failure is still an error");
  assert.match(body, /state\.ui\.message = ok \? "" : "לא ניתן לטעון את הקהילה כרגע";/,
    "and still says so");
});
