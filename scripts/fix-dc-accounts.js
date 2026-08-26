// Corrects Chapter Director (DC) accounts after some DCs left the organisation.
//
//  * Mihir Parikh is now DC of BNI Hera only (removed from BNI Anatolius).
//  * BNI Anatolius gets a new generic DC login labeled "BNI Anatolius DC".
//  * Three DCs who left are relabeled to the "<Chapter> DC" convention (their
//    login id and PIN are kept, only the display name changes):
//        Anand Patel.    (Makarios) -> "Makarios DC"
//        Saurin Sanghavi (Kleon)    -> "Kleon DC"
//        Dr Palak Mehta  (Rubens)   -> "Rubens DC"
//  * Each affected chapter's chapterDirector field is updated to match.
//
// Dry run (default, reads only):
//   node scripts/fix-dc-accounts.js
// Apply:
//   node scripts/fix-dc-accounts.js --write
//
// NOTE: needs Firestore quota. If you hit "RESOURCE_EXHAUSTED: Quota exceeded",
// wait for the daily free-tier quota to reset (midnight US Pacific) and retry.

import bcrypt from "bcryptjs";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const BCRYPT_COST = 12;
const NEW_ANATOLIUS_PIN = "1234"; // matches the other DC logins; change later if desired

const db = getDb();

// name-only relabels for the departed DCs (keep id + pinHash + chapter scope)
const RENAME = {
  "dc-anand-patel": "Makarios DC",
  "dc-saurin-sanghavi": "Kleon DC",
  "dc-dr-palak-mehta": "Rubens DC"
};
// chapter document chapterDirector updates (matched by chapter name)
const CHAPTER_DIRECTOR = {
  "Makarios": "Makarios DC",
  "Kleon": "Kleon DC",
  "Rubens": "Rubens DC",
  "BNI Anatolius": "BNI Anatolius DC"
};

console.log(`${WRITE ? "APPLYING" : "DRY RUN (nothing written)"}\n`);

// --- inspect current member accounts ---
const ids = ["dc-mihir-parikh", ...Object.keys(RENAME), "dc-bni-anatolius"];
for (const id of ids) {
  const d = await db.collection("members").doc(id).get();
  console.log(`  ${id.padEnd(22)} ${d.exists ? `name="${d.data().name}" chapters=${JSON.stringify(d.data().chapters || d.data().chapter)}` : "(does not exist)"}`);
}

// --- inspect chapter directors ---
const chSnap = await db.collection("chapters").get();
const chDocs = chSnap.docs.filter(d => Object.prototype.hasOwnProperty.call(CHAPTER_DIRECTOR, d.data().name));
console.log("");
chDocs.forEach(d => console.log(`  chapter "${d.data().name}"  chapterDirector: "${d.data().chapterDirector}" -> "${CHAPTER_DIRECTOR[d.data().name]}"`));

console.log("\nPlanned changes:");
console.log("  - dc-mihir-parikh   -> chapter/chapters = ['BNI Hera'] (removed BNI Anatolius)");
Object.entries(RENAME).forEach(([id, nm]) => console.log(`  - ${id.padEnd(19)} -> name = "${nm}"`));
console.log('  - dc-bni-anatolius  -> CREATE "BNI Anatolius DC" (dc, BNI Anatolius, reportsTo Nilay Shah)');
chDocs.forEach(d => console.log(`  - chapter ${d.id} (${d.data().name}) -> chapterDirector = "${CHAPTER_DIRECTOR[d.data().name]}"`));

if (!WRITE) {
  console.log("\nRe-run with --write to apply.");
  process.exit(0);
}

// --- apply ---
await db.collection("members").doc("dc-mihir-parikh").set(
  { chapter: "BNI Hera", chapters: ["BNI Hera"] }, { merge: true }
);
for (const [id, name] of Object.entries(RENAME)) {
  await db.collection("members").doc(id).set({ name }, { merge: true });
}
await db.collection("members").doc("dc-bni-anatolius").set({
  name: "BNI Anatolius DC", role: "dc", chapter: "BNI Anatolius", chapters: ["BNI Anatolius"],
  reportsTo: "Nilay Shah", pinHash: await bcrypt.hash(NEW_ANATOLIUS_PIN, BCRYPT_COST)
});
for (const d of chDocs) {
  await d.ref.set({ chapterDirector: CHAPTER_DIRECTOR[d.data().name] }, { merge: true });
}

console.log("\nApplied. dc-mihir-parikh trimmed to BNI Hera, 3 DCs relabeled, BNI Anatolius DC created,");
console.log(`${chDocs.length} chapter director fields updated. New "BNI Anatolius DC" PIN: ${NEW_ANATOLIUS_PIN}`);
process.exit(0);
