// Seed meta/barterCategories in SGT from the V2 categories workbook.
// Bold cells = main categories; non-bold rows under them = sub-categories.
//
// Dry run (default): node scripts/seed-barter-categories.js
// Apply:             node scripts/seed-barter-categories.js --write

import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const FILE = process.argv.slice(2).find(a => !a.startsWith("--")) || "C:/Users/Admin/Downloads/V2 Categories may 2026.xlsx";

const valOf = c => { let v = c.value; if (v && typeof v === "object") { if (v.result !== undefined) v = v.result; else if (v.text !== undefined) v = v.text; else if (v.richText) v = v.richText.map(t => t.text).join(""); } return v == null ? "" : String(v).trim(); };
const isBold = c => (c.font && c.font.bold) || (c.value && typeof c.value === "object" && Array.isArray(c.value.richText) && c.value.richText.some(t => t.font && t.font.bold));

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.worksheets[0];

const tree = []; let cur = null;
for (let r = 1; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  let cell = null, text = "";
  for (let c = 1; c <= Math.min(ws.columnCount, 6); c++) { const cc = row.getCell(c); const t = valOf(cc); if (t) { cell = cc; text = t; break; } }
  if (!text) continue;
  if (isBold(cell)) { cur = { main: text, subs: [] }; tree.push(cur); }
  else if (cur) { if (!cur.subs.includes(text)) cur.subs.push(text); }
}

const subCount = tree.reduce((s, m) => s + m.subs.length, 0);
const doc = {
  tree,
  mainCount: tree.length,
  subCount,
  source: "V2 Categories may 2026.xlsx",
  updatedAt: new Date().toISOString().slice(0, 10)
};

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}`);
console.log(`  main categories: ${doc.mainCount}   sub-categories: ${doc.subCount}`);
console.log(`  sample: ${tree.slice(0, 3).map(m => `${m.main}(${m.subs.length})`).join(", ")}`);

if (!WRITE) { console.log(`\nRe-run with --write to store meta/barterCategories.`); process.exit(0); }
await getDb().collection("meta").doc("barterCategories").set(doc);
console.log(`\nDONE. Wrote meta/barterCategories (${doc.mainCount} mains, ${doc.subCount} subs).`);
process.exit(0);
