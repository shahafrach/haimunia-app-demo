// Reported directly, with a screenshot of a Hebrew keyboard: handles were
// English-letters-only (a-z0-9_) - real friction for a Hebrew-speaking
// membership. Widened both the client regex and the database CHECK
// constraint to also accept Hebrew letters (א-ת), and removed the forced
// dir="ltr" on the field, which would have rendered Hebrew backwards
// while typing even once the regex allowed it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270008_hebrew_handles.sql", import.meta.url), "utf8");
// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

test("the database handle constraint accepts Hebrew letters, same length bound as before", () => {
  assert.match(sql, /alter table public\.profiles drop constraint profiles_handle_check/i);
  assert.match(sql, /check \(handle ~ '\^\[a-zא-ת0-9_\]\{3,24\}\$'\)/);
});

test("the client-side handle validation matches the database constraint exactly", () => {
  // The member no longer types a handle (one name, asked once - see
  // deriveHandle). The rule still has to match the database CHECK exactly,
  // because a DERIVED handle that violates it is a save failure the member
  // cannot understand or fix, so the same regex now guards the derived value.
  assert.match(cloudJs, /\/\^\[a-zא-ת0-9_\]\{3,24\}\$\/\.test\(candidates\[0\]\)/);
});

test("the club-name input never forces dir=\"ltr\" - Hebrew must render naturally while typing", () => {
  // Same requirement, now on the field that actually exists: the handle input
  // is gone and the club name is the single thing a member types.
  assert.doesNotMatch(cloudJs, /name="displayName" dir="ltr"/);
  const nameInputs = (cloudJs.match(/name="displayName" dir="auto"/g) || []).length;
  assert.equal(nameInputs, 2, "both club-name inputs (the profile gate and the account tab) use dir=\"auto\"");
  assert.equal((cloudJs.match(/name="handle"/g) || []).length, 0, "and no handle input is asked for at all");
});
