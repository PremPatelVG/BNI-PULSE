// Give every Chapter Director a fresh UNIQUE 6-digit PIN, and update member-pins.csv.
//
// SAFE ORDERING (this is the whole point): the new PINs are written to the CSV on disk
// and read back to verify BEFORE any live hash is committed to Firestore. If the CSV
// can't be written, nothing changes live - so we can never again end up with live PINs
// that no sheet records.
//
// Only DC rows (role dc/cd) get new PINs. AD / SrDC rows are preserved exactly as they
// are in the current CSV (their PINs are not reset here).
//
// Dry run (default): node scripts/reset-dc-unique-pins.js
// Apply:             node scripts/reset-dc-unique-pins.js --write

import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const CSV = "member-pins.csv";
const BCRYPT_COST = 12;
const db = getDb();

// ---- parse the existing CSV, preserving row order and every column ----
const raw = fs.readFileSync(CSV, "utf8").replace(/^﻿/, "");
const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
const header = lines.shift();
const splitCsv = l => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"'));
const rows = lines.map(l => { const c = splitCsv(l); return { id: c[0], name: c[1], role: c[2], chapters: c[3], pin: c[4] }; });

const isDC = r => r.role === "dc" || r.role === "cd" || /^dc-/.test(r.id);
const dcRows = rows.filter(isDC);

// ---- confirm each DC row maps to a live member ----
const members = new Map((await db.collection("members").get()).docs.map(d => [d.id, d.data()]));
const missing = dcRows.filter(r => !members.has(r.id));

// ---- generate unique PINs (seed the "used" set with the PINs we are KEEPING) ----
const used = new Set(rows.filter(r => !isDC(r)).map(r => r.pin));
function randomPin() {
  const weak = new Set(["123456","000000","111111","121212","654321","112233","123123","1234"]);
  for (;;) {
    let p = ""; while (p.length < 6) { const b = crypto.randomBytes(1)[0]; if (b < 250) p += String(b % 10); }
    if (weak.has(p) || /^(\d)\1+$/.test(p) || p.startsWith("0") || used.has(p)) continue;
    used.add(p); return p;
  }
}
const newPin = new Map();          // id -> new pin
dcRows.forEach(r => newPin.set(r.id, randomPin()));

// ---- build the new CSV text: DC rows get the new PIN, others unchanged ----
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
const outLines = [header, ...rows.map(r => {
  const pin = isDC(r) ? newPin.get(r.id) : r.pin;
  return [r.id, r.name, r.role, r.chapters, pin].map(q).join(",");
})];
const outText = outLines.join("\r\n") + "\r\n";

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}`);
console.log(`  DC rows to re-PIN : ${dcRows.length}`);
console.log(`  preserved rows    : ${rows.length - dcRows.length} (AD/SrDC)`);
if (missing.length) console.log(`  ⚠ DC rows with no live member (skipped live, kept in CSV): ${missing.map(m=>m.id).join(", ")}`);

if (!WRITE) { console.log(`\nRe-run with --write to apply.`); process.exit(0); }

// ---- STEP 1: write CSV to disk and verify BEFORE touching Firestore ----
let target = CSV;
try {
  fs.writeFileSync(CSV, outText, "utf8");
} catch (e) {
  target = `member-pins.${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`;
  fs.writeFileSync(target, outText, "utf8");
  console.log(`  ⚠ ${CSV} was locked (${e.code}); wrote credentials to ${target} instead.`);
}
const readBack = fs.readFileSync(target, "utf8");
const verifyOk = dcRows.every(r => readBack.includes(`,"${newPin.get(r.id)}"`) || readBack.includes(newPin.get(r.id)));
if (!verifyOk) { console.error("CSV verify FAILED - aborting before any live change."); process.exit(1); }
console.log(`  ✓ CSV written and verified: ${target}`);

// ---- STEP 2: only now commit the live bcrypt hashes ----
let done = 0;
for (const r of dcRows) {
  if (!members.has(r.id)) continue;
  await db.collection("members").doc(r.id).set({ pinHash: await bcrypt.hash(newPin.get(r.id), BCRYPT_COST), pin: null }, { merge: true });
  done++;
  if (done % 10 === 0) console.log(`  committed ${done}/${dcRows.length}`);
}
console.log(`  ✓ live PINs updated for ${done} DCs`);
console.log(`\nDONE. ${done} DC PINs reset (unique), recorded in ${target}.`);
process.exit(0);
