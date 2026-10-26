#!/usr/bin/env node
// Share cards (src/share-cards.js) painted for real in Chromium: both cards
// are 1080x1350, are not blank, and a PNG of each is saved. jsdom has no
// canvas, so this is the only place the painting is exercised.
//
// PNGs go to $BROWSER_CHECK_ARTIFACTS if set, else <tmpdir>/boxlog-share-cards.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const outDir = process.env.BROWSER_CHECK_ARTIFACTS || path.join(tmpdir(), "boxlog-share-cards");
mkdirSync(outDir, { recursive: true });

const target = await resolveLocalOnlyTarget();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(target.url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.boxlogShareCards);

const CASES = {
  "pr-lift": ["renderPrCard", { memberName: "דנה כהן", memberEmoji: "🔥", lift: "סקוואט", percent: 7.5, weight: 102.5, previousWeight: 95, showWeight: false, date: "2026-10-26" }],
  "pr-benchmark": ["renderPrCard", { memberName: "יוסי", memberEmoji: "🏃", benchmark: { name: "Fran", result: "8:42", rx: true }, date: "2026-10-26" }],
  "week-friends": ["renderWeekCard", { circleName: "החבר'ה מהקרוספיט", circleEmoji: "💪", type: "friends", weeks: [{ label: "19.10 - 25.10", members: [
    { name: "דנה", emoji: "🔥", percent: 100, weeksMet: 6 }, { name: "יוסי", emoji: "🏃", percent: 50, weeksMet: 1 },
    { name: "נועה", emoji: "🧘", percent: 0, paused: true, weeksMet: 3 }, { name: "Alex with a very long name indeed", emoji: "🚴", percent: 75 } ] }] }],
  "week-couple": ["renderWeekCard", { circleName: "אנחנו", circleEmoji: "💑", type: "couple", weeks: [
    { label: "השבוע", members: [{ name: "דנה", emoji: "🔥", percent: 80, weeksMet: 4 }, { name: "רון", emoji: "🏋️", percent: 120, weeksMet: 7 }] },
    { label: "שבוע שעבר", members: [{ name: "דנה", emoji: "🔥", percent: 100, weeksMet: 3 }, { name: "רון", emoji: "🏋️", percent: 60, paused: false, weeksMet: 6 }] }] }],
};

await page.evaluate(() => window.boxlogShareCards.ensureFonts());
for (const [name, [fn, data]] of Object.entries(CASES)) {
  const r = await page.evaluate(([fn, data]) => {
    const canvas = window.boxlogShareCards[fn](data);
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const px = ctx.getImageData(0, 0, width, height).data;
    const bg = [px[0], px[1], px[2]];
    // Count pixels that differ from the background colour sampled at (0,0)
    // below the top accent rule, i.e. at (0, 20).
    const o = 20 * width * 4;
    const ref = [px[o], px[o + 1], px[o + 2]];
    let diff = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] !== ref[0] || px[i + 1] !== ref[1] || px[i + 2] !== ref[2]) diff++;
    return { width, height, diff, total: width * height, png: canvas.toDataURL("image/png"), bg };
  }, [fn, data]);
  check(`${name}: 1080x1350`, r.width === 1080 && r.height === 1350, `${r.width}x${r.height}`);
  check(`${name}: not blank`, r.diff > r.total * 0.01, `${((r.diff / r.total) * 100).toFixed(1)}% of pixels differ from the background`);
  writeFileSync(path.join(outDir, `share-card-${name}.png`), Buffer.from(r.png.split(",")[1], "base64"));
}

// shareCard falls back to a download when files cannot be shared.
const dl = page.waitForEvent("download", { timeout: 5000 });
const result = await page.evaluate(async () => {
  Object.defineProperty(navigator, "canShare", { value: () => false, configurable: true });
  return window.boxlogShareCards.shareCard(window.boxlogShareCards.renderPrCard({ memberName: "דנה", lift: "סקוואט", percent: 5 }), "text");
});
const download = await dl.catch(() => null);
check("shareCard downloads the PNG when file sharing is unavailable", result === "downloaded" && !!download && download.suggestedFilename() === "box-log.png", String(result));

// ...and shares the file alone when it can.
const shared = await page.evaluate(async () => {
  let payload = null;
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  Object.defineProperty(navigator, "share", { value: async (p) => { payload = p; }, configurable: true });
  const res = await window.boxlogShareCards.shareCard(window.boxlogShareCards.renderPrCard({ memberName: "דנה", lift: "סקוואט", percent: 5 }), "text");
  return { res, files: payload && payload.files.map((f) => [f.type, f.size > 1000]), keys: payload && Object.keys(payload) };
});
check("shareCard shares one PNG file alone", shared.res === "shared" && shared.files.length === 1 && shared.files[0][0] === "image/png" && shared.files[0][1] && shared.keys.join() === "files", JSON.stringify(shared));

check("no page errors", errors.length === 0, errors.join(" | "));
console.log(`PNGs saved to ${outDir}`);
await browser.close();
await target.close();
process.exit(failed ? 1 : 0);
