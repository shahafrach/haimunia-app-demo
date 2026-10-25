// Renders the BOX-LOG PNG icons from assets/app-icon.svg.
//
// Not part of the app and not a dependency: it borrows the Playwright +
// Chromium that is already installed on a dev machine or CI image
// (`require('playwright')` must resolve; nothing is added to package.json).
//   node scripts/render-icons.mjs
//
// The artwork fills the full square, so the same render serves "any" and
// "maskable": the mark sits inside the central 60%, the maskable safe zone.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = new URL("../", import.meta.url);
const svg = readFileSync(new URL("assets/app-icon.svg", root), "utf8");
const OUT = [
  ["icon-192.png", 192], ["icon-512.png", 512],
  ["icon-192-maskable.png", 192], ["icon-512-maskable.png", 512],
];

const browser = await chromium.launch();
try {
  for (const [file, size] of OUT) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    writeFileSync(new URL(file, root), await page.screenshot({ type: "png", omitBackground: false }));
    await page.close();
    console.log("wrote", file);
  }
} finally { await browser.close(); }
