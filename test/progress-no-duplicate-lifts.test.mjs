// Every lift appears ONCE on the progress screen (התקדמות).
//
// The Benchmarks section used to append a row per lift the member had a 1RM
// estimate for. Once benchmarks moved below the all-time records list, the
// screen read: every lift with its sets and estimated 1RM, then Benchmarks,
// then the same lifts again showing only the estimate, then body weight. The
// lift card in the records list is the one place a lift lives on this screen;
// these tests count by the lift's NAME across the whole page, not by one
// renderer's markup, so a second copy fails here whichever function draws it.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

const LIFTS = ["Dup Check Back Squat", "Dup Check Deadlift"];

async function seedLift(window, name, category, weight, reps) {
  await window.addMovement(name, category);
  const movement = window.allMovements().find((m) => m.name === name);
  const d = new Date();
  d.setDate(d.getDate() - 3);
  const date = window.localISODate(d);
  await window.dbPut({
    id: window.uid("set"), exerciseId: movement.id, date, type: "reps",
    weight, reps, sets: 1, ts: new Date(`${date}T09:00:00`).getTime(),
  });
  await window.reloadFromDb();
  return movement;
}

async function progressScreen({ benchmarks }) {
  const window = await bootApp();
  await seedLift(window, LIFTS[0], "Squat", 100, 5);
  await seedLift(window, LIFTS[1], "Deadlift", 140, 3);
  window.setClubFeatureFlags({ benchmarks: { enabled: benchmarks, config: {} } });
  window.render();
  window.document.getElementById("tabHistoryBtn").click();
  const page = window.document.querySelector('[aria-labelledby="pageTitle-history"]');
  assert.ok(page, "the progress screen rendered");
  return { window, page };
}

const occurrences = (text, needle) => text.split(needle).length - 1;

for (const benchmarks of [true, false]) {
  test(`each lift appears exactly once on the progress screen (benchmarks ${benchmarks ? "on" : "off"})`, async () => {
    const { window, page } = await progressScreen({ benchmarks });
    if (benchmarks) assert.ok(window.document.getElementById("benchmarkArea").firstElementChild, "the benchmarks section is on screen");
    for (const name of LIFTS) {
      assert.equal(occurrences(page.textContent, name), 1, `"${name}" is on the progress screen once, not twice`);
      const rowsNamingIt = [...page.querySelectorAll("button")].filter((b) => b.textContent.includes(name));
      assert.equal(rowsNamingIt.length, 1, `one row for "${name}"`);
    }
  });
}

test("the estimated 1RM stays on the exercise card, and the order is exercises, Benchmarks, body weight", async () => {
  const { window } = await progressScreen({ benchmarks: true });
  const doc = window.document;
  const list = doc.getElementById("historyListArea");
  for (const name of LIFTS) {
    const m = window.allMovements().find((x) => x.name === name);
    const card = list.querySelector(`[data-action="select-history"][data-id="${m.id}"]`);
    assert.ok(card, `"${name}" has its exercise card`);
    assert.match(card.textContent, new RegExp(`1RM משוער ${window.bestEst1RM(m.id)}`), "with its estimated 1RM on it");
  }
  const bench = doc.getElementById("benchmarkArea");
  const FOLLOWING = window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(list.compareDocumentPosition(bench) & FOLLOWING, "Benchmarks come after the exercises");
  assert.ok(bench.compareDocumentPosition(doc.getElementById("bodyweightArea")) & FOLLOWING, "and body weight after Benchmarks");
});
