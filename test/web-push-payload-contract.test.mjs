// The two halves of a push notification are written in different languages,
// in different runtimes, and never run in the same process: the sender builds
// a JSON payload in Deno, and sw.js reads it in the browser. Nothing connects
// them but the spelling of four field names.
//
// The first draft of the sender emitted `url`. sw.js reads `deep_link`, falls
// back to "./", and shows the notification anyway - so every push would have
// opened the home screen instead of the thing it was about, with no error
// anywhere. That is this repo's signature defect (sibling drift) crossed with
// its signature failure mode (a thing that reports success while doing
// nothing), so it gets a test rather than a comment.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const sender = readFileSync(new URL("../supabase/functions/notif_push_send/index.ts", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

function payloadFields(src) {
  const at = src.indexOf("function payloadFor(row: Pending): string {");
  assert.ok(at > -1, "payloadFor is where the payload is built - if it moved, this test must follow it");
  const body = src.slice(at, src.indexOf("\n}", at));
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
}

test("every field the sender emits is one the service worker reads", () => {
  const fields = payloadFields(sender);
  assert.ok(fields.length >= 3, `expected to have parsed the payload, got ${JSON.stringify(fields)}`);
  const pushHandler = sw.slice(sw.indexOf('self.addEventListener("push"'), sw.indexOf('self.addEventListener("notificationclick"'));
  for (const field of fields) {
    assert.match(pushHandler, new RegExp(`payload\\.${field}\\b`),
      `the sender emits "${field}" and sw.js never reads it - it will be silently dropped`);
  }
});

test("the deep link travels under the name sw.js actually looks for", () => {
  const fields = payloadFields(sender);
  assert.ok(fields.includes("deep_link"),
    "sw.js reads payload.deep_link (then deepLink); anything else falls back to \"./\" and every "
    + "notification opens the home screen instead of its target");
  assert.ok(!fields.includes("url"), "`url` is the name that does not work - it was the first draft's bug");
});

test("title and body are sent, since the service worker's fallbacks hide their absence", () => {
  const fields = payloadFields(sender);
  assert.ok(fields.includes("title"), 'sw.js falls back to the club name, so a missing title shows a plausible-looking notification');
  assert.ok(fields.includes("body"), 'sw.js falls back to "", so a missing body shows an empty notification rather than an error');
});

test("the service worker still reads what this test claims it reads", () => {
  // Pinning the OTHER side too. If sw.js stops reading deep_link, this test
  // must fail rather than keep asserting a contract that changed underneath it.
  const pushHandler = sw.slice(sw.indexOf('self.addEventListener("push"'), sw.indexOf('self.addEventListener("notificationclick"'));
  assert.match(pushHandler, /payload\.deep_link \|\| payload\.deepLink \|\| "\.\/"/);
  assert.match(pushHandler, /payload\.title \|\|/);
  assert.match(pushHandler, /body: payload\.body \|\|/);
});
