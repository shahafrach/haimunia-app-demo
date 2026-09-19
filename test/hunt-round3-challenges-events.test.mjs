// Live bug hunt, fresh round 3 (2026-09-15) — challenges, events, counts of one.
//
// Two of the three came from deliberately hunting SIBLINGS of round 2's
// "1 חברי מועדון": every place a Hebrew plural noun sits beside a raw number.
// Both are reachable by ordinary configuration rather than by edge cases — a
// challenge is in its final day exactly once, every time, and once-a-week is
// the gentlest setting the create form's own min="1" allows a coach to pick.
//
// The third is a real logic gap: the event LIST correctly filed a finished
// event under "past" while the event DETAIL still offered a working RSVP,
// because the two asked different questions about the same event.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

import { cloudSource } from "./helpers/community-src.mjs";
// The community layer, not one file of it — the events half of this file
// moved to src/community/events.js. Every pattern below is unchanged.
const cloudJs = cloudSource();

test("a challenge in its last day does not say '1 ימים נותרו'", () => {
  const at = cloudJs.indexOf("function daysRemainingLabel(n)");
  assert.ok(at > -1, "the label is a helper, not an inline template");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /count === 1 \? "יום אחד נותר"/, "singular for one day");
  assert.match(body, /`\$\{count\} ימים נותרו`/, "plural otherwise");
  assert.match(cloudJs, /\$\{daysRemainingLabel\(days\)\}/, "the cooperative panel uses it");
  assert.ok(!/` · \$\{days\} ימים נותרו`/.test(cloudJs), "the raw plural must be gone");
});

test("a once-a-week consistency challenge does not say '1 אימונים בשבוע'", () => {
  const at = cloudJs.indexOf("function sessionsPerWeekLabel(n)");
  assert.ok(at > -1, "the label is a helper");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /count === 1 \? "אימון אחד בשבוע"/, "singular for one session");
  // Both render sites go through it - the bug was in two places, not one.
  const uses = cloudJs.split("sessionsPerWeekLabel(timesPerWeek)").length - 1;
  assert.equal(uses, 2, `both consistency panels must use the helper, found ${uses}`);
  assert.ok(!/\$\{timesPerWeek\} אימונים בשבוע/.test(cloudJs), "no raw plural left");
  // And the third site, the attendance-check message.
  assert.match(cloudJs, /timesPerWeek === 1 \? "פעם אחת" : `\$\{timesPerWeek\} פעמים`/,
    "the attendance-check message agrees with its own number too");
});

test("an event that has already happened cannot be RSVP'd to", () => {
  // HIGH, reproduced live: a published event that ended three days ago, with
  // no registration_deadline set, rendered an ENABLED "going" button and
  // writing a real event_attendees row succeeded.
  //
  // registration_deadline is optional and usually unset, so keying closure on
  // it alone meant most events never closed at all. isPastEvent() - which the
  // LIST already used to file the event under "אירועים שהסתיימו" - is the
  // signal the rest of the file trusts, and the detail view simply never
  // asked it.
  const at = cloudJs.indexOf("function eventRegistrationClosed(e)");
  assert.ok(at > -1, "the closure test exists");
  const body = cloudJs.slice(at, cloudJs.indexOf("\n  }", at));
  assert.match(body, /if \(isPastEvent\(e\)\) return true;/,
    "a past, finished or cancelled event is closed regardless of any deadline");
  assert.match(body, /e\.registration_deadline/, "an explicit deadline still closes it early");
  // The control: the old one-liner tested the deadline and nothing else.
  assert.ok(!/function eventRegistrationClosed\(e\) \{ return !!\(e && e\.registration_deadline/.test(cloudJs),
    "the deadline-only version must be gone");
  // isPastEvent must still be defined before it is used here.
  assert.ok(cloudJs.indexOf("function isPastEvent(e)") > -1, "isPastEvent still exists");
});
