// Scaled results stand equal to Rx (2026-09-15), from the coaching-platform
// research pass.
//
// WHY THIS IS A LOGGING PROBLEM, NOT A COSMETIC ONE. Our data model already
// gets this right and has for a long time: bestWodScore(id, excludeId, rx)
// keeps an Rx ladder and a scaled ladder separately, so a scaled athlete's
// personal record is a real record. That is better than Wodify, where only Rx
// metcons can be PRs at all. The UI simply never said so - the same three
// words appeared either way, and the board rendered one list where some rows
// carried an Rx badge and the rest were bare.
//
// The consequence is measurable and runs both ways: scaled athletes read an
// unmarked board as "everyone else did the real one" and stop logging, and
// competitive athletes suppress honest scaled results to protect a board
// position. Both end in a thinner log - and every other feature in this app,
// from achievements to the coach dashboard to the club board itself, is built
// on the log. Nothing else works if people stop writing to it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";
import { cloudSource } from "./helpers/community-src.mjs";

const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const cloudJs = cloudSource();

test("the PR flash names the level, so a scaled record is announced as a record", async () => {
  const window = await bootApp();
  // The flash box lives inside renderWodLogSection(), which early-returns
  // until a WOD is actually chosen (COMM-360 made "nothing selected" a real
  // state rather than defaulting to the first entry in the library). So the
  // fixture has to pick one, exactly as a member does, before the box exists.
  window.choosePickedWod("fran");
  window.document.getElementById("tabWodBtn").click();
  // The flash is driven by flashWodPR(rx); assert both branches directly
  // rather than reconstructing a full WOD-logging session for each.
  const box = window.document.getElementById("wodFlashBox");
  assert.ok(box, "the WOD flash box should exist");
  const label = box.querySelector("[data-wod-flash-label]");
  assert.ok(label, "it needs a label hook, or the level can never be named");

  window.flashWodPR(false);
  assert.match(label.textContent, /מסוקיילד/,
    "a scaled PR must say so - an unqualified 'שיא חדש' leaves the athlete unsure the app means it");
  assert.ok(!/\(|\)/.test(label.textContent),
    "and it must not be parenthesised - a bracket reads as an asterisk on the achievement");

  window.flashWodPR(true);
  assert.equal(label.textContent, "שיא חדש!", "an Rx PR keeps the original wording, unchanged");
});

test("the two ladders are genuinely separate in the data, which is what makes the label honest", () => {
  // If the bests were shared, naming the level would be decoration over a
  // single ranking. This asserts the property the copy depends on.
  assert.match(appJs, /function bestWodScore\([^)]*\brx\b/,
    "bestWodScore must take rx, so an Rx best and a scaled best are tracked apart");
});

