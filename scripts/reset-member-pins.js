// Assigns every member a fresh, unique, randomly generated PIN.
//
// Only the bcrypt hash is written to Firestore. Any legacy plaintext `pin` field is
// removed in the same update, and records whose `pinHash` is not a real bcrypt hash
// (e.g. a PIN written there literally) are repaired.
//
// Dry run (default - writes nothing):
//   node scripts/reset-member-pins.js
//
// Apply and write the credential list:
//   node scripts/reset-member-pins.js --write --out=member-pins.csv
//
// Limit to specific members:
//   node scripts/reset-member-pins.js --only=ad-snehal-patel,dc-hardik-khamar

import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map(
  process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value === undefined ? "true" : value];
  })
);

const WRITE = args.get("write") === "true";
const OUT = args.get("out") || "member-pins.csv";
const ONLY = (args.get("only") || "").split(",").map(s => s.trim()).filter(Boolean);
const PIN_LENGTH = Number(args.get("length") || 6);
const BCRYPT_COST = 12;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Sequences and repeats people would notice as "not random", plus the import default.
const WEAK = new Set(["123456", "000000", "111111", "121212", "654321", "112233", "123123", "1234"]);

function randomPin(length) {
  for (;;) {
    let pin = "";
    // Rejection sampling keeps every digit uniformly distributed.
    while (pin.length < length) {
      const byte = crypto.randomBytes(1)[0];
      if (byte >= 250) continue;
      pin += String(byte % 10);
    }
    if (WEAK.has(pin)) continue;
    if (/^(\d)\1+$/.test(pin)) continue;           // all one digit
    if (pin.startsWith("0")) continue;             // avoids leading zeros being lost in spreadsheets
    return pin;
  }
}

function csvField(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const db = getDb();
const snap = await db.collection("members").get();
let members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
if (ONLY.length) members = members.filter(m => ONLY.includes(m.id));

if (!members.length) {
  console.error("No matching members found.");
  process.exit(1);
}

console.log(`${WRITE ? "APPLYING" : "DRY RUN"} - ${members.length} member(s)\n`);

const issues = members.filter(m => !m.pinHash || !BCRYPT_RE.test(String(m.pinHash)));
if (issues.length) {
  console.log("Records with a missing or malformed credential (will be repaired):");
  issues.forEach(m => console.log(`  - ${m.id} | ${m.name} | ${m.role}`));
  console.log("");
}
const withPlaintext = members.filter(m => m.pin !== undefined);
if (withPlaintext.length) {
  console.log(`Records carrying a plaintext 'pin' field (will be removed): ${withPlaintext.length}\n`);
}

const pins = new Set();
const rows = [];

for (const member of members) {
  let pin;
  do { pin = randomPin(PIN_LENGTH); } while (pins.has(pin));
  pins.add(pin);

  const chapters = (member.chapters && member.chapters.length)
    ? member.chapters
    : (member.chapter ? [member.chapter] : []);

  rows.push({ id: member.id, name: member.name, role: member.role, chapters: chapters.join("; "), pin });

  if (WRITE) {
    const update = { pinHash: await bcrypt.hash(pin, BCRYPT_COST) };
    if (member.pin !== undefined) update.pin = FieldValue.delete();
    await db.collection("members").doc(member.id).update(update);
  }
}

const header = ["Member ID", "Name", "Role", "Chapters", "PIN"];
const csv = [header, ...rows.map(r => [r.id, r.name, r.role, r.chapters, r.pin])]
  .map(cols => cols.map(csvField).join(","))
  .join("\r\n");

if (WRITE) {
  fs.writeFileSync(OUT, csv, "utf8");
  console.log(`Updated ${rows.length} member(s).`);
  console.log(`Credential list written to ${OUT}`);
  console.log("\nThis file is the only copy of these PINs - they are not recoverable from the database.");
} else {
  console.log(`Would update ${rows.length} member(s) and write ${OUT}.`);
  console.log("Sample of what would be generated (PINs shown are discarded on a dry run):\n");
  rows.slice(0, 3).forEach(r => console.log(`  ${r.id.padEnd(24)} ${String(r.name).padEnd(26)} ${r.role.padEnd(6)} ${r.pin}`));
  console.log("\nRe-run with --write to apply.");
}

process.exit(0);
