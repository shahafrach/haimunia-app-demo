// Audit L13 (2026-11): the install splash and the first-paint browser chrome
// used the old gym palette (#141312, #F6F3EC) while the app opens on the
// default classic palette, so a launch flashed the wrong colour. They now
// carry classic's background, read here from tokens.css so the two cannot drift.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

test("the manifest and the first-paint theme-color match the default palette's background", () => {
  const m = /--pal-bg:light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/.exec(read("tokens.css"));
  assert.ok(m, "tokens.css declares the default --pal-bg as light-dark(light, dark)");
  const [, light, dark] = m;
  const theme = JSON.parse(read("src/theme.js").match(/DEFAULTS = Object\.freeze\((\{[^}]*\})\)/)[1].replace(/(\w+):/g, '"$1":'));
  assert.equal(theme.palette, "classic");
  const manifest = JSON.parse(read("manifest.json"));
  const want = theme.theme === "dark" ? dark : light;
  assert.equal(manifest.background_color.toLowerCase(), want.toLowerCase(), "splash background");
  assert.equal(manifest.theme_color.toLowerCase(), want.toLowerCase(), "splash theme colour");
  const html = read("index.html");
  assert.match(html, new RegExp(`theme-color" content="${light}" media="\\(prefers-color-scheme: light\\)"`, "i"));
  assert.match(html, new RegExp(`theme-color" content="${dark}" media="\\(prefers-color-scheme: dark\\)"`, "i"));
});
