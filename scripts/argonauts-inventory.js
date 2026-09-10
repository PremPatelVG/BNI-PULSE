// READ-ONLY inventory of the Argonauts Firebase project. Writes nothing.
// Run: node argonauts-inventory.js
import fs from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const KEY = "C:/Users/Admin/Downloads/bni-argonauts-firebase-adminsdk-fbsvc-64c670be26.json";
const svc = JSON.parse(fs.readFileSync(KEY, "utf8"));
const app = initializeApp({ credential: cert(svc), projectId: svc.project_id }, "argo");
const db = getFirestore(app);

const COLLECTIONS = ["chapters", "members", "weeklyData", "visitorPipeline",
  "miyagiMembers", "attendance", "renewalsDone", "activityLog"];
const META = ["dues", "tlr", "config", "monthlyTargets", "chapterGoals", "lengthOfMembership", "branding"];

const line = "=".repeat(60);
console.log(`\nARGONAUTS FIREBASE INVENTORY  (project: ${svc.project_id})\n${line}`);

for (const name of COLLECTIONS) {
  const snap = await db.collection(name).get();
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`\n### ${name}: ${docs.length} docs`);

  if (name === "members") {
    const byRole = {};
    docs.forEach(m => { byRole[m.role || "?"] = (byRole[m.role || "?"] || 0) + 1; });
    console.log("   roles:", JSON.stringify(byRole));
    docs.forEach(m => console.log(`   - ${(m.name||"").padEnd(24)} ${(m.role||"").padEnd(6)} ${(m.chapter||(m.chapters||[]).join("/")||"")}  ${m.pinHash?"[pin]":m.pin?"[plainpin]":"[nopin]"}`));
  } else if (name === "chapters") {
    docs.forEach(c => console.log(`   - ${c.name}  (DC: ${c.director||c.dc||""}  SrDC: ${c.seniorDirector||""})`));
  } else if (name === "weeklyData") {
    const chs = [...new Set(docs.map(d => d.chapter))].sort();
    const dates = docs.map(d => d.date).filter(Boolean).sort();
    console.log("   chapters:", chs.join(", "));
    console.log("   date range:", dates[0], "->", dates[dates.length-1]);
    console.log("   sample:", JSON.stringify(docs[0]).slice(0, 400));
  } else if (name === "attendance") {
    console.log("   week keys:", docs.map(d => d.id).sort().join(", "));
    if (docs[0]) console.log("   sample:", JSON.stringify(docs[0]).slice(0, 300));
  } else if (name === "miyagiMembers") {
    const chs = {};
    docs.forEach(m => { chs[m.chapter||"?"] = (chs[m.chapter||"?"]||0)+1; });
    console.log("   by chapter:", JSON.stringify(chs));
    if (docs[0]) console.log("   sample keys:", Object.keys(docs[0]).join(", "));
  } else if (name === "renewalsDone") {
    console.log("   sample ids:", docs.slice(0,5).map(d=>d.id).join(" | "));
  } else if (name === "visitorPipeline") {
    const chs = {}; docs.forEach(v=>{chs[v.chapter||"?"]=(chs[v.chapter||"?"]||0)+1;});
    console.log("   by chapter:", JSON.stringify(chs));
  } else if (name === "activityLog") {
    const dates = docs.map(d=>d.timestamp||"").filter(Boolean).sort();
    console.log("   range:", dates[0], "->", dates[dates.length-1]);
  }
}

console.log(`\n${line}\nMETA DOCS`);
for (const id of META) {
  const doc = await db.collection("meta").doc(id).get();
  if (!doc.exists) { console.log(`\n### meta/${id}: (missing)`); continue; }
  const d = doc.data();
  if (id === "dues") console.log(`\n### meta/dues: ${(d.members||[]).length} rows  uploadedAt=${d.uploadedAt||""}  chapters=${[...new Set((d.members||[]).map(m=>m.chapter))].join(", ")}`);
  else if (id === "tlr") console.log(`\n### meta/tlr: ${(d.rows||[]).length} rows  uploadedAt=${d.uploadedAt||""}`);
  else if (id === "config") console.log(`\n### meta/config: keys=${Object.keys(d).join(", ")}  srCallDay=${d.srCallDay||""}`);
  else if (id === "lengthOfMembership") console.log(`\n### meta/lengthOfMembership: ${(d.rows||[]).length} rows`);
  else console.log(`\n### meta/${id}: keys=${Object.keys(d).join(", ")}`);
}

console.log(`\n${line}\nDONE (read-only, nothing written)\n`);
process.exit(0);
