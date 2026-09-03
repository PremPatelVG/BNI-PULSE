// Replaces meta/dues (renewals) with a fresh Members Due report, keeping ONLY the
// renewals already marked completed from the previous data. Everything else in the
// old dues list is dropped. The renewalsDone collection is never touched.
//
//   new meta/dues.members = <all rows from the report>
//                         + <old rows that are marked done AND not already in the report>
//
// Phones are carried forward from the old data on chapter+name match (the report has
// no phone column). Dry run by default; --write applies.
//
//   node scripts/replace-dues-keep-completed.js --file="C:/path/report.xlsx"
//   node scripts/replace-dues-keep-completed.js --file="C:/path/report.xlsx" --write

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const FILE = process.argv.find(a => a.startsWith("--file="))?.slice(7) || "C:/Users/Admin/Downloads/Membership Due report.xlsx";
const TODAY = new Date().toISOString().slice(0, 10);
const PLUS90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);

const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const cell = v => (v && typeof v === "object") ? (v.text !== undefined ? v.text : (v.result !== undefined ? v.result : "")) : v;
const pkey = m => norm(m.chapter) + "|" + norm(m.name) + "|" + (m.dueDate || "");
const doneKeyNorm = (c, n, d) => ((c || "") + "_" + (n || "") + "_" + (d || "")).replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
const doneKeyRaw = (c, n, d) => (c || "") + "_" + (n || "") + "_" + (d || "");
function toDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(cell(v) || "").trim();
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
  const h = norm(cell(hdr.getCell(c).value));
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
  const chapter = String(cell(row.getCell(chapterCol).value) || "").trim();
  const name = nameCols.map(c => String(cell(row.getCell(c).value) || "").trim()).join(" ").replace(/\s+/g, " ").trim();
  if (!chapter || !name) return;
  newMembers.push({
    chapter, name,
    industry: industryCol ? String(cell(row.getCell(industryCol).value) || "").trim() : "",
    type: typeCol ? String(cell(row.getCell(typeCol).value) || "").trim() : "",
    status: statusCol ? String(cell(row.getCell(statusCol).value) || "").trim() : "",
    dueDate: dueCol ? toDate(row.getCell(dueCol).value) : "",
    phone: phoneCol ? String(cell(row.getCell(phoneCol).value) || "").trim() : ""
  });
});

// --- load old dues + completed marks ---
const db = getDb();
const oldMembers = ((await db.collection("meta").doc("dues").get()).data()?.members) || [];
const oldByPerson = new Map(); oldMembers.forEach(m => { const k = norm(m.chapter) + "|" + norm(m.name); if (!oldByPerson.has(k)) oldByPerson.set(k, m); });
const doneSet = new Set((await db.collection("renewalsDone").get()).docs.map(d => d.id));
const isDone = m => doneSet.has(doneKeyNorm(m.chapter, m.name, m.dueDate)) || doneSet.has(doneKeyRaw(m.chapter, m.name, m.dueDate));

// carry phones forward from old data on chapter+name
for (const m of newMembers) if (!m.phone) { const o = oldByPerson.get(norm(m.chapter) + "|" + norm(m.name)); if (o && o.phone) m.phone = o.phone; }

// preserve old completed rows not already present in the report
const newKeys = new Set(newMembers.map(pkey));
const keptCompleted = oldMembers.filter(m => isDone(m) && !newKeys.has(pkey(m)));

const merged = [...newMembers, ...keptCompleted];
const chapters = [...new Set(newMembers.map(m => m.chapter))].sort();
const dueSoon = merged.filter(m => m.dueDate && m.dueDate >= TODAY && m.dueDate <= PLUS90).length;
const overdue = merged.filter(m => m.dueDate && m.dueDate < TODAY && !isDone(m)).length;

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}  file: ${FILE}\n`);
console.log(`  old dues members (to be dropped unless completed): ${oldMembers.length}`);
console.log(`  completed marks in renewalsDone: ${doneSet.size}`);
console.log(`  report members parsed: ${newMembers.length} across ${chapters.length} chapters`);
console.log(`  columns -> chapter:${chapterCol} name:${nameCols.join("+")} due:${dueCol} phone:${phoneCol || "none(carried from old)"}`);
console.log(`  completed rows preserved (not in report): ${keptCompleted.length}`);
keptCompleted.forEach(m => console.log(`      • [${m.chapter}] ${m.name} due ${m.dueDate}`));
console.log(`\n  NEW meta/dues total: ${merged.length}  (due within 90d: ${dueSoon}, overdue-open: ${overdue}, with phone: ${merged.filter(m => m.phone).length})`);

if (!WRITE) { console.log("\nRe-run with --write to replace meta/dues."); process.exit(0); }

await db.collection("meta").doc("dues").set({
  members: merged,
  source: "Membership Due report.xlsx",
  summary: { total: merged.length, chapters: chapters.length, dueWithin90: dueSoon, overdue },
  lastUploadChapters: chapters,
  uploadedAt: new Date().toISOString(),
  uploadedBy: "Members Due import (replace, kept completed)"
});
console.log(`\nApplied. meta/dues replaced -> ${merged.length} members (${keptCompleted.length} completed preserved). renewalsDone untouched.`);
process.exit(0);
