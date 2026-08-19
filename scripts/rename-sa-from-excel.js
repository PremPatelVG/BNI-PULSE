// Renames the two Support Ambassador accounts (SA1 = la-<chapter>, SA2 = sa-<chapter>)
// to the first two people listed for that chapter in an Excel file with columns
// Name, Chapter. Chapters not found are skipped; chapters absent from the sheet keep
// their placeholder names. Only the display name changes - PINs are left intact.
//
// Dry run (default - writes nothing):
//   node scripts/rename-sa-from-excel.js --file="C:/Users/Admin/Downloads/SAnames_chapters.xlsx"
//
// Apply and refresh the credentials CSV:
//   node scripts/rename-sa-from-excel.js --file="..." --write --csv=ambassador-pins.csv

import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? "true" : v];
}));
const FILE = args.get("file") || "C:/Users/Admin/Downloads/SAnames_chapters.xlsx";
const WRITE = args.get("write") === "true";
const CSV = args.get("csv") || "ambassador-pins.csv";

const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const norm = s => String(s).toLowerCase().replace(/^bni\s+/, "").trim();

const db = getDb();
const chapters = (await db.collection("chapters").get()).docs.map(d => d.data().name);
const matchChapter = raw => chapters.find(c => { const a = norm(raw), b = norm(c); return a === b || a.includes(b) || b.includes(a); });

// Read the sheet in order.
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.getWorksheet(1);
const byChapter = new Map();
const skipped = [];
ws.eachRow((row, n) => {
  if (n === 1) return;
  const name = (row.values[1] && (row.values[1].text || row.values[1]).toString().trim()) || "";
  const rawChapter = (row.values[2] && (row.values[2].text || row.values[2]).toString().trim()) || "";
  if (!name || !rawChapter) return;
  const chapter = matchChapter(rawChapter);
  if (!chapter) { skipped.push(`${name} (${rawChapter})`); return; }
  if (!byChapter.has(chapter)) byChapter.set(chapter, []);
  byChapter.get(chapter).push(name);
});

// Build the rename plan: first name -> SA1 (la-<slug>), second -> SA2 (sa-<slug>).
const renames = []; // { id, chapter, slot, name }
const singleSaChapters = [];
let extrasDropped = 0;
for (const [chapter, names] of byChapter) {
  const s = slug(chapter);
  if (names[0]) renames.push({ id: `la-${s}`, chapter, slot: "SA1", name: names[0] });
  if (names[1]) renames.push({ id: `sa-${s}`, chapter, slot: "SA2", name: names[1] });
  else singleSaChapters.push(chapter);
  if (names.length > 2) extrasDropped += names.length - 2;
}

console.log(`${WRITE ? "APPLYING" : "DRY RUN"} - ${FILE}\n`);
console.log(`matched chapters : ${byChapter.size} / ${chapters.length}`);
console.log(`SA renames       : ${renames.length} (SA1+SA2 across matched chapters)`);
console.log(`chapters with 1 SA (SA2 keeps placeholder): ${singleSaChapters.length}`);
console.log(`extra names dropped (chapters with >2 SAs): ${extrasDropped}`);
console.log(`rows skipped (chapter not found): ${skipped.length}`);
console.log(`chapters absent from sheet (keep placeholder): ${chapters.filter(c => !byChapter.has(c)).length}\n`);
console.log("Sample:");
renames.slice(0, 6).forEach(r => console.log(`  ${r.id.padEnd(22)} ${r.slot}  ->  ${r.name}`));

if (WRITE) {
  let done = 0;
  for (const r of renames) {
    await db.collection("members").doc(r.id).set({ name: r.name }, { merge: true });
    done++;
  }
  console.log(`\nRenamed ${done} SA accounts (PINs unchanged).`);

  // Refresh the credential CSV's Name column so PINs still map to the right person.
  if (fs.existsSync(CSV)) {
    const byId = new Map(renames.map(r => [r.id, r.name]));
    const lines = fs.readFileSync(CSV, "utf8").trim().split(/\r?\n/);
    const parse = l => l.match(/"((?:[^"]|"")*)"/g).map(x => x.slice(1, -1).replace(/""/g, '"'));
    const field = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = lines.slice(1).map(parse).map(r => { if (byId.has(r[0])) r[1] = byId.get(r[0]); return r; });
    fs.writeFileSync(CSV, [lines[0], ...rows.map(r => r.map(field).join(","))].join("\r\n"), "utf8");
    console.log(`Updated ${CSV} names for renamed accounts.`);
  }
} else {
  console.log(`\nRe-run with --write to apply.`);
}
process.exit(0);
