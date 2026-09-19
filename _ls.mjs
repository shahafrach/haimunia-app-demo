import { parseUnits } from "./_parse.mjs";
const { units } = parseUnits("cloud.js");
const [a,b]=process.argv.slice(2).map(Number);
for(const u of units) if(u.start>=a&&u.start<=b) console.log(u.cstart+"|"+u.start+"-"+u.end, u.kind, u.name);
