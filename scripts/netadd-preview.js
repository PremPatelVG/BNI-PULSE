// READ-ONLY preview: cumulative net add (+ renewals) per LIVE chapter, using the
// month-NAME reconstruction (Jul->Dec = 2025, Jan->Jun = 2026, 2nd Jul = 2026).
// Writes a CSV for review. No database writes.
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const NET = "C:/Users/Admin/Downloads/Commission Data.xlsx";
const JUN = "C:/Users/Admin/Downloads/JUNE 2025.xlsx";
const OUT = "scripts/netadd-preview.csv";

const cellVal = c => { let v=c.value; if(v&&typeof v==="object"){ if(v instanceof Date) return v; if(v.result!==undefined) return v.result; if(v.text!==undefined) return v.text; } return v; };

// live chapters
const live = (await getDb().collection("chapters").get()).docs.map(d=>d.data().name);
const liveSet = new Set(live);

// June 2025 start
const wbj = new ExcelJS.Workbook(); await wbj.xlsx.readFile(JUN);
const js = wbj.getWorksheet("Sheet1"); const start = {};
for (let r=2;r<=js.rowCount;r++){ const n=cellVal(js.getRow(r).getCell(1)); const s=Number(cellVal(js.getRow(r).getCell(2)))||0; if(n) start[String(n).trim()]=s; }

// netadd rows -> per chapter totals over the whole available span
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(NET);
const ws = wb.getWorksheet("Netadd");
let julSeen = 0;
const agg = {}; // chapter -> {ind, drop, net, ren, months:Set}
const monthName=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
for (let r=2;r<=ws.rowCount;r++){
  const ch = cellVal(ws.getRow(r).getCell(1)); if(ch==null||String(ch).trim()==="") continue;
  const chapter=String(ch).trim();
  const neu=Number(cellVal(ws.getRow(r).getCell(3)))||0;
  const drop=Number(cellVal(ws.getRow(r).getCell(4)))||0;
  const net=Number(cellVal(ws.getRow(r).getCell(2)))||0;
  const ren=Number(cellVal(ws.getRow(r).getCell(5)))||0;
  const d=cellVal(ws.getRow(r).getCell(7));
  let mk="?"; if(d instanceof Date){ const m=d.getMonth()+1; const yr = m>=7 ? 2025 : 2026; mk=`${yr}-${String(m).padStart(2,"0")}`; }
  if(!liveSet.has(chapter)) continue;
  const a = agg[chapter] || (agg[chapter]={ind:0,drop:0,net:0,ren:0,months:new Set()});
  a.ind+=neu; a.drop+=drop; a.net+=net; a.ren+=ren; a.months.add(mk);
}

const rows = live.slice().sort().map(ch=>{
  const a=agg[ch]||{ind:0,drop:0,net:0,ren:0,months:new Set()};
  const s = start[ch];
  const implied = s===undefined ? "" : (s + a.net);
  return { ch, start: s===undefined?"(none)":s, ind:a.ind, drop:a.drop, net:a.net, implied, ren:a.ren, months:a.months.size };
});

// console summary
console.log(`Live chapters: ${live.length}   (rows below sorted by cumulative net add)`);
const sorted=[...rows].sort((a,b)=>b.net-a.net);
console.log(`\n  ${"Chapter".padEnd(18)} Jun25  Ind  Drop  NetAdd  ~Current  Renew  Mos`);
sorted.slice(0,12).forEach(r=>console.log(`  ${r.ch.padEnd(18)} ${String(r.start).padStart(5)} ${String(r.ind).padStart(4)} ${String(r.drop).padStart(5)} ${String(r.net).padStart(7)} ${String(r.implied).padStart(9)} ${String(r.ren).padStart(6)} ${String(r.months).padStart(4)}`));
console.log("  ...");
sorted.slice(-6).forEach(r=>console.log(`  ${r.ch.padEnd(18)} ${String(r.start).padStart(5)} ${String(r.ind).padStart(4)} ${String(r.drop).padStart(5)} ${String(r.net).padStart(7)} ${String(r.implied).padStart(9)} ${String(r.ren).padStart(6)} ${String(r.months).padStart(4)}`));

const noBase = rows.filter(r=>r.start==="(none)").map(r=>r.ch);
console.log(`\nLive chapters with NO June-2025 baseline (${noBase.length}): ${noBase.join(", ")}`);
const totalNet = rows.reduce((s,r)=>s+r.net,0);
console.log(`Region cumulative net add (all live chapters): ${totalNet}`);

// CSV
const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
const csv=[["Chapter","June2025 Start","Inductions","Drops","Cum Net Add","Implied Current","Renewals(sum)","Months w/ data"],
  ...rows.map(r=>[r.ch,r.start,r.ind,r.drop,r.net,r.implied,r.ren,r.months])].map(a=>a.map(q).join(",")).join("\r\n");
fs.writeFileSync(OUT,csv,"utf8");
console.log(`\nFull 58-chapter table written to ${OUT}`);
process.exit(0);
