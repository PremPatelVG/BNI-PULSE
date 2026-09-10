// READ-ONLY: month-by-month (chronological) for the 9 live chapters lacking a June-2025 baseline.
import ExcelJS from "exceljs";
const NET="C:/Users/Admin/Downloads/Commission Data.xlsx";
const cellVal=c=>{let v=c.value;if(v&&typeof v==="object"){if(v instanceof Date)return v;if(v.result!==undefined)return v.result;if(v.text!==undefined)return v.text;}return v;};
const TARGET=new Set(["Alethia","BNI Calibos","BNI Florentino","BNI Mythos","Kleon","Romulus","Rubens","Themis","Tyche"]);
const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(NET);const ws=wb.getWorksheet("Netadd");
const byCh={};
for(let r=2;r<=ws.rowCount;r++){
  const ch=cellVal(ws.getRow(r).getCell(1));if(ch==null)continue;const chapter=String(ch).trim();
  if(!TARGET.has(chapter))continue;
  const neu=Number(cellVal(ws.getRow(r).getCell(3)))||0,drop=Number(cellVal(ws.getRow(r).getCell(4)))||0,net=Number(cellVal(ws.getRow(r).getCell(2)))||0;
  const d=cellVal(ws.getRow(r).getCell(7));let mk="?";if(d instanceof Date){const m=d.getMonth()+1;const yr=m>=7?2025:2026;mk=`${yr}-${String(m).padStart(2,"0")}`;}
  (byCh[chapter]=byCh[chapter]||[]).push({mk,neu,drop,net});
}
for(const ch of [...TARGET].sort()){
  const rows=(byCh[ch]||[]).sort((a,b)=>a.mk.localeCompare(b.mk));
  let run=0;
  console.log(`\n### ${ch}  (${rows.length} months)`);
  rows.forEach(r=>{run+=r.net;console.log(`   ${r.mk}: new=${String(r.neu).padStart(3)} drop=${String(r.drop).padStart(3)} net=${String(r.net).padStart(4)}  running=${run}`);});
}
process.exit(0);
