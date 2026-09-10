// READ-ONLY: does each credential-sheet PIN actually match the live stored hash?
// A MISMATCH = the person was given a PIN that will NOT log them in. Writes nothing.
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const db = getDb();
const members = new Map((await db.collection("members").get()).docs.map(d => [d.id, d.data()]));

// tiny CSV parser (handles optional quotes)
function parseCsv(path) {
  const txt = fs.readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const cols = lines.shift().split(",").map(s => s.replace(/^"|"$/g, "").trim());
  return lines.map(line => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i, a) => i < a.length - 1 || true).filter(x => x !== undefined);
    const parts = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"').trim());
    const row = {}; cols.forEach((c, i) => row[c] = parts[i]); return row;
  });
}

async function checkSheet(path, idKey, pinKey, nameKey) {
  if (!fs.existsSync(path)) { console.log(`(${path} not found)`); return; }
  const rows = parseCsv(path);
  let ok = 0, mismatch = [], missing = [], nohash = [];
  for (const r of rows) {
    const id = r[idKey]; const pin = r[pinKey];
    if (!id) continue;
    const m = members.get(id);
    if (!m) { missing.push(`${id} (${r[nameKey]||""})`); continue; }
    if (!m.pinHash) { nohash.push(`${id} (${m.name})`); continue; }
    const good = await bcrypt.compare(String(pin), m.pinHash);
    if (good) ok++; else mismatch.push(`${id.padEnd(26)} ${(m.name||"").padEnd(24)} sheet PIN "${pin}" does NOT match live hash`);
  }
  console.log(`\n### ${path}  (${rows.length} rows)`);
  console.log(`  matches live hash : ${ok}`);
  console.log(`  MISMATCH (sheet PIN won't log in): ${mismatch.length}`);
  mismatch.forEach(x => console.log(`     - ${x}`));
  if (missing.length) { console.log(`  in sheet but NOT in DB: ${missing.length}`); missing.forEach(x=>console.log(`     - ${x}`)); }
  if (nohash.length) { console.log(`  member has no pinHash: ${nohash.length}`); nohash.forEach(x=>console.log(`     - ${x}`)); }
}

await checkSheet("sa-logins.csv", "Member ID", "PIN", "Name");
await checkSheet("member-pins.csv", "Member ID", "PIN", "Name");
process.exit(0);
