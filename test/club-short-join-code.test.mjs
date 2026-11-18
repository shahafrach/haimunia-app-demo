// Q-37 (202611180002): the club's short join code. The behaviour is pinned in pgTAP
// (supabase/tests/0161_club_short_join_code_test.sql, CI); this pins the migration's shape so a later edit
// cannot quietly widen the alphabet, drop the hash, or open a helper to clients.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202611180002_club_short_join_code.sql", import.meta.url), "utf8");
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

test("the code alphabet is 31 characters with no 0, O, 1, I, L, the same in the generator and in join_circle", () => {
  assert.equal(ALPHABET.length, 31);
  assert.doesNotMatch(ALPHABET, /[01OIL]/);
  assert.ok(sql.includes(`v_alphabet constant text := '${ALPHABET}'`), "generator alphabet");
  assert.ok(sql.includes(`v_code ~ '^[${ALPHABET}]{8}$'`), "join_circle accepts exactly 8 of the same");
  assert.match(sql, /if v_b < 248 and/, "rejection sampling (248 = 8 * 31), no modulo bias");
});

test("only hashes are stored, and the helpers are closed to every client role", () => {
  assert.match(sql, /add column code_hash text unique check \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /encode\(extensions\.digest\(v_code, 'sha256'\), 'hex'\), v_uid, 'infinity', 100000\)/);
  assert.match(sql, /revoke all on function public\.join_code_normalize\(text\) from public, anon, authenticated;/);
  assert.match(sql, /revoke all on function public\.join_code_generate\(\) from public, anon, authenticated;/);
  assert.match(sql, /revoke all on function public\.rotate_club_invite\(uuid\) from public, anon;\ngrant execute on function public\.rotate_club_invite\(uuid\) to authenticated;/);
  assert.doesNotMatch(sql, /\bgrant [^;]* to [^;]*\b(anon|public)\b/i, "nothing is granted to anon or public");
});

test("rotate_club_link keeps its contract and is a wrapper, so the rotation body exists once", () => {
  const wrapper = sql.match(/create or replace function public\.rotate_club_link\(p_club_id uuid\)\nreturns text[\s\S]*?end \$\$;/);
  assert.ok(wrapper, "rotate_club_link(uuid) returns text");
  assert.match(wrapper[0], /return public\.rotate_club_invite\(p_club_id\) ->> 'token';/);
  assert.equal((sql.match(/delete from public\.circle_invites/g) || []).length, 1, "one rotation body");
  assert.equal((sql.match(/check_rate_limit\('rotate_club_link', 5, 1440\)/g) || []).length, 1, "one shared daily limit");
});

test("join_circle: the token path is unchanged, a code is normalised, both find the same row and the same limit", () => {
  const body = sql.match(/create or replace function public\.join_circle\(p_token text\)[\s\S]*?\nend \$\$;/)[0];
  assert.match(body, /check_rate_limit\('join_circle', 10, 60\)[\s\S]*v_code := public\.join_code_normalize\(p_token\);/, "the limit is counted before any parsing");
  assert.match(body, /if p_token ~ '\^\[0-9a-f\]\{64\}\$' then/);
  assert.match(body, /\(v_hash is not null and i\.token_hash = v_hash\) or \(v_code_hash is not null and i\.code_hash = v_code_hash\)/);
  assert.match(body, /and i\.uses < i\.max_uses and i\.expires_at > now\(\)/, "expiry and max uses apply to the code too");
});
