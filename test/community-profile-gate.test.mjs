import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/community/circles-ui.js", import.meta.url), "utf8");

test("a signed-in member with no profile name yet sees an unskippable profile-completion gate, before any circle screen", () => {
  const gateAt = ui.indexOf("if (!state.profile || !String(state.profile.display_name");
  const circlesAt = ui.indexOf("if (!inAny && !meWithoutCircle) return renderFirstCircle();");
  assert.ok(gateAt > -1, "the profile gate must exist");
  assert.ok(gateAt < circlesAt, "the gate must be checked before the circle screens are ever built");
  const gate = ui.slice(gateAt, ui.indexOf("recovery_verified_at", gateAt));
  assert.match(gate, /profileFormHtml\("communityProfile"/, "the gate's form must use the same id the existing submit dispatcher already handles");
  // One name, asked once: the gate collects the circle-facing name and an
  // emoji and derives the handle from the name, so a member is never asked to
  // invent an identifier.
  const form = ui.slice(ui.indexOf("function profileFormHtml"), ui.indexOf("// ---- Pending"));
  assert.match(form, /name="displayName"/);
  assert.match(form, /name="emoji"/);
  assert.doesNotMatch(form, /name="handle"/);
  assert.doesNotMatch(form, /name="bio"/);
});
