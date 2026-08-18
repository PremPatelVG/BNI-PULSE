// Creates two ambassador accounts per chapter:
//   "{Chapter} Launch Ambassador"  (role sa1)
//   "{Chapter} Support Ambassador" (role sa2)
//
// Ambassadors have the same rights as the Chapter Director (chapter-scoped data entry).
// Each account gets a unique generated PIN; only the bcrypt hash is stored. The plaintext
// PINs are written to a CSV so they can be distributed - that file is the only copy.
//
// Dry run (default - writes nothing):
//   node scripts/import-ambassadors.js
//
// Create the accounts and write the credential list:
//   node scripts/import-ambassadors.js --write --out=ambassador-pins.csv
//
// Re-running --write refreshes every account's PIN (and rewrites the CSV). Deterministic
// ids (la-<chapter> / sa-<chapter>) mean it updates in place rather than duplicating.

import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map(
  process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value === undefined ? "true" : value];
  })
);
const WRITE = args.get("write") === "true";
const OUT = args.get("out") || "ambassador-pins.csv";
const BCRYPT_COST = 12;

const AMBASSADORS = [
  { role: "sa1", label: "Launch Ambassador", idPrefix: "la" },
  { role: "sa2", label: "Support Ambassador", idPrefix: "sa" }
];

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function randomPin() {
  const weak = new Set(["123456", "000000", "111111", "121212", "654321", "112233", "123123", "1234"]);
  for (;;) {
    let p = "";
    while (p.length < 6) { const b = crypto.randomBytes(1)[0]; if (b < 250) p += String(b % 10); }
    if (weak.has(p) || /^(\d)\1+$/.test(p) || p.startsWith("0")) continue;
    return p;
  }
}

const csvField = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

const db = getDb();
const chapters = (await db.collection("chapters").orderBy("order").get()).docs.map(d => ({ id: d.id, ...d.data() }));
if (!chapters.length) { console.error("No chapters found."); process.exit(1); }

console.log(`${WRITE ? "APPLYING" : "DRY RUN"} - ${chapters.length} chapters -> ${chapters.length * AMBASSADORS.length} ambassador accounts\n`);

const pins = new Set();
const rows = [];

for (const chapter of chapters) {
  for (const a of AMBASSADORS) {
    const id = `${a.idPrefix}-${slug(chapter.name)}`;
    const name = `${chapter.name} ${a.label}`;
    const record = {
      name,
      role: a.role,
      chapter: chapter.name,
      chapters: [chapter.name],
      reportsTo: chapter.seniorDirector || "",
      isAmbassador: true
    };

    let pin;
    do { pin = randomPin(); } while (pins.has(pin));
    pins.add(pin);
    rows.push({ id, name, role: rl(a.role), chapter: chapter.name, pin });

    if (WRITE) {
      record.pinHash = await bcrypt.hash(pin, BCRYPT_COST);
      await db.collection("members").doc(id).set(record, { merge: true });
    }
  }
}

function rl(r) { return r === "sa1" ? "Launch Ambassador" : r === "sa2" ? "Support Ambassador" : r; }

const header = ["Member ID", "Name", "Role", "Chapter", "PIN"];
const csv = [header, ...rows.map(r => [r.id, r.name, r.role, r.chapter, r.pin])]
  .map(cols => cols.map(csvField).join(",")).join("\r\n");

if (WRITE) {
  fs.writeFileSync(OUT, csv, "utf8");
  console.log(`Created/updated ${rows.length} ambassador accounts.`);
  console.log(`Credential list written to ${OUT}`);
  console.log("\nThis file is the only copy of these PINs - they are not recoverable from the database.");
} else {
  console.log(`Would create ${rows.length} accounts. Sample:\n`);
  rows.slice(0, 4).forEach(r => console.log(`  ${r.id.padEnd(26)} ${r.name}`));
  console.log(`  ...`);
  console.log(`\nRe-run with --write to create them and generate ${OUT}.`);
}
process.exit(0);
