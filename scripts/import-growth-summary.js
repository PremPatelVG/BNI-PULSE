// Build meta/growthSummary in SGT from the two sheets:
//   JUNE 2025.xlsx        -> per-chapter starting member count (June 2025 baseline)
//   Commission Data.xlsx  -> per chapter/month New (inductions), Drop, Netadd
//
// Window: Jul 2025 -> Jul 2026 (all 13 months). The Month column has no year, so the
// year is reconstructed from the month name (Jul-Dec => 2025, Jan-Jun => 2026, plus the
// second July block => 2026). Only chapters that currently exist in SGT are kept.
//
// cumNet  = sum of (New - Drop) over the window
// current = start + cumNet, where start = June-2025 size, or 0 for chapters launched
//           after June 2025 (their launch intake is already counted as inductions).
//
// Dry run (default): node scripts/import-growth-summary.js
// Apply:             node scripts/import-growth-summary.js --write

import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
// Commission file: first non-flag arg, else the latest re-upload. The Month column has
// no year; the day-of-month encodes it (dated "25" => 2025, "26" => 2026), which the
// block-walk below reproduces (Jul-Dec => 2025, Jan-Jun => 2026, repeats bump a year).
const NET = process.argv.slice(2).find(a => !a.startsWith("--")) || "C:/Users/Admin/Downloads/Commission Data (1).xlsx";
const JUN = "C:/Users/Admin/Downloads/JUNE 2025.xlsx";
const db = getDb();

const cellVal = c => { let v=c.value; if(v&&typeof v==="object"){ if(v instanceof Date) return v; if(v.result!==undefined) return v.result; if(v.text!==undefined) return v.text; } return v; };

// live chapters (the ONLY ones we keep)
const live = (await db.collection("chapters").get()).docs.map(d => d.data().name);
const liveSet = new Set(live);

// June 2025 baseline
const wbj = new ExcelJS.Workbook(); await wbj.xlsx.readFile(JUN);
const js = wbj.getWorksheet("Sheet1"); const startCount = {};
for (let r=2;r<=js.rowCount;r++){ const n=cellVal(js.getRow(r).getCell(1)); const s=Number(cellVal(js.getRow(r).getCell(2)))||0; if(n&&String(n).trim()) startCount[String(n).trim()]=s; }

// Commission net-add, aggregated per live chapter over the window
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(NET);
const ws = wb.getWorksheet("Netadd");
const agg = {};
// Walk contiguous month blocks so the two July blocks (2025 vs 2026) stay distinct:
// base year = Jul-Dec -> 2025, Jan-Jun -> 2026; if that year-month was already used
// (i.e. the SECOND July block), bump the year.
const usedMonths = new Set(); let curMonthNum = null;
for (let r=2;r<=ws.rowCount;r++){
  const ch = cellVal(ws.getRow(r).getCell(1)); if(ch==null||String(ch).trim()==="") continue;
  const chapter = String(ch).trim();
  const neu=Number(cellVal(ws.getRow(r).getCell(3)))||0;
  const drop=Number(cellVal(ws.getRow(r).getCell(4)))||0;
  const ren=Number(cellVal(ws.getRow(r).getCell(5)))||0;
  const d=cellVal(ws.getRow(r).getCell(7));
  if (d instanceof Date && (d.getMonth()+1)!==curMonthNum){
    curMonthNum = d.getMonth()+1;
    let yr = curMonthNum>=7 ? 2025 : 2026;
    while (usedMonths.has(`${yr}-${String(curMonthNum).padStart(2,"0")}`)) yr++;
    usedMonths.add(`${yr}-${String(curMonthNum).padStart(2,"0")}`);
  }
  if(!liveSet.has(chapter)) continue;
  const a = agg[chapter] || (agg[chapter]={ind:0,drop:0,ren:0});
  a.ind+=neu; a.drop+=drop; a.ren+=ren;
}
const monthsSeen = usedMonths;

const chapters = {};
let regionCumNet = 0, regionCurrent = 0, regionInd = 0, regionDrop = 0, regionRen = 0;
live.forEach(name => {
  const a = agg[name] || {ind:0,drop:0,ren:0};
  const cumNet = a.ind - a.drop;
  const hasBase = startCount[name] !== undefined;
  const start = hasBase ? startCount[name] : 0;
  const current = start + cumNet;
  // Retention = renewals / (renewals + drops) over the window, from the sheet.
  // A chapter with 0 renewals (no renewal cycle in the window yet, e.g. newly
  // launched) shows null ("-"), not a misleading 0% driven only by early drops.
  const retention = a.ren > 0 ? Math.round((a.ren / (a.ren + a.drop)) * 100) : null;
  chapters[name] = { start, baseline: hasBase, inductions: a.ind, drops: a.drop, renewals: a.ren, cumNet, current, retention };
  regionCumNet += cumNet; regionCurrent += current; regionInd += a.ind; regionDrop += a.drop; regionRen += a.ren;
});

const monthsArr = [...monthsSeen].sort();
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMon = k => { const p = k.split("-"); return `${MON[(+p[1])-1]} ${p[0]}`; };
const windowLabel = monthsArr.length ? `${fmtMon(monthsArr[0])} - ${fmtMon(monthsArr[monthsArr.length-1])}` : "";
const regionDenom = regionRen + regionDrop;
const regionRetention = regionDenom > 0 ? Math.round((regionRen / regionDenom) * 100) : null;

const doc = {
  window: windowLabel,
  monthsCovered: monthsArr.length,
  months: monthsArr,
  regionCumNet, regionCurrent, regionInductions: regionInd, regionDrops: regionDrop,
  regionRenewals: regionRen, regionRetention,
  chaptersCount: Object.keys(chapters).length,
  source: "JUNE 2025.xlsx + Commission Data (1).xlsx",
  updatedAt: new Date().toISOString().slice(0,10),
  uploadedBy: "system (12-month growth import)",
  chapters
};

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}`);
console.log(`  window      : ${doc.window}  (${doc.monthsCovered} months: ${doc.months.join(", ")})`);
console.log(`  live chapters: ${doc.chaptersCount}`);
console.log(`  region cum net add : ${regionCumNet>0?"+":""}${regionCumNet}`);
console.log(`  region inductions/drops: +${regionInd} / -${regionDrop}`);
console.log(`  region renewals    : ${regionRen}   region retention: ${regionRetention===null?"-":regionRetention+"%"}`);
console.log(`  region current members : ${regionCurrent}`);
const noBase = live.filter(n=>startCount[n]===undefined);
console.log(`  chapters started at 0 (no June baseline): ${noBase.length} -> ${noBase.join(", ")}`);

if (!WRITE){ console.log(`\nRe-run with --write to store meta/growthSummary.`); process.exit(0); }
await db.collection("meta").doc("growthSummary").set(doc);
console.log(`\nDONE. Wrote meta/growthSummary (${doc.chaptersCount} chapters).`);
process.exit(0);
