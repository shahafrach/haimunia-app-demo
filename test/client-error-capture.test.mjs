// N10. The global error capture in src/analytics.js.
//
// An uncaught error or an unhandled rejection becomes one client_error row
// through the existing analytics writer. The contract that matters is what
// the row does NOT carry: no message, no stack, no URL - an error message is
// not code-authored text and can quote whatever the member typed.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const settle = () => new Promise((r) => setTimeout(r, 0));

function fireError(window, error, filename, lineno, colno) {
  window.dispatchEvent(new window.ErrorEvent("error", { error, message: error && error.message, filename, lineno, colno }));
}

function fireRejection(window, reason) {
  const event = new window.Event("unhandledrejection");
  event.reason = reason;
  window.dispatchEvent(event);
}

async function configured() {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  a.reset();
  const mock = createMockSupabase();
  a.configure({ client: mock.client, userId: "user-1", attachToBus: false });
  return { window, a, mock };
}

test("an uncaught error writes one client_error row with no message, no stack and no URL", async () => {
  const { window, mock } = await configured();
  const secret = "Unexpected token in JSON: {\"note\":\"הברך שלי כואבת\"}";
  fireError(window, new window.SyntaxError(secret), window.location.origin + "/cloud.js?token=abc", 120, 7);
  await settle();

  const rows = mock.db.analytics_events.filter((r) => r.event_name === "client_error");
  assert.strictEqual(rows.length, 1);
  const props = plain(rows[0].props);
  assert.deepStrictEqual(Object.keys(props).sort().filter((k) => k !== "app_version"), ["col", "file", "fp", "kind", "line", "name"]);
  assert.strictEqual(props.kind, "error");
  assert.strictEqual(props.name, "SyntaxError");
  assert.strictEqual(props.file, "cloud.js");
  assert.strictEqual(props.line, 120);
  assert.strictEqual(props.col, 7);
  assert.match(props.fp, /^[0-9a-f]{8}$/);
  const serialized = JSON.stringify(rows[0]);
  assert.ok(!serialized.includes("הברך"), "member text must never reach the row");
  assert.ok(!serialized.includes("token"), "a query string must never reach the row");
  assert.strictEqual(rows[0].user_id, "user-1");
});

test("an unhandled rejection is recorded as kind=rejection, and a foreign script is 'other'", async () => {
  const { window, a, mock } = await configured();
  fireRejection(window, new window.TypeError("cannot read properties of undefined (reading 'שם')"));
  fireError(window, new Error("x"), "https://extension.example/inject.js", 1, 1);
  await settle();
  const rows = mock.db.analytics_events.filter((r) => r.event_name === "client_error").map((r) => plain(r.props));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].kind, "rejection");
  assert.strictEqual(rows[0].name, "TypeError");
  assert.strictEqual(rows[0].file, "other");
  assert.strictEqual(rows[1].file, "other");
  // A non-Error rejection reason: its value never becomes the name.
  assert.strictEqual(a.describeClientError("rejection", "member typed this", {}).name, "string");
  assert.strictEqual(a.describeClientError("rejection", { name: "has spaces in it" }, {}).name, "unknown");
  assert.strictEqual(a.describeClientError("error", new Error("e"), { filename: window.location.origin + "/src/community/feed.js" }).file, "src/community/feed.js");
});

test("the same error is sent once, and at most ERROR_CAP rows per page load", async () => {
  const { window, a, mock } = await configured();
  for (let i = 0; i < 4; i++) fireError(window, new Error("same"), window.location.origin + "/app.js", 10, 1);
  for (let i = 0; i < a.ERROR_CAP + 5; i++) fireError(window, new Error("distinct " + i), window.location.origin + "/app.js", 20 + i, 1);
  await settle();
  const rows = mock.db.analytics_events.filter((r) => r.event_name === "client_error");
  assert.strictEqual(rows.length, a.ERROR_CAP);
});

test("an error before the client exists is held and sent on configure()", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  a.reset();
  fireError(window, new Error("boot"), window.location.origin + "/app.js", 5, 1);
  await settle();
  const mock = createMockSupabase();
  a.configure({ client: mock.client, userId: null, attachToBus: false });
  await settle();
  const rows = mock.db.analytics_events.filter((r) => r.event_name === "client_error");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(plain(rows[0].props).file, "app.js");
});

test("the capture never throws, even on a hostile error object", async () => {
  const { window, a } = await configured();
  const hostile = { get name() { throw new Error("boom"); }, get message() { throw new Error("boom"); } };
  assert.doesNotThrow(() => a.recordClientError("error", hostile, {}));
  assert.doesNotThrow(() => fireRejection(window, undefined));
});
