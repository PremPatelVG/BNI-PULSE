// READ-ONLY: analyze Commission Data "Netadd" sheet + JUNE 2025 sheet against live chapters.
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const NET = "C:/Users/Admin/Downloads/Commission Data.xlsx";
const JUN = "C:/Users/Admin/Downloads/JUNE 2025.xlsx";

const cellVal = c => {
  let v = c.value;
  if (v && typeof v === "object") {
    if (v instanceof Date) return v.toISOString().slice(0,10);
    if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text;
    else return JSON.stringify(v);
  }
  return v;
};
const monthKey = v => {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0,7);
  const s = String(v);
  const m = /(\d{4})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}`;
  return s;
};

// --- Netadd sheet ---
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(NET);
const ws = wb.getWorksheet("Netadd");
const rows = [];
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const chapter = cellVal(row.getCell(1));
  if (chapter == null || String(chapter).trim() === "") continue;
  rows.push({
    chapter: String(chapter).trim(),
    netadd: Number(cellVal(row.getCell(2))) || 0,
    neu: Number(cellVal(row.getCell(3))) || 0,
    drop: Number(cellVal(row.getCell(4))) || 0,
    renewal: Number(cellVal(row.getCell(5))) || 0,
    dc: cellVal(row.getCell(6)),
    monthRaw: cellVal(row.getCell(7)),
    month: monthKey(cellVal(row.getCell(7))),
    srdc: cellVal(row.getCell(8))
  });
}
console.log(`Netadd rows: ${rows.length}`);
const months = [...new Set(rows.map(r=>r.month))].sort();
console.log(`distinct months (${months.length}): ${months.join(", ")}`);
const perMonth = {}; rows.forEach(r=>{perMonth[r.month]=(perMonth[r.month]||0)+1;});
console.log(`rows per month:`, JSON.stringify(perMonth));
const chapters = [...new Set(rows.map(r=>r.chapter))].sort();
console.log(`distinct chapters (${chapters.length})`);
// integrity: does netadd == new - drop?
const bad = rows.filter(r => r.netadd !== (r.neu - r.drop));
console.log(`rows where netadd != new-drop: ${bad.length}`);
if (bad.length) bad.slice(0,5).forEach(r=>console.log(`   ${r.chapter} ${r.month}: netadd=${r.netadd} new=${r.neu} drop=${r.drop}`));
console.log(`sample srdc values:`, [...new Set(rows.map(r=>String(r.srdc)))].slice(0,4));
console.log(`\nsample rows across the file:`);
[0, Math.floor(rows.length/2), rows.length-1].forEach(i=>{const r=rows[i];console.log(`   [${i}] ${r.chapter} | m=${r.month} | net=${r.netadd} new=${r.neu} drop=${r.drop} ren=${r.renewal} dc=${r.dc}`);});

// --- June 2025 sheet ---
const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.readFile(JUN);
const js = wb2.getWorksheet("Sheet1");
const juneStart = {};
for (let r = 2; r <= js.rowCount; r++) {
  const nm = cellVal(js.getRow(r).getCell(1)); const sz = Number(cellVal(js.getRow(r).getCell(2)))||0;
  if (nm && String(nm).trim()) juneStart[String(nm).trim()] = sz;
}
console.log(`\nJune 2025 chapters: ${Object.keys(juneStart).length}`);

// --- live chapters ---
const live = (await getDb().collection("chapters").get()).docs.map(d=>d.data().name);
console.log(`live SGT chapters: ${live.length}`);
const liveSet = new Set(live);
const netNotLive = chapters.filter(c=>!liveSet.has(c));
const juneNotLive = Object.keys(juneStart).filter(c=>!liveSet.has(c));
const liveNoJune = live.filter(c=>juneStart[c]===undefined);
const liveNoNet = live.filter(c=>!chapters.includes(c));
console.log(`\nNetadd chapters NOT live (would be excluded): ${netNotLive.length}  -> ${netNotLive.join(", ")}`);
console.log(`June-2025 chapters NOT live (excluded): ${juneNotLive.length}  -> ${juneNotLive.join(", ")}`);
console.log(`live chapters with NO June-2025 start: ${liveNoJune.length}  -> ${liveNoJune.join(", ")}`);
console.log(`live chapters with NO Netadd rows: ${liveNoNet.length}  -> ${liveNoNet.join(", ")}`);
process.exit(0);
