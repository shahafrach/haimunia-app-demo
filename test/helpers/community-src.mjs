// The community layer's files, in the order index.html loads them — read off
// index.html itself rather than listed here, so the two cannot drift.
//
// cloud.js stopped being an IIFE so that src/community/*.js could share its
// scope (see cloud.js's own header). In a real browser that works because
// classic <script> tags share one global lexical environment; jsdom does not
// reproduce that across separate window.eval() calls, which is exactly why
// test/helpers/boot.mjs already concatenates the app's src files before
// eval'ing them. The community files get the same treatment.
//
// ORDER IS LOAD-BEARING, and in the opposite direction from what you might
// guess: the modules come BEFORE cloud.js. cloud.js still holds the core, and
// some of its top-level `const`s are built at evaluation time out of direct
// references to functions that now live in the modules — POST_CARD_RENDERERS
// is the clearest one, mapping each post type to its renderer. A function
// declaration is only available once its own script has run, so a module
// loaded after cloud.js would leave those references unresolved. Nothing goes
// the other way: the modules read core bindings (state, client, A) only from
// inside function bodies, which run long after every script has.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");

/** The src/community/*.js files, in index.html load order. Repo-relative. */
export const COMMUNITY_MODULES = [...indexHtml.matchAll(/<script defer src="\.\/(src\/community\/[^"]+)"><\/script>/g)].map((m) => m[1]);

/** Every file of the community layer, in load order: the modules, then cloud.js. */
export const COMMUNITY_FILES = [...COMMUNITY_MODULES, "cloud.js"];

/**
 * The community layer's source as one string, in load order — the drop-in
 * replacement for `readFileSync(".../cloud.js")` in a source-text test. What
 * such a test asserts is a property of the layer, not of one file of it, and
 * this keeps that true as code moves between them.
 */
export function cloudSource() {
  return COMMUNITY_FILES.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
}

/** One file's source, for a test that really does mean one file. */
export function communityFile(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}
