// READ-ONLY: walk the Netadd sheet in row order and print each contiguous month block.
import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("C:/Users/Admin/Downloads/Commission Data.xlsx");
const ws = wb.getWorksheet("Netadd");

const cellVal = c => { let v=c.value; if(v&&typeof v==="object"){ if(v instanceof Date) return v; if(v.result!==undefined) return v.result; if(v.text!==undefined) return v.text; } return v; };
const mName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

let blocks = [], cur = null;
for (let r=2; r<=ws.rowCount; r++){
  const ch = cellVal(ws.getRow(r).getCell(1));
  if (ch==null||String(ch).trim()==="") continue;
  const d = cellVal(ws.getRow(r).getCell(7));
  const key = d instanceof Date ? `${mName[d.getMonth()]} (m${d.getMonth()+1})` : String(d);
  if (!cur || cur.key!==key){ cur={key,first:r,count:0}; blocks.push(cur); }
  cur.count++;
}
console.log(`Month blocks in FILE ORDER (${blocks.length} blocks):`);
blocks.forEach((b,i)=>console.log(`  ${String(i+1).padStart(2)}. ${b.key.padEnd(12)} rows from r${b.first}  count=${b.count}`));

// Assume block 1 = Jul 2025 (fiscal start), assign real year by walking forward.
console.log(`\nReconstructed real timeline (assuming block 1 = Jul 2025):`);
let year=2025, prevM=null;
blocks.forEach((b,i)=>{
  const m = /m(\d+)/.exec(b.key); const mm = m?parseInt(m[1]):null;
  if (prevM!==null && mm!==null && mm < prevM) year++; // wrapped past December
  if (mm!==null) { console.log(`  block ${i+1}: ${mName[mm-1]} ${year}  (${b.count} chapters)`); prevM=mm; }
});
process.exit(0);
