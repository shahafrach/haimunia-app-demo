import { parseUnits } from "./_parse.mjs";
const { units } = parseUnits("cloud.js");
const [a,b]=process.argv.slice(2).map(Number);
const sel=units.filter(u=>u.start>=a&&u.start<=b);
console.log(sel.map(u=>u.name).join("\n"));
console.error("count", sel.length, "lines", sel[0].cstart, "-", sel[sel.length-1].end);
