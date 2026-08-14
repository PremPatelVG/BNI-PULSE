import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "../src/firebaseAdmin.js";
import { REMOVED_CHAPTERS } from "./region-removals.js";

const inputFile = process.argv[2] || "C:\\Users\\Admin\\Downloads\\Region_Upcoming_Renewals_Report_14-08-2026_2-44_PM.xls";
const outputFile = process.argv[3] || path.resolve("local-dues-data.json");
const writeLive = process.argv.includes("--write=true");

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\bbni\b/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function toIsoDate(value) {
  const raw = clean(value);
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

async function readCurrentChapters() {
  const html = await fs.readFile("index.html", "utf8");
  const start = html.indexOf("const chapters=  [");
  const end = html.indexOf("const members=  [", start);
  if (start < 0 || end < 0) throw new Error("Could not locate chapter seed data in index.html");
  const js = html.slice(start, end);
  const arrayText = js.slice(js.indexOf("["), js.lastIndexOf("];") + 1);
  return JSON.parse(arrayText).filter(
    (chapter) => !REMOVED_CHAPTERS.some((removed) => normalize(removed) === normalize(chapter.name))
  );
}

function matchChapter(raw, chapters) {
  const value = normalize(String(raw || "").split(">").pop());
  const found = chapters.find((chapter) => {
    const chapterName = normalize(chapter.name);
    return value === chapterName || value.includes(chapterName) || chapterName.includes(value);
  });
  return found || null;
}

function cellData(cellXml) {
  const dataMatch = cellXml.match(/<[^:>]*(?::)?Data\b[^>]*>([\s\S]*?)<\/[^:>]*(?::)?Data>/i);
  return clean(decodeXml(dataMatch ? dataMatch[1].replace(/<[^>]+>/g, "") : ""));
}

function readXmlSpreadsheetRows(text) {
  const rows = [];
  const rowMatches = text.match(/<[^:>]*(?::)?Row\b[^>]*>[\s\S]*?<\/[^:>]*(?::)?Row>/gi) || [];
  for (const rowXml of rowMatches) {
    const row = [];
    let column = 1;
    const cells = rowXml.match(/<[^:>]*(?::)?Cell\b[^>]*>[\s\S]*?<\/[^:>]*(?::)?Cell>/gi) || [];
    for (const cellXml of cells) {
      const indexMatch = cellXml.match(/\b(?:ss:)?Index="(\d+)"/i);
      if (indexMatch) {
        const target = Number(indexMatch[1]);
        while (column < target) {
          row.push("");
          column += 1;
        }
      }
      row.push(cellData(cellXml));
      column += 1;
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function headerIndex(headers, candidates) {
  const normalized = headers.map(normalize);
  for (const candidate of candidates) {
    const wanted = normalize(candidate);
    const index = normalized.findIndex(
      (header) => header === wanted || header.includes(wanted) || (wanted.includes(header) && header.length > 2)
    );
    if (index >= 0) return index;
  }
  return -1;
}

function uniqueMembers(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${normalize(row.chapter)}|${normalize(row.name)}|${row.dueDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDuesRows(rows, chapters) {
  const headerRow = rows.findIndex((row) => {
    const headers = row.map(normalize);
    return headers.includes("chapter") && headers.some((header) => header.includes("renewal"));
  });
  if (headerRow < 0) throw new Error("Could not find dues report header row");

  const headers = rows[headerRow];
  const iChapter = headerIndex(headers, ["Chapter"]);
  const iDirector = headerIndex(headers, ["DC", "Director"]);
  const iFirst = headerIndex(headers, ["First Name", "First"]);
  const iLast = headerIndex(headers, ["Last Name", "Last"]);
  const iCompany = headerIndex(headers, ["Company", "Business", "Industry"]);
  const iDue = headerIndex(headers, ["Renewal Date", "Renewal Due", "Due Date", "Membership Due"]);
  const iEmail = headerIndex(headers, ["Email Address", "Email"]);
  const iPhone = headerIndex(headers, ["Phone Number", "Phone", "Mobile"]);
  const iAddress = headerIndex(headers, ["Address"]);

  const members = [];
  for (const row of rows.slice(headerRow + 1)) {
    const chapter = matchChapter(row[iChapter], chapters);
    if (!chapter) continue;
    const name = clean(`${row[iFirst] || ""} ${row[iLast] || ""}`);
    const dueDate = toIsoDate(row[iDue]);
    if (!name || !dueDate) continue;
    members.push({
      chapter: chapter.name,
      name,
      industry: clean(row[iCompany]),
      type: "",
      status: "Active",
      dueDate,
      director: chapter.chapterDirector || clean(row[iDirector]),
      reportDirector: clean(row[iDirector]),
      seniorDirector: chapter.seniorDirector || "",
      email: clean(row[iEmail]),
      phone: clean(row[iPhone]),
      address: clean(row[iAddress])
    });
  }
  return uniqueMembers(members);
}

function summarize(members) {
  const months = {};
  const chapters = {};
  for (const member of members) {
    const month = member.dueDate.slice(0, 7);
    months[month] = (months[month] || 0) + 1;
    chapters[member.chapter] = (chapters[member.chapter] || 0) + 1;
  }
  const topChapters = Object.entries(chapters)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([chapter, count]) => ({ chapter, count }));
  return {
    members: members.length,
    chapters: Object.keys(chapters).length,
    months,
    topChapters
  };
}

async function writeLiveDues(payload) {
  const db = getDb();
  await db.collection("meta").doc("dues").set({
    members: payload.members,
    uploadedAt: new Date().toISOString().slice(0, 10),
    uploadedBy: "Codex local importer",
    lastUploadChapters: [...new Set(payload.members.map((member) => member.chapter))],
    source: payload.source,
    summary: payload.summary
  });
}

const chapters = await readCurrentChapters();
const text = await fs.readFile(inputFile, "utf8");
const rows = readXmlSpreadsheetRows(text);
const members = parseDuesRows(rows, chapters);
const payload = {
  importedAt: new Date().toISOString(),
  source: inputFile,
  members,
  summary: {
    sourceRows: Math.max(0, rows.length - 1),
    systemChapters: chapters.length,
    ...summarize(members)
  }
};

await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Source: ${inputFile}`);
console.log(`Output: ${outputFile}`);
console.log(`Members imported: ${payload.summary.members}`);
console.log(`Chapters matched: ${payload.summary.chapters}/${payload.summary.systemChapters}`);
console.log(`Months: ${Object.entries(payload.summary.months).map(([month, count]) => `${month}=${count}`).join(", ")}`);
console.log("Top chapters:");
payload.summary.topChapters.forEach((item) => console.log(`- ${item.chapter}: ${item.count}`));

if (writeLive) {
  await writeLiveDues(payload);
  console.log("Live Firestore meta/dues updated.");
} else {
  console.log("Local file only. Add --write=true to push this dues dataset live.");
}
