// BOX-LOG's side of the Haimunia club (docs/club/research.md, C and finding 2):
// the club circle is never listed in BOX-LOG, and BOX-LOG registers its push
// subscriptions as app 'box-log', so a club notification is never pushed here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("loadMyCircles leaves out a club-type circle", () => {
  const s = src("src/community/circles.js");
  const body = s.slice(s.indexOf("async function loadMyCircles"), s.indexOf("state.circles.loaded = true"));
  assert.match(body, /\.filter\(\(r\) => r && r\.clubs && r\.clubs\.type !== "club"\)/);
});

test("BOX-LOG cannot create a club: create_circle is offered couple and friends only", () => {
  const s = src("src/community/circles.js");
  assert.match(s, /if \(type !== "couple" && type !== "friends"\) errors\.type/);
});

test("the push subscription BOX-LOG writes is app box-log", () => {
  const s = src("src/community/notifications.js");
  assert.match(s, /push_subscriptions"\)\.upsert\(\s*(?:\/\/[^\n]*\n\s*)?\{ user_id: state\.user\.id, endpoint: json\.endpoint, keys: json\.keys \|\| \{\}, revoked_at: null, app: "box-log" \}/);
});
