// READ-ONLY: read the categories workbook, using BOLD to mark main categories and
// non-bold rows under them as sub-categories. Prints structure + a hierarchy sample.
import ExcelJS from "exceljs";
import fs from "node:fs";
const FILE = process.argv[2] || "C:/Users/Admin/Downloads/V2 Categories may 2026.xlsx";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);

console.log("worksheets:", wb.worksheets.map(w => `"${w.name}"(${w.rowCount}r x ${w.columnCount}c)`).join(", "));

const valOf = c => { let v = c.value; if (v && typeof v === "object") { if (v.result !== undefined) v = v.result; else if (v.text !== undefined) v = v.text; else if (v.richText) v = v.richText.map(t=>t.text).join(""); } return v == null ? "" : String(v).trim(); };
const isBold = c => {
  if (c.font && c.font.bold) return true;
  // richText can carry per-run bold
  if (c.value && typeof c.value === "object" && Array.isArray(c.value.richText)) return c.value.richText.some(t => t.font && t.font.bold);
  return false;
};

for (const ws of wb.worksheets) {
  console.log(`\n=== sheet "${ws.name}" ===`);
  // find the column(s) that hold text
  let mainCount = 0, subCount = 0, blank = 0;
  const hierarchy = []; let cur = null;
  const firstCol = 1; // assume col 1; also scan col 2 if col1 empty
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // pick the first non-empty cell in the row
    let cell = null, text = "";
    for (let c = 1; c <= Math.min(ws.columnCount, 6); c++) { const cc = row.getCell(c); const t = valOf(cc); if (t) { cell = cc; text = t; break; } }
    if (!text) { blank++; continue; }
    const bold = isBold(cell);
    if (bold) { cur = { main: text, subs: [] }; hierarchy.push(cur); mainCount++; }
    else { if (!cur) { cur = { main: "(no header)", subs: [] }; hierarchy.push(cur); } cur.subs.push(text); subCount++; }
  }
  console.log(`main categories (bold): ${mainCount}   sub-categories: ${subCount}   blank rows: ${blank}`);
  console.log(`\nHierarchy (first 8 mains):`);
  hierarchy.slice(0, 8).forEach(h => {
    console.log(`  ▸ ${h.main}  (${h.subs.length} subs)`);
    h.subs.slice(0, 6).forEach(s => console.log(`      - ${s}`));
    if (h.subs.length > 6) console.log(`      ... +${h.subs.length - 6} more`);
  });
  console.log(`\nAll main categories: ${hierarchy.map(h=>h.main).join(" | ")}`);
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Main Category", "Sub-Category"]];
  hierarchy.forEach(h => h.subs.forEach(s => lines.push([h.main, s])));
  fs.writeFileSync("scripts/categories-taxonomy.csv", lines.map(a => a.map(q).join(",")).join("\r\n"), "utf8");
  console.log(`\nCSV -> scripts/categories-taxonomy.csv (${lines.length - 1} main/sub rows)`);
}
process.exit(0);
