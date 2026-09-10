// READ-ONLY: which SGT members CANNOT log in? Login requires a bcrypt `pinHash`
// (handlers.js pinMatches: no pinHash => always "Incorrect PIN"). Writes nothing.
import { getDb } from "../src/firebaseAdmin.js";
const db = getDb();
const mem = (await db.collection("members").get()).docs.map(d => ({ id: d.id, ...d.data() }));

const LOGIN_ROLES = new Set(["ed", "ad", "srdc", "dc", "cd", "sa1", "sa2", "viewer"]);

const noHash = mem.filter(m => !m.pinHash);
const plainOnly = noHash.filter(m => m.pin != null && m.pin !== "");
const neither = noHash.filter(m => m.pin == null || m.pin === "");
const badRole = mem.filter(m => !LOGIN_ROLES.has(m.role));

const hashInfo = m => {
  const h = m.pinHash || "";
  const looksBcrypt = /^\$2[aby]\$\d{2}\$/.test(h);
  return h ? (looksBcrypt ? `bcrypt(${h.slice(0,7)})` : `NON-BCRYPT!(${String(h).slice(0,12)})`) : "none";
};

console.log(`\nTotal members: ${mem.length}`);
console.log(`  with pinHash        : ${mem.length - noHash.length}`);
console.log(`  NO pinHash (cannot login): ${noHash.length}`);
console.log(`    - has plaintext pin only : ${plainOnly.length}  (legacy pin ignored by login)`);
console.log(`    - no pin at all          : ${neither.length}`);
console.log(`  role not in login groups   : ${badRole.length}`);

// Non-bcrypt hashes would also fail bcrypt.compare
const badHash = mem.filter(m => m.pinHash && !/^\$2[aby]\$\d{2}\$/.test(m.pinHash));
console.log(`  pinHash present but NOT bcrypt: ${badHash.length}`);

if (noHash.length) {
  console.log(`\n--- Members with NO pinHash (login always fails) ---`);
  noHash.sort((a,b)=>(a.role||"").localeCompare(b.role||"")||(a.name||"").localeCompare(b.name||""))
    .forEach(m => console.log(`  ${m.id.padEnd(26)} ${(m.name||"").padEnd(26)} ${(m.role||"?").padEnd(6)} ${m.chapter||(m.chapters||[]).join("/")||""}  pin=${m.pin!=null?JSON.stringify(m.pin):"-"}`));
}
if (badHash.length) {
  console.log(`\n--- Members whose pinHash is NOT a bcrypt hash ---`);
  badHash.forEach(m => console.log(`  ${m.id.padEnd(26)} ${(m.name||"").padEnd(26)} ${m.role}  hash=${hashInfo(m)}`));
}
if (badRole.length) {
  console.log(`\n--- Members whose role isn't a login group (won't appear in role dropdown) ---`);
  badRole.forEach(m => console.log(`  ${m.id.padEnd(26)} ${(m.name||"").padEnd(26)} role="${m.role}"`));
}
process.exit(0);
