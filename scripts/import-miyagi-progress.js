// Imports Miyagi checkpoint progress from the per-chapter Excel sheets in
// C:/office/MIYAGI SHEETS/ into the dashboard's miyagiMembers collection.
//
// Each file is one chapter (file name = chapter). Each row is a member with 14
// task booleans (matching the app's 14 Miyagi checkpoints in the same order),
// plus a Points total and a Belt. We set the member's `checkpoints` map and
// `score` from the ticked tasks; the app derives the belt from the score.
//
// Files whose name does not match a known chapter are ignored (reported).
//
// Dry run (default, NO database access - safe while Firestore quota is exhausted):
//   node scripts/import-miyagi-progress.js
// Apply (reads + writes miyagiMembers):
//   node scripts/import-miyagi-progress.js --write

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const DIR = process.argv.find(a => a.startsWith("--dir="))?.slice(6) || "C:/office/MIYAGI SHEETS";
const WRITE = process.argv.includes("--write");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

// The 14 checkpoints, in the exact order of the Excel task columns (col 4..17).
const TASK_KEYS = ["msp", "mentorship", "powerTeam", "visitors4", "sponsor1", "lt121s", "regionalEvent",
  "educationSlot", "greenTLR", "tyfcb10", "otherTraining", "renewEarly", "attendance95", "bonusSelfie"];
const TASK_POINTS = { msp: 5, mentorship: 5, powerTeam: 10, visitors4: 5, sponsor1: 15, lt121s: 5, regionalEvent: 5,
  educationSlot: 5, greenTLR: 15, tyfcb10: 5, otherTraining: 5, renewEarly: 15, attendance95: 5, bonusSelfie: 5 };
// Match each checkpoint to its column by a distinctive word in the header label.
const TASK_MATCH = [
  ["msp", h => h.includes("msp")],
  ["mentorship", h => h.includes("mentorship")],
  ["powerTeam", h => h.includes("powerteam")],
  ["visitors4", h => h.includes("visitor")],
  ["sponsor1", h => h.includes("sponsor")],
  ["lt121s", h => h.includes("121")],
  ["regionalEvent", h => h.includes("regional")],
  ["educationSlot", h => h.includes("education")],
  ["greenTLR", h => h.includes("green")],
  ["tyfcb10", h => h.includes("tyfcb")],
  ["otherTraining", h => h.includes("othertrain")],
  ["renewEarly", h => h.includes("renew")],
  ["attendance95", h => h.includes("attendance")],
  ["bonusSelfie", h => h.includes("selfie")]
];
const BELTS = [["No Belt", 0], ["White", 5], ["Yellow", 30], ["Blue", 50], ["Brown", 75], ["Black", 100]];
const beltFor = s => { let b = BELTS[0][0]; for (const [n, m] of BELTS) if (s >= m) b = n; return b; };

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const cellVal = v => (v && typeof v === "object") ? (v.text !== undefined ? v.text : (v.result !== undefined ? v.result : "")) : v;
const isTrue = v => { const x = cellVal(v); return x === true || x === 1 || /^(true|yes|y|1|x|✓|done)$/i.test(String(x || "").trim()); };
const miyagiId = (chapter, name) => (chapter + "_" + name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// --- canonical chapter list from index.html seed ---
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const cs = html.indexOf("const chapters=  ["); const ce = html.indexOf("const members=  [", cs);
const chapterNames = JSON.parse(html.slice(cs, ce).slice(html.slice(cs, ce).indexOf("["), html.slice(cs, ce).lastIndexOf("];") + 1)).map(c => c.name);
const chapterByNorm = new Map(chapterNames.map(n => [norm(n), n]));
// match a file base name to a chapter (exact normalized, else chapter-name is a prefix of the file name)
function matchChapter(base) {
  const nb = norm(base);
  if (chapterByNorm.has(nb)) return chapterByNorm.get(nb);
  let best = null;
  for (const [nc, name] of chapterByNorm) if (nb.startsWith(nc) && (!best || nc.length > norm(best).length)) best = name;
  return best;
}

const files = fs.readdirSync(DIR).filter(f => /\.xlsx$/i.test(f) && !f.startsWith("~$"));
const parsed = [];      // { chapter, members:[{name, month, checkpoints, score, xlPoints, xlBelt, tasksDone}] }
const ignored = [];     // { file, reason }

for (const file of files) {
  const base = file.replace(/\.xlsx$/i, "");
  const chapter = matchChapter(base);
  if (!chapter) { ignored.push({ file, reason: "no matching chapter" }); continue; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, file));
  const ws = wb.worksheets.find(w => norm(w.name) && norm(w.name) !== "criteria") || wb.worksheets[0];
  // Detect columns by header label - the column order differs between files.
  const hdr = ws.getRow(1);
  const taskCol = {}; let nameCol = 0, monthCol = 0, pointsCol = 0, beltCol = 0;
  for (let c = 1; c <= ws.columnCount; c++) {
    const h = norm(cellVal(hdr.getCell(c).value));
    if (!h) continue;
    if (!nameCol && h === "name") { nameCol = c; continue; }
    if (!monthCol && h.includes("month")) { monthCol = c; continue; }
    if (!pointsCol && h.includes("point")) { pointsCol = c; continue; }
    if (!beltCol && h.includes("belt")) { beltCol = c; continue; }
    for (const [key, test] of TASK_MATCH) if (!taskCol[key] && test(h)) { taskCol[key] = c; break; }
  }
  if (!nameCol) nameCol = 2;
  const detected = Object.keys(taskCol).length;
  const members = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn === 1) return; // header
    const name = String(cellVal(row.getCell(nameCol).value) || "").trim();
    if (!name) return;
    const checkpoints = {}; let score = 0; let tasksDone = 0;
    for (const key of TASK_KEYS) {
      if (taskCol[key] && isTrue(row.getCell(taskCol[key]).value)) {
        checkpoints[key] = { done: true, date: "", markedBy: "Miyagi Excel import" }; score += TASK_POINTS[key]; tasksDone++;
      }
    }
    const xlPoints = pointsCol ? (Number(cellVal(row.getCell(pointsCol).value)) || 0) : 0;
    const xlBelt = beltCol ? String(cellVal(row.getCell(beltCol).value) || "").replace(/\s*belt\s*/i, "").trim() : "";
    members.push({ name, month: monthCol ? String(cellVal(row.getCell(monthCol).value) || "").trim() : "", checkpoints, score, tasksDone, xlPoints, xlBelt });
  });
  parsed.push({ chapter, file, members, detected });
}

// --- report ---
let totalMembers = 0, withProgress = 0, mismatchPts = 0;
console.log(`${WRITE ? "APPLYING" : "DRY RUN (no database access)"}\n`);
console.log(`files: ${files.length} | matched chapters: ${parsed.length} | ignored: ${ignored.length}\n`);
console.log("=== per chapter ===");
for (const p of parsed) {
  totalMembers += p.members.length;
  const wp = p.members.filter(m => m.score > 0).length; withProgress += wp;
  console.log(`\n${p.chapter}  (${p.members.length} members, ${wp} with progress)${p.detected < 14 ? `  [WARNING: only ${p.detected}/14 task columns detected]` : ""}`);
  p.members.forEach(m => {
    const appBelt = beltFor(m.score);
    const flag = m.score !== m.xlPoints ? `  !! score ${m.score} != sheet ${m.xlPoints}` : "";
    if (m.score !== m.xlPoints) mismatchPts++;
    console.log(`   ${m.name.padEnd(26)} tasks ${String(m.tasksDone).padStart(2)}/14  score ${String(m.score).padStart(3)}  belt ${appBelt}${m.xlBelt && norm(m.xlBelt) !== norm(appBelt) ? ` (sheet: ${m.xlBelt})` : ""}${flag}`);
  });
}
console.log(`\n=== ignored files (chapter not in system) ===`);
ignored.forEach(x => console.log(`   ${x.file}  (${x.reason})`));
console.log(`\nTotals: ${totalMembers} members across ${parsed.length} chapters, ${withProgress} with progress. Point mismatches: ${mismatchPts}.`);

if (!WRITE) { console.log("\nRe-run with --write to apply (updates matched miyagiMembers; needs Firestore quota)."); process.exit(0); }

// --- apply ---
const { getDb } = await import("../src/firebaseAdmin.js");
const db = getDb();
const existing = new Map((await db.collection("miyagiMembers").get()).docs.map(d => [d.id, d.data()]));
const monthIso = m => { const M = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" }; const x = /^([a-z]{3})-?(\d{2,4})$/i.exec(m || ""); if (!x) return ""; const mm = M[x[1].toLowerCase()]; const yy = x[2].length === 2 ? "20" + x[2] : x[2]; return mm ? `${yy}-${mm}-01` : ""; };
const today = new Date().toISOString().slice(0, 10);
let updated = 0, created = 0;
for (const p of parsed) {
  for (const m of p.members) {
    const id = miyagiId(p.chapter, m.name);
    const prior = existing.get(id);
    const data = { name: m.name, chapter: p.chapter, chapters: [p.chapter], checkpoints: m.checkpoints, score: m.score, status: prior?.status || "active", lastActivityDate: today, importedAt: today };
    if (!prior) { data.joinDate = monthIso(m.month) || ""; data.checkins = {}; data.createdAt = today; created++; }
    else updated++;
    await db.collection("miyagiMembers").doc(id).set(data, { merge: true });
  }
}
console.log(`\nApplied. Updated ${updated} existing, created ${created} new miyagiMembers.`);
process.exit(0);
