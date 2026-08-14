import fs from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { REMOVED_CHAPTERS } from "./region-removals.js";

const inputDir = process.argv[2] || "C:\\office\\TLR";
const outputFile = process.argv[3] || path.resolve("local-tlr-data.json");

const CHAPTERS = [
  "Acreseus", "Alethia", "Altimus", "Anthropos", "Ares", "Artemisia", "Athena", "Atilius", "Atlas", "Aurelius",
  "BNI Aegeus", "BNI Anatolius", "BNI Aurus", "BNI Calibos", "BNI Crypto",
  "BNI Florentino", "BNI Hera", "BNI Mythos", "BNI Oliver", "BNI Picasso",
  "BNI Roxanne", "BNI Vitus", "Colossus", "Crios", "Crixus", "Darius", "Dominus", "Eros", "Faustus",
  "Ganicus", "Hades", "Helenus", "Hercules", "Kleon", "Kronos", "Lazarus", "Lincoln", "Macedonias",
  "Magnus", "Makarios", "Maximus", "Nikolaus", "Obsidian", "Odysseus", "Olympus", "Osiris", "Perseus",
  "Petra", "Plutus", "Poseidon", "Prometheus", "Raphael", "Romulus", "Rubens", "Themis", "Tyche",
  "Vinci", "Zenobia"
];
const EXCLUDED_CHAPTERS = REMOVED_CHAPTERS;

function normalizeChapter(value) {
  return String(value || "").toLowerCase().replace(/\bbni\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function matchChapterName(value) {
  const raw = normalizeChapter(value);
  const found = CHAPTERS.find((chapter) => {
    const normalized = normalizeChapter(chapter);
    return raw === normalized || raw.includes(normalized) || normalized.includes(raw);
  });
  return found || String(value || "").trim();
}

function isExcludedChapter(value) {
  const raw = normalizeChapter(value);
  return EXCLUDED_CHAPTERS.some((chapter) => {
    const normalized = normalizeChapter(chapter);
    return raw === normalized || raw.includes(normalized) || normalized.includes(raw);
  });
}

function numericTokens(line) {
  return (String(line || "").match(/[-+]?\d[\d,]*(?:\.\d+)?%?/g) || []).map((v) => v.replace(/,/g, "").replace("%", ""));
}

function percentForRow(lines, label) {
  const line = lines.find((x) => new RegExp(`^${label}\\b`, "i").test(x));
  if (!line) return "";
  const nums = numericTokens(line);
  return nums.length ? nums[nums.length - 1] : "";
}

function firstMatch(lines, re, group = 1) {
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[group];
  }
  return "";
}

function firstTwoNumberRow(lines, re) {
  const line = lines.find((value) => re.test(value)) || "";
  const match = line.match(re);
  return match ? [match[1].replace(/,/g, ""), match[2].replace(/,/g, "")] : ["", ""];
}

function metricAfterDash(lines, re) {
  const line = lines.find((value) => re.test(value)) || "";
  const match = line.match(re);
  return match ? match[1].replace(/,/g, "") : "";
}

function parseMoney(value) {
  const cleaned = String(value || "").replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  return String(Math.round(Number.parseFloat(cleaned) || 0));
}

function moneyTokens(line) {
  const rupeeMatches = [...String(line || "").matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)].map((match) => parseMoney(match[1]));
  if (rupeeMatches.length) return rupeeMatches;
  return (String(line || "").match(/[\d,]+(?:\.\d+)?/g) || []).map((value) => parseMoney(value));
}

function chapterBusinessPassed(lines) {
  const line = lines.find((value) => /^Business Passed\b/i.test(value) && /Avg Referral Value/i.test(value)) || "";
  const values = moneyTokens(line);
  return {
    lastMonthBusinessPassed: values[0] || "",
    sixMonthBusinessPassed: values[1] || ""
  };
}

function averageBusinessPassed(lines) {
  const line = lines.find((value) => /^Avg Business Passed\b/i.test(value)) || "";
  return moneyTokens(line)[0] || "";
}

function countMemberTrafficPages(lines, chapter, region) {
  const seen = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (!/Absent\s+Referral/i.test(lines[i])) continue;
    let name = lines[i - 1] || "";
    if (/^Chapter\b/i.test(name) || !name.trim()) continue;
    if (chapter) name = name.replace(new RegExp(`\\b${chapter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), "");
    if (region) name = name.replace(new RegExp(`\\b${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), "");
    name = name.replace(/\bBNI\b/ig, "").replace(/\s+/g, " ").trim();
    if (name && name.length > 1) seen[name.toLowerCase()] = true;
  }
  return Object.keys(seen).length;
}

function countCurrentMonthScoredMembers(lines, reportMonth) {
  if (!reportMonth) return 0;
  const escapedMonth = reportMonth.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoreLine = new RegExp(`^${escapedMonth}\\s+(?:[-+]?\\d+(?:\\.\\d+)?\\s+){7}[-+]?\\d+(?:\\.\\d+)?$`, "i");
  return lines.filter((line) => scoreLine.test(line)).length;
}

function inferStatusTotal(rowPercents) {
  const values = rowPercents.map((value) => parseFloat(value)).filter((value) => !Number.isNaN(value));
  if (values.length !== 4) return 0;
  let best = { total: 0, error: Infinity };
  for (let total = 1; total <= 300; total += 1) {
    const counts = values.map((pct) => Math.round((pct / 100) * total));
    if (counts.reduce((sum, count) => sum + count, 0) !== total) continue;
    const error = values.reduce((sum, pct, index) => sum + Math.abs(pct - (counts[index] / total) * 100), 0);
    if (error < best.error) best = { total, error };
  }
  return best.error <= 0.08 ? best.total : 0;
}

async function readPdfText(filePath) {
  const data = new Uint8Array(await fs.readFile(filePath));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    const items = text.items
      .map((item) => ({ x: item.transform[4], y: Math.round(item.transform[5]), str: item.str }))
      .filter((item) => item.str && item.str.trim());
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = [];
    items.forEach((item) => {
      let group = groups.find((row) => Math.abs(row.y - item.y) <= 3);
      if (!group) {
        group = { y: item.y, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    });
    groups.sort((a, b) => b.y - a.y).forEach((group) => {
      group.items.sort((a, b) => a.x - b.x);
      lines.push(group.items.map((item) => item.str.trim()).join(" ").replace(/\s+/g, " ").trim());
    });
  }
  return lines.join("\n");
}

function parseTlrText(text, sourceFile) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const reportMonth = firstMatch(lines, /Report Issue Date\s+([A-Za-z]{3}-\d{4})/i) || firstMatch(lines, /Period\s+([A-Za-z]{3}-\d{4})/i);
  const region = firstMatch(lines, /^Region\s+(.+)$/i);
  const rawChapter = firstMatch(lines, /^Chapter\s+(?!Report\b|Meeting Day\b)(.+)$/i);
  if (!rawChapter) return null;
  if (isExcludedChapter(rawChapter)) return { skipped: true, name: rawChapter };

  const chapter = matchChapterName(rawChapter);
  if (isExcludedChapter(chapter)) return { skipped: true, name: chapter };
  const scoreLine = lines.find((line) => /Member Name\s+Total\s+Average Per Month/i.test(line)) || "";
  const scoreNums = numericTokens(scoreLine);
  const score = scoreNums.length ? scoreNums[scoreNums.length - 1] : "";
  if (!score) return null;

  const [lastMonthReferrals, sixMonthReferrals] = firstTwoNumberRow(lines, /^Total Referrals\s+([\d,]+)\s+([\d,]+)\b/i);
  const avgRefs = metricAfterDash(lines, /^Avg No\.?\s*of Referrals\s+-?\s*([\d,]+)/i);
  const [lastMonthVisitors, sixMonthVisitors] = firstTwoNumberRow(lines, /^No\.?\s*of Visitors\s+([\d,]+)\s+([\d,]+)\b/i);
  const avgVisitors = metricAfterDash(lines, /^Avg No\.?\s*of Visitors\s+-?\s*([\d,]+)/i);
  const businessPassed = chapterBusinessPassed(lines);
  const avgBusinessPassed = averageBusinessPassed(lines);
  const greenPct = percentForRow(lines, "GREEN");
  const amberPct = percentForRow(lines, "AMBER");
  const redPct = percentForRow(lines, "RED");
  const greyPct = percentForRow(lines, "GREY");
  const scoredMembers = countCurrentMonthScoredMembers(lines, reportMonth);
  const statusTotal = inferStatusTotal([greenPct, amberPct, redPct, greyPct]);
  const memberDetailPages = countMemberTrafficPages(lines, chapter, region);
  const chapterSize = scoredMembers || statusTotal || memberDetailPages;

  return {
    name: chapter,
    score,
    chapterSize: chapterSize || "",
    memberGrowth: "",
    retention: "",
    referrals: avgRefs || lastMonthReferrals || "",
    visitors: avgVisitors || lastMonthVisitors || "",
    conversion: "",
    absenteeism: "",
    reportMonth,
    region,
    pdfFormat: "chapter_member_tlr",
    sourceFile,
    lastMonthReferrals,
    sixMonthReferrals,
    avgReferrals: avgRefs,
    tyfcb: businessPassed.lastMonthBusinessPassed,
    lastMonthBusinessPassed: businessPassed.lastMonthBusinessPassed,
    sixMonthBusinessPassed: businessPassed.sixMonthBusinessPassed,
    avgBusinessPassed,
    lastMonthVisitors,
    sixMonthVisitors,
    avgVisitors,
    greenPct,
    amberPct,
    redPct,
    greyPct,
    scoredMembers,
    memberDetailPages
  };
}

const entries = await fs.readdir(inputDir, { withFileTypes: true });
const pdfFiles = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
  .map((entry) => path.join(inputDir, entry.name))
  .sort((a, b) => a.localeCompare(b));

const rows = [];
const failures = [];
for (let i = 0; i < pdfFiles.length; i += 1) {
  const filePath = pdfFiles[i];
  process.stdout.write(`Parsing ${i + 1}/${pdfFiles.length}: ${path.basename(filePath)}\r`);
  try {
    const row = parseTlrText(await readPdfText(filePath), path.basename(filePath));
    if (row && row.skipped) continue;
    if (row) rows.push(row);
    else failures.push({ file: filePath, error: "No TLR row found" });
  } catch (error) {
    failures.push({ file: filePath, error: error.message });
  }
}
process.stdout.write("\n");

const byChapter = new Map();
for (const row of rows) byChapter.set(row.name.toLowerCase(), row);
const missingChapters = CHAPTERS.filter((chapter) => !byChapter.has(chapter.toLowerCase()));
const duplicateChapters = rows
  .map((row) => row.name)
  .filter((name, index, all) => all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== index);

const payload = {
  uploadedAt: new Date().toISOString().split("T")[0],
  uploadedBy: "local-import",
  sourceDir: inputDir,
  rows: Array.from(byChapter.values()).sort((a, b) => a.name.localeCompare(b.name))
};

await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  pdfFiles: pdfFiles.length,
  parsedRows: rows.length,
  uniqueChapters: byChapter.size,
  outputFile,
  missingChapters,
  duplicateChapters: Array.from(new Set(duplicateChapters)),
  failures
}, null, 2));
