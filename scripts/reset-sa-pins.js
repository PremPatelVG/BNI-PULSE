// Resets Support Ambassador (SA) login PINs from a CSV (default sa-logins.csv).
// CSV columns: "Member ID","Name","Role","Chapter","PIN".
// For each row it bcrypt-hashes the PIN and writes it to members/<Member ID>.pinHash.
// Only existing SA accounts are touched; anything else is reported and skipped.
//
// Dry run (default, reads only):  node scripts/reset-sa-pins.js
// Apply:                          node scripts/reset-sa-pins.js --write
// Custom file:                    node scripts/reset-sa-pins.js --file=path.csv --write

import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const FILE = process.argv.find(a => a.startsWith("--file="))?.slice(7)
  || path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..", "sa-logins.csv");
const BCRYPT_COST = 12;

// minimal CSV parse for simple quoted values (no embedded commas in these fields)
const rows = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean).map(line =>
  line.split(",").map(c => c.replace(/^"|"$/g, "").trim())
);
const header = rows.shift();
const idx = { id: header.indexOf("Member ID"), pin: header.indexOf("PIN"), name: header.indexOf("Name") };
if (idx.id < 0 || idx.pin < 0) { console.error("CSV missing Member ID / PIN columns"); process.exit(1); }

const db = getDb();
console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}  file: ${FILE}\n`);

let ok = 0, missing = 0, notSa = 0, badPin = 0;
for (const r of rows) {
  const id = r[idx.id], pin = r[idx.pin], name = r[idx.name];
  if (!/^\d{4,8}$/.test(pin)) { console.log(`  BAD PIN  ${id} ("${pin}") - skipped`); badPin++; continue; }
  const snap = await db.collection("members").doc(id).get();
  if (!snap.exists) { console.log(`  MISSING  ${id} - no such account, skipped`); missing++; continue; }
  const role = snap.data().role || "";
  if (!/^sa/.test(role)) { console.log(`  NOT SA   ${id} (role=${role}) - skipped for safety`); notSa++; continue; }
  if (WRITE) await db.collection("members").doc(id).set({ pinHash: await bcrypt.hash(pin, BCRYPT_COST) }, { merge: true });
  ok++;
}
console.log(`\n${WRITE ? "Updated" : "Would update"}: ${ok} SA PINs | missing: ${missing} | not-SA: ${notSa} | bad-pin: ${badPin}`);
if (!WRITE) console.log("Re-run with --write to apply.");
process.exit(0);
