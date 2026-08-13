import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, ...rest] = arg.split("=");
  args.set(key.replace(/^--/, ""), rest.join("=") || "true");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkbook = "C:/Users/Admin/Downloads/SRDC & DC CHAPTER WSIE.xlsx";
const workbookPath = args.get("file") || defaultWorkbook;
const dryRun = args.get("dry-run") !== "false" && args.get("write") !== "true";
const defaultPin = args.get("default-pin") || process.env.DEFAULT_MEMBER_PIN || "";
const areaDirectors = (args.get("area-directors") || "Yash Vasant,Snehal Patel")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook has no worksheets");

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {
      region: clean(row.getCell(1).value),
      team: clean(row.getCell(2).value),
      chapter: clean(row.getCell(3).value),
      seniorDirector: clean(row.getCell(4).value),
      chapterDirector: clean(row.getCell(5).value),
      day: clean(row.getCell(6).value)
    };
    if (item.chapter) rows.push(item);
  });

  const byChapter = new Map();
  for (const row of rows) {
    const existing = byChapter.get(row.chapter);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error(`Conflicting rows found for chapter ${row.chapter}`);
    }
    byChapter.set(row.chapter, row);
  }

  return [...byChapter.values()];
}

async function buildImportData(chapters) {
  const pinHash = defaultPin ? await bcrypt.hash(defaultPin, 12) : "";

  const members = [];
  for (const name of areaDirectors) {
    members.push({
      id: `ad-${slug(name)}`,
      data: {
        name,
        role: "ad",
        chapter: "",
        chapters: [],
        reportsTo: "",
        ...(pinHash ? { pinHash } : {})
      }
    });
  }

  const srdcNames = unique(chapters.map(row => row.seniorDirector));
  for (const name of srdcNames) {
    const ownedChapters = chapters.filter(row => row.seniorDirector === name).map(row => row.chapter);
    members.push({
      id: `srdc-${slug(name)}`,
      data: {
        name,
        role: "srdc",
        chapter: ownedChapters[0] || "",
        chapters: ownedChapters,
        reportsTo: "",
        ...(pinHash ? { pinHash } : {})
      }
    });
  }

  const dcNames = unique(chapters.map(row => row.chapterDirector));
  for (const name of dcNames) {
    const ownedRows = chapters.filter(row => row.chapterDirector === name);
    const ownedChapters = ownedRows.map(row => row.chapter);
    const seniorDirector = ownedRows[0]?.seniorDirector || "";
    members.push({
      id: `dc-${slug(name)}`,
      data: {
        name,
        role: "dc",
        chapter: ownedChapters[0] || "",
        chapters: ownedChapters,
        reportsTo: seniorDirector,
        seniorDirectorId: seniorDirector ? `srdc-${slug(seniorDirector)}` : "",
        ...(pinHash ? { pinHash } : {})
      }
    });
  }

  const chapterDocs = chapters.map((row, index) => ({
    id: row.chapter,
    data: {
      name: row.chapter,
      region: row.region,
      team: row.team,
      day: row.day,
      tenure: "apr",
      order: index + 1,
      target: 0,
      seniorDirector: row.seniorDirector,
      seniorDirectorId: row.seniorDirector ? `srdc-${slug(row.seniorDirector)}` : "",
      chapterDirector: row.chapterDirector,
      chapterDirectorId: row.chapterDirector ? `dc-${slug(row.chapterDirector)}` : ""
    }
  }));

  return { chapters: chapterDocs, members };
}

async function writeImport(data) {
  const db = getDb();
  const writes = [...data.chapters.map(item => ["chapters", item]), ...data.members.map(item => ["members", item])];

  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [collection, item] of writes.slice(i, i + 400)) {
      batch.set(db.collection(collection).doc(item.id), item.data, { merge: true });
    }
    await batch.commit();
  }

  await db.collection("meta").doc("hierarchyImport").set({
    source: path.basename(workbookPath),
    chapterCount: data.chapters.length,
    memberCount: data.members.length,
    importedAt: new Date().toISOString()
  });
}

const chapters = await readWorkbook(workbookPath);
const data = await buildImportData(chapters);
const srdcCount = data.members.filter(member => member.data.role === "srdc").length;
const dcCount = data.members.filter(member => member.data.role === "dc").length;

console.log(`Workbook: ${workbookPath}`);
console.log(`Chapters: ${data.chapters.length}`);
console.log(`Area Directors: ${areaDirectors.length}`);
console.log(`Senior Directors: ${srdcCount}`);
console.log(`Chapter Directors/DCs: ${dcCount}`);
console.log(`Default PIN: ${defaultPin ? "set" : "not set"}`);
console.log(`Mode: ${dryRun ? "dry-run" : "write"}`);

if (dryRun) {
  console.log("\nSample chapters:");
  data.chapters.slice(0, 5).forEach(item => console.log(`${item.id}: ${item.data.seniorDirector} -> ${item.data.chapterDirector}`));
  console.log("\nDry run only. Add --write=true to import into Firestore.");
} else {
  await writeImport(data);
  console.log("Import complete.");
}
