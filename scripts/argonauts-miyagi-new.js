// READ-ONLY: list the Argonauts Miyagi members that are NEW to SGT (id not present),
// grouped by chapter, flagging likely spelling-duplicates of existing SGT members.
import fs from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDb } from "../src/firebaseAdmin.js";

const CHAPTERS = ["Ares","Atilius","Crios","Faustus","Lincoln","Makarios","Obsidian","Prometheus","Tyche"];
const sgt = getDb();
const svc = JSON.parse(fs.readFileSync("C:/Users/Admin/Downloads/bni-argonauts-firebase-adminsdk-fbsvc-64c670be26.json","utf8"));
const argo = getFirestore(initializeApp({ credential: cert(svc), projectId: svc.project_id }, "argo"));

const miyagiId = (c,n)=>(c+"_"+n).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
const norm = n => String(n||"").toLowerCase().replace(/\b(dr|mr|mrs|ms|prof|ca|adv)\b/g,"").replace(/[^a-z0-9]+/g," ").trim();
const tokens = n => new Set(norm(n).split(" ").filter(Boolean));
function similar(a,b){ // share >=1 non-trivial token, or substring
  const na=norm(a), nb=norm(b); if(!na||!nb) return false;
  if(na===nb) return true;
  if(na.replace(/ /g,"").includes(nb.replace(/ /g,"")) || nb.replace(/ /g,"").includes(na.replace(/ /g,""))) return true;
  const ta=tokens(a), tb=tokens(b); let shared=0; ta.forEach(t=>{ if(t.length>=3 && tb.has(t)) shared++; });
  return shared>=1;
}

const argoRows = (await argo.collection("miyagiMembers").get()).docs.map(d=>({id:d.id,...d.data()})).filter(r=>CHAPTERS.includes(r.chapter));
const sgtRows  = (await sgt.collection("miyagiMembers").get()).docs.map(d=>({id:d.id,...d.data()})).filter(r=>CHAPTERS.includes(r.chapter));
const sgtIds = new Set(sgtRows.map(r=>r.id));
const sgtByChapter = {}; sgtRows.forEach(r=>{ (sgtByChapter[r.chapter]=sgtByChapter[r.chapter]||[]).push(r); });

const newRows = argoRows.filter(r=>!sgtIds.has(r.id));
console.log(`\n${newRows.length} NEW Miyagi members (not currently in SGT), by chapter:`);
console.log("  ⚠ = a same-chapter SGT member has a similar name (possible duplicate)\n");

let dupCount = 0;
for (const ch of CHAPTERS) {
  const list = newRows.filter(r=>r.chapter===ch).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  if (!list.length) continue;
  console.log(`### ${ch} (${list.length} new)`);
  for (const r of list) {
    const match = (sgtByChapter[ch]||[]).find(s=>similar(s.name, r.name));
    const flag = match ? `   ⚠ maybe = SGT "${match.name}"` : "";
    if (match) dupCount++;
    console.log(`   - ${String(r.name||"").padEnd(26)} score ${String(r.score||0).padStart(3)}  ${String(r.status||"active").padEnd(9)}${flag}`);
  }
  console.log("");
}
console.log(`Total new: ${newRows.length}   Flagged as possible spelling-duplicates: ${dupCount}\n`);
process.exit(0);
