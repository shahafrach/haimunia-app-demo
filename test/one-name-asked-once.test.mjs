// "There are too many places a user needs to write his name - 3 different
// places - it needs to be one, only community." The owner, 2026-09-16, after
// typing his own name into the club profile and being rejected for it.
//
// THE BUG HE HIT. The profile form asked for a name TWICE in adjacent fields:
// `handle`, labelled "השם שרואים במועדון" (the name people see in the club),
// directly above `displayName`, labelled "שם תצוגה". Both read as "your
// display name" in Hebrew. The one that sounded most like it was the handle,
// which may not contain a space - so a real name was rejected with a rule
// about underscores.
//
// And the label was not merely confusing, it was FALSE: every name render in
// cloud.js is `display_name || handle`, so the display name is what the club
// sees wherever it is set, and the handle only ever surfaces as an "@"
// fallback. The field labelled "the name people see" was the one usually not
// seen.
//
// A handle is an identifier. It is derived now, not asked for.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();
const VERIFIED = new Date().toISOString();

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "owner@members.haimuniya.invalid" });
  return mock;
}

test("the club profile asks for exactly one name", () => {
  assert.equal((cloudJs.match(/name="handle"/g) || []).length, 0,
    "no form asks a member to invent a handle");
  assert.equal((cloudJs.match(/name="displayName"/g) || []).length, 2,
    "the gate and the account tab each ask for the club name, once");
  // The label that describes what the club sees belongs on the field the club
  // actually shows.
  assert.match(cloudJs, /field\("communityProfile", "displayName", CLUB_NAME_LABEL/);
});

test("a real name with a space is accepted and becomes the club name", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  const form = window.document.getElementById("communityProfile");
  assert.ok(!form.elements.handle, "there is no handle field to reject it");

  form.elements.displayName.value = "שחף רחמני";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.profiles.some((p) => p.id === "u1"), 3000);

  const saved = mock.db.profiles.find((p) => p.id === "u1");
  assert.equal(saved.display_name, "שחף רחמני",
    "the name the member typed, space and all, is what the club will show");
  assert.equal(saved.handle, "שחף_רחמני",
    "and the handle is derived from it rather than asked for");
  // The whole point: no error, no second question.
  assert.ok(!/צריך להיות|כבר תפוס/.test(window.document.body.textContent),
    "nothing was rejected");
});

test("the derived handle satisfies the database CHECK the member never sees", () => {
  // profiles has CHECK (handle ~ '^[a-zא-ת0-9_]{3,24}$') and UNIQUE (handle).
  // A derived value that violates either is a save failure with no field for
  // the member to correct, so the derivation is pinned here.
  const at = cloudJs.indexOf("function deriveHandle(name)");
  assert.ok(at > -1, "the handle is derived");
  const body = cloudJs.slice(at, at + 700);
  assert.match(body, /replace\(\/\\s\+\/g, "_"\)/, "spaces become underscores rather than a rejection");
  assert.match(body, /replace\(\/\[\^a-zא-ת0-9_\]\/g, ""\)/, "anything the alphabet has no room for is dropped");
  assert.match(body, /slice\(0, 24\)/, "and it fits the 24-character ceiling");

  // The same regex as the database, applied to the DERIVED value.
  assert.match(cloudJs, /\/\^\[a-zא-ת0-9_\]\{3,24\}\$\/\.test\(candidates\[0\]\)/);

  // A name with nothing usable in it must not become "___".
  const cand = cloudJs.indexOf("function handleCandidates(name)");
  assert.match(cloudJs.slice(cand, cand + 800), /if \(!\/\[a-zא-ת0-9\]\/\.test\(base\)\) return \[\];/,
    "an all-emoji name asks for something typable instead of minting a meaningless handle");
});

test("a collision is resolved for the member, not handed back to them", () => {
  const at = cloudJs.indexOf("function handleCandidates(name)");
  const body = cloudJs.slice(at, at + 900);
  assert.match(body, /for \(let n = 2; n <= 9; n\+\+\)/, "suffixes are tried in order");
  // The first דנה כהן keeps the clean handle; the second becomes דנה_כהן2.
  const save = cloudJs.indexOf("for (const candidate of candidates) {");
  assert.ok(save > -1, "saveProfile walks the candidates");
  const saveBody = cloudJs.slice(save, save + 600);
  assert.match(saveBody, /if \(!error \|\| error\.code !== "23505"\) break;/,
    "it stops on success or on any error that is not a duplicate");
  // An EXISTING member has exactly one candidate - their current handle - so a
  // duplicate there is a real conflict and must still surface. Renaming
  // yourself must never silently rename your @mentions.
  assert.match(cloudJs, /const candidates = existingHandle \? \[existingHandle\] : handleCandidates\(displayName\);/);
});

test("the rejection a member CAN still get is about their name, not an identifier", () => {
  assert.match(cloudJs, /displayName: "השם שרואים במועדון צריך להיות באורך 2 עד 40 תווים\."/);
  assert.ok(!/השם שרואים במועדון צריך להיות 3 עד 24 תווים/.test(cloudJs),
    "the old handle-shaped rule is gone from the club-name field");
  // And a duplicate lands on the field that exists.
  assert.match(cloudJs, /setFieldErrors\(formId, \{ displayName: "השם הזה כבר תפוס במועדון/);
});
