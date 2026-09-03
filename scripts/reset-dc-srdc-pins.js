// Resets every DC and SrDC login PIN to a unique, strong 6-digit PIN.
// Writes bcrypt hashes to Firestore (members/<id>.pinHash) and rewrites
// member-pins.csv with the new plaintext PINs. AD accounts are left untouched.
//
// Dry run (default): node scripts/reset-dc-srdc-pins.js
// Apply:             node scripts/reset-dc-srdc-pins.js --write

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const CSV = path.join(ROOT, "member-pins.csv");
const COST = 12;

// unique 6-digit PIN, avoiding weak patterns (all-same, sequential, common)
const BANNED = new Set(["123456", "654321", "111111", "000000", "121212", "112233", "123123", "789456"]);
function genPin(used) {
  for (;;) {
    const p = String(crypto.randomInt(100000, 1000000)); // always 6 digits
    if (used.has(p) || BANNED.has(p)) continue;
    if (/^(\d)\1{5}$/.test(p)) continue;                 // all identical
    let seq = true; for (let i = 1; i < 6; i++) if (+p[i] !== +p[i - 1] + 1) { seq = false; break; }
    if (seq) continue;                                   // strictly ascending
    used.add(p); return p;
  }
}

const db = getDb();
const mem = (await db.collection("members").get()).docs.map(d => ({ id: d.id, ...d.data() }));
const targets = mem.filter(m => m.role === "dc" || m.role === "srdc")
  .sort((a, b) => a.role === b.role ? a.id.localeCompare(b.id) : (a.role === "srdc" ? -1 : 1));

const used = new Set(); const pins = {};
targets.forEach(m => { pins[m.id] = genPin(used); });

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}`);
console.log(`SrDC: ${targets.filter(m => m.role === "srdc").length} | DC: ${targets.filter(m => m.role === "dc").length} | total to update: ${targets.length}`);
console.log(`unique PINs generated: ${new Set(Object.values(pins)).size} (should equal ${targets.length})`);

if (!WRITE) {
  console.log("\nsamples:", targets.slice(0, 3).map(m => `${m.name} -> ${pins[m.id]}`).join(" | "));
  console.log("Re-run with --write to apply and update the CSV.");
  process.exit(0);
}

// 1) update Firestore pin hashes
for (const m of targets) {
  await db.collection("members").doc(m.id).set({ pinHash: await bcrypt.hash(pins[m.id], COST) }, { merge: true });
}

// 2) rewrite CSV: header + AD rows (verbatim) + SrDC rows + DC rows (new PINs, from Firestore)
const q = s => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
const chapStr = m => Array.isArray(m.chapters) ? m.chapters.join("; ") : (m.chapter || "");
const oldLines = fs.readFileSync(CSV, "utf8").split(/\r?\n/).filter(Boolean);
const adLines = oldLines.slice(1).filter(l => l.split('","').map(x => x.replace(/^"|"$/g, ""))[2] === "ad");
const row = (m, role) => [q(m.id), q(m.name), q(role), q(chapStr(m)), q(pins[m.id])].join(",");
const header = '"Member ID","Name","Role","Chapters","PIN"';
const out = [header, ...adLines,
  ...targets.filter(m => m.role === "srdc").map(m => row(m, "srdc")),
  ...targets.filter(m => m.role === "dc").map(m => row(m, "dc"))].join("\n") + "\n";
fs.writeFileSync(CSV, out);

console.log(`\nApplied. Updated ${targets.length} PIN hashes in Firestore and rewrote member-pins.csv`);
console.log(`(kept ${adLines.length} AD rows unchanged). CSV holds the new plaintext PINs.`);
process.exit(0);
