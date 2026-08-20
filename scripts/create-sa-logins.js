// Creates one Support Ambassador login for every name in an Excel file (columns
// Name, Chapter), grouped under their chapter. For each chapter found in the sheet it
// removes the two generic placeholder accounts (la-<chapter>, sa-<chapter>) and creates
// one account per real SA. Chapters not found in the system are skipped; chapters absent
// from the sheet keep their placeholders untouched.
//
// Each SA: id sa-<chapter>-<n>, role sa1 (same rights as the Chapter Director),
// chapter-scoped, with a generated PIN (bcrypt hash stored; plaintext only in the CSV).
//
// Dry run (default - writes nothing):
//   node scripts/create-sa-logins.js --file="C:/Users/Admin/Downloads/SAnames_chapters.xlsx"
//
// Apply and write the credential list:
//   node scripts/create-sa-logins.js --file="..." --write --out=sa-logins.csv

import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? "true" : v];
}));
const FILE = args.get("file") || "C:/Users/Admin/Downloads/SAnames_chapters.xlsx";
const WRITE = args.get("write") === "true";
const OUT = args.get("out") || "sa-logins.csv";
const BCRYPT_COST = 12;

const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const norm = s => String(s).toLowerCase().replace(/^bni\s+/, "").trim();
const csvField = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

function randomPin(used) {
  const weak = new Set(["123456", "000000", "111111", "121212", "654321", "112233", "123123", "1234"]);
  for (;;) {
    let p = ""; while (p.length < 6) { const b = crypto.randomBytes(1)[0]; if (b < 250) p += String(b % 10); }
    if (weak.has(p) || /^(\d)\1+$/.test(p) || p.startsWith("0") || used.has(p)) continue;
    used.add(p); return p;
  }
}

const db = getDb();
const chapterDocs = (await db.collection("chapters").get()).docs.map(d => ({ name: d.data().name, seniorDirector: d.data().seniorDirector || "" }));
const matchChapter = raw => chapterDocs.find(c => { const a = norm(raw), b = norm(c.name); return a === b || a.includes(b) || b.includes(a); });

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const ws = wb.getWorksheet(1);
const byChapter = new Map();
const skipped = [];
ws.eachRow((row, n) => {
  if (n === 1) return;
  const name = (row.values[1] && (row.values[1].text || row.values[1]).toString().trim()) || "";
  const raw = (row.values[2] && (row.values[2].text || row.values[2]).toString().trim()) || "";
  if (!name || !raw) return;
  const chapter = matchChapter(raw);
  if (!chapter) { skipped.push(`${name} (${raw})`); return; }
  if (!byChapter.has(chapter.name)) byChapter.set(chapter.name, { chapter, names: [] });
  byChapter.get(chapter.name).names.push(name);
});

const used = new Set();
const rows = [];       // { id, name, chapter, pin }
const deletions = [];  // placeholder ids to remove for matched chapters
for (const [chapterName, { chapter, names }] of byChapter) {
  const s = slug(chapterName);
  deletions.push(`la-${s}`, `sa-${s}`);
  names.forEach((name, i) => {
    rows.push({ id: `sa-${s}-${i + 1}`, name, chapter: chapterName, reportsTo: chapter.seniorDirector, pin: randomPin(used) });
  });
}

console.log(`${WRITE ? "APPLYING" : "DRY RUN"} - ${FILE}\n`);
console.log(`matched chapters      : ${byChapter.size} / ${chapterDocs.length}`);
console.log(`SA logins to create   : ${rows.length}`);
console.log(`placeholders to delete: ${deletions.length} (2 per matched chapter)`);
console.log(`rows skipped (chapter not found): ${skipped.length}`);
console.log(`chapters kept as placeholder (absent from sheet): ${chapterDocs.length - byChapter.size}\n`);
console.log("Sample:");
rows.slice(0, 6).forEach(r => console.log(`  ${r.id.padEnd(22)} ${r.chapter.padEnd(12)} ${r.name}`));

if (WRITE) {
  let created = 0, removed = 0;
  for (const id of deletions) { await db.collection("members").doc(id).delete(); removed++; }
  for (const r of rows) {
    await db.collection("members").doc(r.id).set({
      name: r.name, role: "sa1", chapter: r.chapter, chapters: [r.chapter],
      reportsTo: r.reportsTo, isAmbassador: true, pinHash: await bcrypt.hash(r.pin, BCRYPT_COST)
    });
    created++;
  }
  const header = ["Member ID", "Name", "Role", "Chapter", "PIN"];
  const csv = [header, ...rows.map(r => [r.id, r.name, "Support Ambassador", r.chapter, r.pin])]
    .map(c => c.map(csvField).join(",")).join("\r\n");
  fs.writeFileSync(OUT, csv, "utf8");
  console.log(`\nDeleted ${removed} placeholders, created ${created} SA logins.`);
  console.log(`Credential list written to ${OUT} (the only copy of these PINs).`);
} else {
  console.log(`\nRe-run with --write to apply and generate ${OUT}.`);
}
process.exit(0);
