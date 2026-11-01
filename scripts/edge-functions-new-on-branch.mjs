// Which Edge Functions exist on this branch but not on main.
//
// check-edge-functions-deployed.mjs asks the live project whether every function in the
// repository is deployed. A function added by a pull request cannot be deployed before
// the merge (deploy-edge-functions runs on main), so on a branch that check would fail
// for exactly the function the branch adds. This names those functions so the check can
// say "new here, deployed by the merge" for them and keep failing for every function that
// is on main and not deployed. On main itself (or when main cannot be read) nothing is
// new: the rule stays strict.
import { execFileSync } from "node:child_process";

/**
 * @param {string[]} names function directory names found in the working tree
 * @param {{ ref?: string, branch?: string, run?: (args: string[]) => string }} [opts]
 * @returns {Set<string>} the names whose index.ts is not on `ref` (default origin/main)
 */
export function functionsNewOnBranch(names, opts = {}) {
  const branch = opts.branch === undefined ? (process.env.GITHUB_REF_NAME || "") : opts.branch;
  const onMainBranch = branch === "main" && !process.env.GITHUB_BASE_REF;
  if (onMainBranch) return new Set();
  const ref = opts.ref || "origin/main";
  const run = opts.run || ((args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  let listing;
  try { listing = run(["ls-tree", "-r", "--name-only", ref, "--", "supabase/functions"]); } catch (e) { return new Set(); }
  const onMain = new Set(listing.split("\n").map((l) => /^supabase\/functions\/([^/]+)\/index\.ts$/.exec(l.trim())).filter(Boolean).map((m) => m[1]));
  // An empty listing means main could not be read properly; do not excuse anything.
  if (!onMain.size) return new Set();
  return new Set(names.filter((n) => !onMain.has(n)));
}
