// Measures what ONE snapshot refresh actually fetches from Firestore.
// Run in a fresh process so the shared cache is cold. Read-only.
import { buildSnapshot } from "../src/services/firestore.js";

const user = { sub: "measure", role: "ad", chapter: null, chapters: [] }; // unscoped = full fetch
const t0 = Date.now();
const snap = await buildSnapshot(user);
const ms = Date.now() - t0;

let total = 0;
console.log("collection            docs");
for (const [name, rows] of Object.entries(snap.collections)) {
  const n = Array.isArray(rows) ? rows.length : 0;
  total += n;
  console.log("  " + name.padEnd(20) + String(n).padStart(5));
}
const metaCount = Object.keys(snap.meta || {}).length;
console.log("  " + "meta docs".padEnd(20) + String(metaCount).padStart(5));
console.log("\nDOCUMENT READS PER SNAPSHOT REFRESH: " + (total + metaCount) + `   (fetched in ${ms}ms)`);
process.exit(0);
