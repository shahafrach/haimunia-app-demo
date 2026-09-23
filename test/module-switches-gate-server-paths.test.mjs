// "The admin panel says module switches are enforced on the server, but only
// table read policies check the flag." 202609230001 puts the switch inside the
// definer functions that bypassed those policies, and the panel's claim is
// corrected on the rows where other paths still bypass it. The pgTAP file
// 0125 proves the gates against Postgres; this pins the two halves together.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/202609230001_module_switches_gate_their_server_paths.sql", import.meta.url), "utf8");
const cloudJs = readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const adminJs = readFileSync(new URL("../src/community/admin.js", import.meta.url), "utf8");

const GATES = [
  ["feed_page", "feed"],
  ["post_create", "feed"],
  ["event_rsvp", "events"],
  ["chal_progress", "challenges"],
  ["ach_claim", "achievements"],
  ["community_streaks", "leaderboards"],
];

// The body of one re-emitted function, from its create line to the next one.
function bodyOf(name) {
  const re = new RegExp(`create or replace function public\\.${name}\\(`, "i");
  const m = re.exec(sql);
  assert.ok(m, `${name} is re-emitted`);
  const rest = sql.slice(m.index + 1);
  const next = rest.search(/create or replace function public\./i);
  return next === -1 ? rest : rest.slice(0, next);
}

test("each named function refuses with '<module> disabled' while its module is off", () => {
  for (const [fn, key] of GATES) {
    const body = bodyOf(fn);
    assert.ok(body.includes(`if not public.club_feature_enabled('${key}') then raise exception '${key} disabled'; end if;`),
      `${fn} carries the ${key} switch`);
  }
});

test("the gate comes after the existing auth checks, so their order is unchanged", () => {
  for (const [fn, key] of GATES.filter(([f]) => f !== "community_streaks")) {
    const body = bodyOf(fn);
    const auth = body.search(/raise exception 'not authorized'/);
    const gate = body.indexOf(`club_feature_enabled('${key}')`);
    assert.ok(auth > -1 && auth < gate, `${fn}: 'not authorized' is still checked first`);
  }
});

test("announcements: the insert refuses and the fan-out sends nothing while off", () => {
  assert.match(sql, /create trigger announcements_module_gate before insert on public\.announcements/);
  assert.match(sql, /raise exception 'announcements disabled'/);
  assert.match(bodyOf("notif_announcement_fanout"),
    /if not public\.club_feature_enabled\('announcements'\) then return; end if;/);
});

test("the panel does not claim full enforcement where other paths still bypass the switch", () => {
  for (const key of ["feed", "events", "challenges", "achievements"]) {
    const at = cloudJs.indexOf(`{ key: "${key}", label:`);
    assert.ok(at > -1, `${key} row exists`);
    const row = cloudJs.slice(at, cloudJs.indexOf("\n", at));
    assert.match(row, /serverPartial: true/, `${key} is marked partially enforced`);
  }
  for (const key of ["announcements", "leaderboards"]) {
    const at = cloudJs.indexOf(`{ key: "${key}", label:`);
    const row = cloudJs.slice(at, cloudJs.indexOf("\n", at));
    assert.ok(!/serverPartial|clientOnly/.test(row), `${key} is fully gated and keeps the plain claim`);
  }
  assert.match(adminJs, /m\.serverPartial \? "נאכף בשרת חלקית"/, "the marker renders");
});
