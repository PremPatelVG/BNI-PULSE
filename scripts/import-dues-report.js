// Imports a Members Due report (.xlsx) into meta/dues (the renewals data).
// Columns are detected by header. Name is built from the two name columns.
// Merge behaviour mirrors the app's dues upload:
//   - the new report is the base (add/update every member in it)
//   - phone numbers are carried over from the existing data when a member matches
//     (this report has no phone column)
//   - "lapsed" members (already past due, not renewed) that dropped off the new
//     report are preserved so they don't silently vanish from renewals
//
// Dry run (default): node scripts/import-dues-report.js --file="C:/path/report.xlsx"
// Apply:             node scripts/import-dues-report.js --file="C:/path/report.xlsx" --write

import fs from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const FILE = process.argv.find(a => a.startsWith("--file="))?.slice(7) || "C:/Users/Admin/Downloads/Membership Due report.xlsx";
const OUTPUT = process.argv.find(a => a.startsWith("--output="))?.slice(9) || "";
const TODAY = new Date().toISOString().slice(0, 10);

const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const cellVal = v => (v && typeof v === "object") ? (v.text !== undefined ? v.text : (v.result !== undefined ? v.result : "")) : v;
const key = m => norm(m.chapter) + "|" + norm(m.name);
const doneKey = m => `${m.chapter || ""}_${m.name || ""}_${m.dueDate || ""}`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
function toDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(cellVal(v) || "").replace(/["']/g, "").trim();
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s); return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

// --- parse the report ---
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.worksheets[0];
const hdr = ws.getRow(1);
let chapterCol = 0, industryCol = 0, typeCol = 0, statusCol = 0, dueCol = 0, phoneCol = 0;
const nameCols = [];
for (let c = 1; c <= ws.actualColumnCount; c++) {
  const h = norm(cellVal(hdr.getCell(c).value));
  if (!h) continue;
  if (!chapterCol && h.includes("chapter")) chapterCol = c;
  else if (!industryCol && h.includes("industr")) industryCol = c;
  else if (!statusCol && h.includes("status")) statusCol = c;
  else if (!dueCol && h.includes("due")) dueCol = c;
  else if (!phoneCol && (h.includes("phone") || h.includes("mobile") || h.includes("iphone"))) phoneCol = c;
  else if (h.includes("autorenewal") || h.includes("renewal")) { /* skip */ }
  else if (!typeCol && h === "type") typeCol = c;
  else if (h.includes("sort") || h.includes("first") || h.includes("last") || h.includes("name")) nameCols.push(c);
}
const newMembers = [];
ws.eachRow({ includeEmpty: false }, (row, rn) => {
  if (rn === 1) return;
  const chapter = String(cellVal(row.getCell(chapterCol).value) || "").trim();
  const name = nameCols.map(c => String(cellVal(row.getCell(c).value) || "").trim()).join(" ").replace(/\s+/g, " ").trim();
  if (!chapter || !name) return;
  newMembers.push({
    chapter, name,
    industry: industryCol ? String(cellVal(row.getCell(industryCol).value) || "").trim() : "",
    type: typeCol ? String(cellVal(row.getCell(typeCol).value) || "").trim() : "",
    status: statusCol ? String(cellVal(row.getCell(statusCol).value) || "").trim() : "",
    dueDate: dueCol ? toDate(row.getCell(dueCol).value) : "",
    phone: phoneCol ? String(cellVal(row.getCell(phoneCol).value) || "").trim() : ""
  });
});

// --- load existing dues + renewalsDone ---
const db = getDb();
const duesDoc = await db.collection("meta").doc("dues").get();
const oldMembers = (duesDoc.exists && Array.isArray(duesDoc.data().members)) ? duesDoc.data().members : [];
const oldByKey = new Map(oldMembers.map(m => [key(m), m]));
const renewedKeys = new Set((await db.collection("renewalsDone").get()).docs.map(d => d.id));

// carry over phone from prior data when the new row has none
for (const m of newMembers) { if (!m.phone) { const o = oldByKey.get(key(m)); if (o && o.phone) m.phone = o.phone; } }

// preserve lapsed members that dropped off the new report
const newKeys = new Set(newMembers.map(key));
const lapsed = oldMembers.filter(o =>
  o.chapter && o.name && o.dueDate &&
  !newKeys.has(key(o)) &&
  o.dueDate < TODAY &&
  !renewedKeys.has(doneKey(o)) &&
  !renewedKeys.has(`${o.chapter}_${o.name}_${o.dueDate}`)
);
const merged = [...newMembers, ...lapsed];

// --- report ---
const chapters = [...new Set(newMembers.map(m => m.chapter))].sort();
const dueSoon = merged.filter(m => m.dueDate && m.dueDate >= TODAY && m.dueDate <= new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)).length;
const overdue = merged.filter(m => m.dueDate && m.dueDate < TODAY).length;
const noDue = newMembers.filter(m => !m.dueDate).length;
const withPhone = merged.filter(m => m.phone).length;
console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}  file: ${FILE}\n`);
console.log(`  parsed new members : ${newMembers.length} across ${chapters.length} chapters`);
console.log(`  columns -> chapter:${chapterCol} name:${nameCols.join("+")} industry:${industryCol} type:${typeCol} status:${statusCol} due:${dueCol} phone:${phoneCol || "none"}`);
console.log(`  existing dues members: ${oldMembers.length} | lapsed preserved: ${lapsed.length} | renewalsDone: ${renewedKeys.size}`);
console.log(`  MERGED total: ${merged.length}  (due within 90d: ${dueSoon}, overdue: ${overdue}, with phone: ${withPhone}, missing dueDate: ${noDue})`);
console.log(`  sample:`, JSON.stringify(newMembers.slice(0, 2)));

if (OUTPUT) {
  const summary = { total: merged.length, chapters: chapters.length, dueWithin90: dueSoon, overdue };
  await fs.writeFile(OUTPUT, `${JSON.stringify({
    importedAt: new Date().toISOString(),
    source: FILE,
    members: merged,
    summary
  }, null, 2)}\n`);
  console.log(`\nWrote local preview data: ${OUTPUT}`);
}

if (!WRITE) { console.log("\nRe-run with --write to save to meta/dues."); process.exit(0); }

await db.collection("meta").doc("dues").set({
  members: merged,
  source: "Membership Due report.xlsx",
  summary: { total: merged.length, chapters: chapters.length, dueWithin90: dueSoon, overdue },
  lastUploadChapters: chapters,
  uploadedAt: new Date().toISOString(),
  uploadedBy: "Membership Due Report import"
});
console.log(`\nApplied. meta/dues now has ${merged.length} members.`);
process.exit(0);
