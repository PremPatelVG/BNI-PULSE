// READ-ONLY: dump RAW Month/SRDC cell internals to reconstruct the true timeline.
import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("C:/Users/Admin/Downloads/Commission Data.xlsx");
const ws = wb.getWorksheet("Netadd");

function describe(cell) {
  const v = cell.value;
  const t = v === null ? "null" : (v instanceof Date ? "Date" : typeof v);
  let detail = "";
  if (v instanceof Date) detail = v.toISOString();
  else if (v && typeof v === "object") detail = JSON.stringify(v);
  else detail = String(v);
  return `type=${t} numFmt=${cell.numFmt||""} text="${cell.text||""}" val=${detail}`;
}

// First 6 rows + rows 60-70 (July->next month boundary) + a late block
const ranges = [[2,7],[58,72],[120,130],[180,190]];
for (const [a,b] of ranges) {
  console.log(`\n--- rows ${a}..${b} ---`);
  for (let r=a; r<=b; r++) {
    const row = ws.getRow(r);
    console.log(`r${r}: chapter="${row.getCell(1).text}"  MONTH(7): ${describe(row.getCell(7))}   SRDC(8): ${describe(row.getCell(8))}`);
  }
}
process.exit(0);
