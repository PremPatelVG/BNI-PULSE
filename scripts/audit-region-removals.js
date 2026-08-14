import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REMOVED_CHAPTERS, REMOVED_PEOPLE, REMOVED_SENIOR_DIRECTORS } from "./region-removals.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(rootDir, "index.html");
const tlrPath = path.join(rootDir, "local-tlr-data.json");
const distIndexPath = path.join(rootDir, "dist", "index.html");
const distTlrPath = path.join(rootDir, "dist", "local-tlr-data.json");

function extractArrayAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Marker not found: ${marker}`);
  const start = source.indexOf("[", markerIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }

  throw new Error(`Array end not found: ${marker}`);
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const indexText = fs.readFileSync(indexPath, "utf8");
const chapters = extractArrayAfter(indexText, "const chapters=");
const members = extractArrayAfter(indexText, "const members=");
const localTlr = readJsonIfExists(tlrPath);
const distTlr = readJsonIfExists(distTlrPath);

const issues = [];
for (const chapterName of REMOVED_CHAPTERS) {
  if (chapters.some((chapter) => chapter.name === chapterName)) issues.push(`Removed chapter still in index seed: ${chapterName}`);
  if (members.some((member) => (member.chapter === chapterName) || (member.chapters || []).includes(chapterName))) issues.push(`Removed chapter still assigned to a member: ${chapterName}`);
  if ((localTlr?.rows || []).some((row) => row.name === chapterName)) issues.push(`Removed chapter still in local TLR data: ${chapterName}`);
  if ((distTlr?.rows || []).some((row) => row.name === chapterName)) issues.push(`Removed chapter still in dist TLR data: ${chapterName}`);
  if (fs.existsSync(distIndexPath) && fs.readFileSync(distIndexPath, "utf8").includes(`"name": "${chapterName}"`)) issues.push(`Removed chapter still in dist index seed: ${chapterName}`);
}

for (const personName of REMOVED_PEOPLE) {
  if (members.some((member) => member.name === personName)) issues.push(`Removed person still in member seed: ${personName}`);
}

for (const seniorDirector of REMOVED_SENIOR_DIRECTORS) {
  if (chapters.some((chapter) => chapter.seniorDirector === seniorDirector)) issues.push(`Removed Senior Director still owns a chapter: ${seniorDirector}`);
}

const chapterNames = new Set(chapters.map((chapter) => chapter.name));
const localTlrNames = new Set((localTlr?.rows || []).map((row) => row.name));
const missingTlr = [...chapterNames].filter((name) => !localTlrNames.has(name));
const extraTlr = [...localTlrNames].filter((name) => !chapterNames.has(name));
if (localTlr && missingTlr.length) issues.push(`Local TLR missing chapters: ${missingTlr.join(", ")}`);
if (localTlr && extraTlr.length) issues.push(`Local TLR has extra chapters: ${extraTlr.join(", ")}`);

if (issues.length) {
  console.error(issues.map((issue) => `- ${issue}`).join("\n"));
  process.exit(1);
}

console.log(`Region removal audit passed: ${chapters.length} chapters, ${members.length} members, ${localTlr?.rows?.length || 0} local TLR rows.`);
