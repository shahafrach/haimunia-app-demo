// Renders docs/owner-guide/guide.html to a PDF, using the same Chromium the
// browser checks already depend on. Local file only - nothing is fetched.
import { chromium } from "playwright";

const root = new URL("../../docs/owner-guide/", import.meta.url);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(new URL("guide.html", root).href, { waitUntil: "networkidle" });
await page.emulateMedia({ media: "print" });
await page.pdf({
  path: new URL("haimunia-owner-guide.pdf", root).pathname,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
});
await browser.close();
console.log("pdf written");
