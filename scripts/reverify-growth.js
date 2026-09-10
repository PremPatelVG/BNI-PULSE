// READ-ONLY re-verification of both sheets against live chapters, with correct year
// mapping and the Renewal column included. Writes a CSV for review. No DB writes.
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const NET=process.argv[2]||"C:/Users/Admin/Downloads/Commission Data.xlsx";
const JUN="C:/Users/Admin/Downloads/JUNE 2025.xlsx";
const cellVal=c=>{let v=c.value;if(v&&typeof v==="object"){if(v instanceof Date)return v;if(v.result!==undefined)return v.result;if(v.text!==undefined)return v.text;}return v;};

const live=(await getDb().collection("chapters").get()).docs.map(d=>d.data().name);
const liveSet=new Set(live);

// June baseline
const wbj=new ExcelJS.Workbook();await wbj.xlsx.readFile(JUN);const jsh=wbj.getWorksheet("Sheet1");
const startCount={};for(let r=2;r<=jsh.rowCount;r++){const n=cellVal(jsh.getRow(r).getCell(1));const s=Number(cellVal(jsh.getRow(r).getCell(2)))||0;if(n&&String(n).trim())startCount[String(n).trim()]=s;}

// Commission, block-walk with correct year mapping
const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(NET);const ws=wb.getWorksheet("Netadd");
const usedMonths=new Set();let curM=null,curKey=null;
const agg={};let totalRows=0,skippedNonLive=0,skippedNoChapter=0;const monthOrder=[];
for(let r=2;r<=ws.rowCount;r++){
  const chRaw=cellVal(ws.getRow(r).getCell(1));
  if(chRaw==null||String(chRaw).trim()===""){skippedNoChapter++;continue;}
  const chapter=String(chRaw).trim();
  const neu=Number(cellVal(ws.getRow(r).getCell(3)))||0;
  const drop=Number(cellVal(ws.getRow(r).getCell(4)))||0;
  const ren=Number(cellVal(ws.getRow(r).getCell(5)))||0;
  const d=cellVal(ws.getRow(r).getCell(7));
  if(d instanceof Date&&(d.getMonth()+1)!==curM){
    curM=d.getMonth()+1;let yr=curM>=7?2025:2026;
    while(usedMonths.has(`${yr}-${String(curM).padStart(2,"0")}`))yr++;
    curKey=`${yr}-${String(curM).padStart(2,"0")}`;usedMonths.add(curKey);monthOrder.push(curKey);
  }
  totalRows++;
  if(!liveSet.has(chapter)){skippedNonLive++;continue;}
  const a=agg[chapter]||(agg[chapter]={ind:0,drop:0,ren:0,months:new Set()});
  a.ind+=neu;a.drop+=drop;a.ren+=ren;a.months.add(curKey);
}

console.log(`=== MONTH COVERAGE ===`);
console.log(`blocks/months found: ${[...usedMonths].sort().length}`);
console.log(`months (sorted): ${[...usedMonths].sort().join(", ")}`);
console.log(`Aug 2026 present? ${usedMonths.has("2026-08")?"YES":"NO"}`);
console.log(`\n=== ROW ACCOUNTING (nothing silently dropped) ===`);
console.log(`data rows read: ${totalRows}   skipped (blank chapter): ${skippedNoChapter}   skipped (chapter not live): ${skippedNonLive}   -> aggregated into ${Object.keys(agg).length} live chapters`);

// coverage checks
const netChapters=new Set();for(let r=2;r<=ws.rowCount;r++){const c=cellVal(ws.getRow(r).getCell(1));if(c&&String(c).trim())netChapters.add(String(c).trim());}
const notLive=[...netChapters].filter(c=>!liveSet.has(c)).sort();
const liveNoNet=live.filter(c=>!netChapters.has(c)).sort();
const liveNoJune=live.filter(c=>startCount[c]===undefined).sort();
console.log(`\ncommission chapters total: ${netChapters.size}  (excluded as not-live: ${notLive.length}) -> ${notLive.join(", ")}`);
console.log(`live chapters missing from commission: ${liveNoNet.length} -> ${liveNoNet.join(", ")||"(none)"}`);
console.log(`live chapters missing a June-2025 start: ${liveNoJune.length} -> ${liveNoJune.join(", ")}`);

// per-chapter table + totals
let tInd=0,tDrop=0,tRen=0,tNet=0,tCur=0;
const rows=live.slice().sort().map(name=>{
  const a=agg[name]||{ind:0,drop:0,ren:0,months:new Set()};
  const net=a.ind-a.drop;const base=startCount[name];const start=base===undefined?0:base;const cur=start+net;
  tInd+=a.ind;tDrop+=a.drop;tRen+=a.ren;tNet+=net;tCur+=cur;
  return{name,start:base===undefined?"(new)":base,ind:a.ind,drop:a.drop,net,ren:a.ren,cur,mos:a.months.size};
});
console.log(`\n=== REGION TOTALS (live chapters, ${[...usedMonths].sort().length} months) ===`);
console.log(`Inductions +${tInd}  Drops -${tDrop}  Cum Net Add ${tNet>0?"+":""}${tNet}  Renewals(sheet) ${tRen}  Current ${tCur}`);

console.log(`\ntop/bottom by renewals (sheet Renewal column):`);
[...rows].sort((a,b)=>b.ren-a.ren).slice(0,6).forEach(r=>console.log(`  ${r.name.padEnd(16)} renewals=${String(r.ren).padStart(4)}  net=${r.net>=0?"+":""}${r.net}  cur=${r.cur}`));

const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
const csv=[["Chapter","June2025 Start","Inductions","Drops","Cum Net Add","Current","Renewals (sheet)","Months"],
  ...rows.map(r=>[r.name,r.start,r.ind,r.drop,r.net,r.cur,r.ren,r.mos])].map(a=>a.map(q).join(",")).join("\r\n");
fs.writeFileSync("scripts/reverify-growth.csv",csv,"utf8");
console.log(`\nFull table -> scripts/reverify-growth.csv`);
process.exit(0);
