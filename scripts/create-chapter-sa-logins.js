// Consolidates Support Ambassador logins to ONE per chapter, labeled "<Chapter> SA".
//
// The previous model created one SA login per real ambassador (sa-<chapter>-<n>).
// This replaces all of those with a single shared chapter account: every SA in a
// chapter signs in through "<Chapter> SA". Each account has role sa1 (the same
// rights as the Chapter Director), is scoped to its one chapter, and gets a fresh
// random 6-digit PIN. So each chapter ends up with exactly 1 DC login + 1 SA login.
//
// Deletes every existing SA / ambassador account (roles sa1/sa2, plus any legacy
// la-/sa- placeholder ids) before creating the new ones. DC / SrDC / AD logins are
// left untouched. The plaintext PINs exist only in the CSV it writes.
//
// Dry run (default - reads Firestore, writes NOTHING to the database or disk):
//   node scripts/create-chapter-sa-logins.js
//
// Apply (updates Firestore members and (re)writes the credential CSV):
//   node scripts/create-chapter-sa-logins.js --write --out=sa-logins.csv

import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? "true" : v];
}));
const WRITE = args.get("write") === "true";
const OUT = args.get("out") || "sa-logins.csv";
const BCRYPT_COST = 12;

const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const csvField = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

function randomPin(used) {
  const weak = new Set(["123456", "000000", "111111", "121212", "654321", "112233", "123123", "1234"]);
  for (;;) {
    let p = ""; while (p.length < 6) { const b = crypto.randomBytes(1)[0]; if (b < 250) p += String(b % 10); }
    if (weak.has(p) || /^(\d)\1+$/.test(p) || p.startsWith("0") || used.has(p)) continue;
    used.add(p); return p;
  }
}

const db = getDb();

// All chapters, in their display order.
const chapterDocs = (await db.collection("chapters").get()).docs
  .map(d => d.data())
  .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));

// Every current SA / ambassador account (role sa1/sa2, or a legacy la-/sa- id).
// DC (dc-*), SrDC (srdc-*) and AD (ad-*) accounts are intentionally excluded.
const memberDocs = (await db.collection("members").get()).docs;
const toDelete = memberDocs.filter(d => {
  const m = d.data();
  return ["sa1", "sa2"].includes(m.role) || /^(sa|la)-/.test(d.id);
});

const used = new Set();
const rows = chapterDocs.map(c => ({
  id: `sa-${slug(c.name)}`,
  name: `${c.name} SA`,
  chapter: c.name,
  reportsTo: c.seniorDirector || "",
  pin: randomPin(used)
}));

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}\n`);
console.log(`chapters                    : ${chapterDocs.length}`);
console.log(`existing SA accounts to del : ${toDelete.length}`);
console.log(`chapter SA logins to create : ${rows.length}`);
console.log(`  => each chapter: 1 DC login + 1 SA login`);
console.log("\nNew SA accounts (sample):");
rows.slice(0, 8).forEach(r => console.log(`  ${r.id.padEnd(22)} ${r.name.padEnd(24)} reportsTo ${r.reportsTo}`));
console.log("\nDeleting (sample):");
toDelete.slice(0, 8).forEach(d => console.log(`  ${d.id.padEnd(22)} (${d.data().role || "?"}) ${d.data().name || ""}`));

if (WRITE) {
  let removed = 0, created = 0;
  for (const d of toDelete) { await d.ref.delete(); removed++; }
  for (const r of rows) {
    await db.collection("members").doc(r.id).set({
      name: r.name, role: "sa1", chapter: r.chapter, chapters: [r.chapter],
      reportsTo: r.reportsTo, isAmbassador: true, pinHash: await bcrypt.hash(r.pin, BCRYPT_COST)
    });
    created++;
  }
  const header = ["Member ID", "Name", "Role", "Chapter", "PIN"];
  const csv = [header, ...rows.map(r => [r.id, r.name, "Support Ambassador", r.chapter, r.pin])]
    .map(c => c.map(csvField).join(",")).join("\r\n");
  fs.writeFileSync(OUT, csv, "utf8");
  console.log(`\nDeleted ${removed} old SA accounts, created ${created} chapter SA logins.`);
  console.log(`Credential list written to ${OUT} (the only copy of these PINs).`);
} else {
  console.log(`\nRe-run with --write to apply and generate ${OUT}.`);
}
process.exit(0);
