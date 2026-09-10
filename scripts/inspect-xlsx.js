// READ-ONLY: dump structure + sample rows of one or more .xlsx files.
import ExcelJS from "exceljs";

const files = process.argv.slice(2);
const MAXROWS = 18, MAXCOLS = 24;

for (const f of files) {
  console.log("\n" + "#".repeat(70));
  console.log("FILE:", f);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f);
  console.log("worksheets:", wb.worksheets.map(w => `"${w.name}"`).join(", "));
  wb.worksheets.forEach(ws => {
    console.log(`\n=== sheet "${ws.name}"  rows=${ws.rowCount} cols=${ws.columnCount} ===`);
    const lim = Math.min(ws.rowCount, MAXROWS);
    for (let r = 1; r <= lim; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= Math.min(ws.columnCount, MAXCOLS); c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === "object") {
          if (v.result !== undefined) v = v.result;
          else if (v.text !== undefined) v = v.text;
          else if (v instanceof Date) v = v.toISOString().slice(0,10);
          else v = JSON.stringify(v);
        }
        cells.push(v === null || v === undefined ? "" : String(v));
      }
      console.log(`  r${String(r).padStart(3)}: ${cells.map(x=>x.slice(0,18)).join(" | ")}`);
    }
    if (ws.rowCount > MAXROWS) console.log(`  ... (${ws.rowCount - MAXROWS} more rows)`);
  });
}
process.exit(0);
