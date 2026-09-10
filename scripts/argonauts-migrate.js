// Migrate Dinesh Sitlani's ARGONAUTS Firebase data into the SGT (region) Firebase.
//
// Reads Argonauts read-only (its own service-account key) and writes into SGT (the
// project's configured service account). Scope, decided with the region lead:
//   IMPORT : weeklyData (202), renewalsDone (16), miyagiMembers (Argonauts wins),
//            visitorPipeline, monthlyTargets + chapterGoals, call attendance
//   SKIP   : members/logins (SGT's are the standard), meta/dues (SGT newer),
//            meta/tlr + meta/lengthOfMembership (region-wide, SGT has its own),
//            activityLog, branding, config
//
// Only the 9 Argonauts chapters are touched. Miyagi "Argonauts wins" = each Argonauts
// member doc replaces the same-id SGT doc; SGT-only members are left untouched.
//
// Dry run (default, writes NOTHING):   node scripts/argonauts-migrate.js
// Apply:                               node scripts/argonauts-migrate.js --write

import fs from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDb } from "../src/firebaseAdmin.js";

const WRITE = process.argv.includes("--write");
const ARGO_KEY = "C:/Users/Admin/Downloads/bni-argonauts-firebase-adminsdk-fbsvc-64c670be26.json";
const CHAPTERS = ["Ares","Atilius","Crios","Faustus","Lincoln","Makarios","Obsidian","Prometheus","Tyche"];
const inScope = c => CHAPTERS.includes(c);
const miyagiId = (c,n)=>(c+"_"+n).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");

// Confirmed same-person spelling duplicates (region lead confirmed 8). For each, the
// stale SGT Miyagi doc is DELETED so the Argonauts record - written under its own id -
// is the only copy. The two "partial name" cases (Obsidian Mahendra, Sumeet) were
// intentionally excluded and stay as separate new records.
const MERGE_ALIASES = [
  { chapter:"Crios",    sgtName:"Yogesh thakkar" },
  { chapter:"Faustus",  sgtName:"Bhawin Kamothi" },
  { chapter:"Faustus",  sgtName:"Rakesh Thoria" },
  { chapter:"Faustus",  sgtName:"Rushabh Ambawi" },
  { chapter:"Faustus",  sgtName:"Virendrasingh Rathod" },
  { chapter:"Obsidian", sgtName:"Kinnari Shah" },
  { chapter:"Obsidian", sgtName:"Prashant Basavraj" },
  { chapter:"Obsidian", sgtName:"Subham Bothra" }
];

// Initialise the SGT default app FIRST (getFirebaseAdmin only inits when no app
// exists yet), then add the named Argonauts app alongside it.
const sgt = getDb();                   // TARGET (default app)
const svc = JSON.parse(fs.readFileSync(ARGO_KEY, "utf8"));
const argoApp = initializeApp({ credential: cert(svc), projectId: svc.project_id }, "argo");
const argo = getFirestore(argoApp);   // SOURCE (read-only)

const line = "=".repeat(64);
console.log(`\n${WRITE ? "APPLYING (writing to SGT)" : "DRY RUN (nothing written)"}`);
console.log(`source: ${svc.project_id}  ->  target: SGT\n${line}`);

// Collect every planned write as {coll, id, data, merge} so the dry run and the apply
// share exactly one plan.
const plan = [];
const summary = {};
const note = (k, v) => { summary[k] = v; };

// ---- weeklyData (clean: SGT has 0 for these chapters) ----
{
  const snap = await argo.collection("weeklyData").get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => inScope(r.chapter));
  const sgtIds = new Set((await sgt.collection("weeklyData").get()).docs.map(d => d.id));
  const collisions = rows.filter(r => sgtIds.has(r.id)).length;
  rows.forEach(({ id, ...data }) => plan.push({ coll: "weeklyData", id, data, merge: false }));
  note("weeklyData", `${rows.length} entries  (SGT collisions: ${collisions})`);
}

// ---- renewalsDone (clean add) ----
{
  const snap = await argo.collection("renewalsDone").get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => inScope(r.chapter) || CHAPTERS.some(c => r.id.startsWith(c + "_")));
  const sgtIds = new Set((await sgt.collection("renewalsDone").get()).docs.map(d => d.id));
  const collisions = rows.filter(r => sgtIds.has(r.id)).length;
  rows.forEach(({ id, ...data }) => plan.push({ coll: "renewalsDone", id, data, merge: false }));
  note("renewalsDone", `${rows.length} completions  (SGT collisions: ${collisions})`);
}

// ---- miyagiMembers (Argonauts wins: overwrite same-id, keep SGT-only) ----
{
  const snap = await argo.collection("miyagiMembers").get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => inScope(r.chapter));
  const sgtIds = new Set((await sgt.collection("miyagiMembers").get()).docs.map(d => d.id));
  const overwrite = rows.filter(r => sgtIds.has(r.id)).length;
  const added = rows.length - overwrite;
  rows.forEach(({ id, ...data }) => plan.push({ coll: "miyagiMembers", id, data, merge: false }));
  note("miyagiMembers", `${rows.length} (overwrite existing: ${overwrite}, new: ${added}; SGT-only members left as-is)`);
}

// ---- Miyagi merge-deletes (remove stale SGT duplicates for the 8 confirmed aliases) ----
const deletes = [];
{
  const sgtMiyagiIds = new Set((await sgt.collection("miyagiMembers").get()).docs.map(d => d.id));
  const missing = [];
  for (const a of MERGE_ALIASES) {
    const id = miyagiId(a.chapter, a.sgtName);
    if (sgtMiyagiIds.has(id)) deletes.push({ coll: "miyagiMembers", id });
    else missing.push(`${a.chapter}/${a.sgtName}`);
  }
  note("miyagi de-dup", `${deletes.length} stale SGT docs to delete${missing.length ? "   NOT FOUND: " + missing.join(", ") : ""}`);
}

// ---- visitorPipeline (clean add) ----
{
  const snap = await argo.collection("visitorPipeline").get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => inScope(r.chapter));
  rows.forEach(({ id, ...data }) => plan.push({ coll: "visitorPipeline", id, data, merge: false }));
  note("visitorPipeline", `${rows.length} contacts`);
}

// ---- attendance (merge week docs; keyed to Argonauts ids - brought over as-is) ----
{
  const snap = await argo.collection("attendance").get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  rows.forEach(({ id, ...data }) => plan.push({ coll: "attendance", id, data, merge: true }));
  note("attendance", `${rows.length} week docs (merged into SGT)`);
}

// ---- meta/monthlyTargets + meta/chapterGoals (merge only the 9 chapters' keys) ----
const metaMerges = [];
{
  const mt = (await argo.collection("meta").doc("monthlyTargets").get()).data() || {};
  const keep = {};
  for (const [k, v] of Object.entries(mt)) {
    if (k.includes("undefined")) continue;                      // drop junk keys
    if (CHAPTERS.some(c => k === c || k.startsWith(c + "_"))) keep[k] = v;
  }
  const sgtMt = (await sgt.collection("meta").doc("monthlyTargets").get()).data() || {};
  const overlap = Object.keys(keep).filter(k => k in sgtMt).length;
  metaMerges.push({ doc: "monthlyTargets", data: keep });
  note("meta/monthlyTargets", `${Object.keys(keep).length} keys (overwriting ${overlap} existing SGT keys)`);

  const cg = (await argo.collection("meta").doc("chapterGoals").get()).data() || {};
  const keepG = {};
  for (const [k, v] of Object.entries(cg)) if (CHAPTERS.includes(k)) keepG[k] = v;
  const sgtCg = (await sgt.collection("meta").doc("chapterGoals").get()).data() || {};
  const overlapG = Object.keys(keepG).filter(k => k in sgtCg).length;
  metaMerges.push({ doc: "chapterGoals", data: keepG });
  note("meta/chapterGoals", `${Object.keys(keepG).length} chapters (overwriting ${overlapG} existing)`);
}

console.log("PLAN");
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} : ${v}`);
console.log(`  ${"TOTAL doc writes".padEnd(20)} : ${plan.length} + ${metaMerges.length} meta merges`);
console.log(line);

if (!WRITE) {
  console.log("Re-run with --write to apply.\n");
  process.exit(0);
}

// ---- APPLY ----
let done = 0;
for (let i = 0; i < plan.length; i += 400) {
  const batch = sgt.batch();
  for (const p of plan.slice(i, i + 400)) {
    batch.set(sgt.collection(p.coll).doc(p.id), p.data, { merge: p.merge });
  }
  await batch.commit();
  done += Math.min(400, plan.length - i);
  console.log(`  committed ${done}/${plan.length} docs`);
}
for (const m of metaMerges) {
  await sgt.collection("meta").doc(m.doc).set(m.data, { merge: true });
  console.log(`  merged meta/${m.doc}`);
}
if (deletes.length) {
  const batch = sgt.batch();
  deletes.forEach(d => batch.delete(sgt.collection(d.coll).doc(d.id)));
  await batch.commit();
  console.log(`  deleted ${deletes.length} stale Miyagi duplicates`);
}
console.log(`\nDONE. Wrote ${plan.length} docs + ${metaMerges.length} meta merges, deleted ${deletes.length} dupes into SGT.\n`);
process.exit(0);
