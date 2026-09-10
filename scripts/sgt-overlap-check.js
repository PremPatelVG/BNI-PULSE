// READ-ONLY: what does SGT already hold for the 9 Argonauts chapters? Writes nothing.
import { getDb } from "../src/firebaseAdmin.js";

const ARGO = ["Ares","Atilius","Crios","Faustus","Lincoln","Makarios","Obsidian","Prometheus","Tyche"];
const db = getDb();

try {
  const wd = await db.collection("weeklyData").get();
  const wdArgo = wd.docs.map(d=>d.data()).filter(r=>ARGO.includes(r.chapter));
  const byCh = {}; wdArgo.forEach(r=>{byCh[r.chapter]=(byCh[r.chapter]||0)+1;});
  const dates = wdArgo.map(r=>r.date).filter(Boolean).sort();
  console.log(`SGT weeklyData total: ${wd.size}`);
  console.log(`  for Argo 9 chapters: ${wdArgo.length}  range ${dates[0]||"-"} -> ${dates[dates.length-1]||"-"}`);
  console.log(`  per chapter: ${JSON.stringify(byCh)}`);

  const mm = await db.collection("miyagiMembers").get();
  const mmArgo = mm.docs.map(d=>d.data()).filter(r=>ARGO.includes(r.chapter));
  const mmByCh = {}; mmArgo.forEach(r=>{mmByCh[r.chapter]=(mmByCh[r.chapter]||0)+1;});
  console.log(`\nSGT miyagiMembers total: ${mm.size}`);
  console.log(`  for Argo 9 chapters: ${mmArgo.length}  per chapter: ${JSON.stringify(mmByCh)}`);

  const mem = await db.collection("members").get();
  const memArgo = mem.docs.map(d=>({id:d.id,...d.data()})).filter(r=>ARGO.includes(r.chapter)||(r.chapters||[]).some(c=>ARGO.includes(c)));
  console.log(`\nSGT members total: ${mem.size}`);
  console.log(`  linked to Argo 9 chapters: ${memArgo.length}`);
  memArgo.forEach(m=>console.log(`   - ${m.id.padEnd(20)} ${(m.name||"").padEnd(22)} ${(m.role||"").padEnd(6)} ${m.chapter||(m.chapters||[]).join("/")}`));

  const dues = await db.collection("meta").doc("dues").get();
  const duesRows = (dues.exists?dues.data().members:[])||[];
  const duesArgo = duesRows.filter(r=>ARGO.includes(r.chapter));
  console.log(`\nSGT meta/dues rows total: ${duesRows.length}  for Argo 9: ${duesArgo.length}  (uploadedAt ${dues.data()?.uploadedAt||"-"})`);

  const rd = await db.collection("renewalsDone").get();
  const rdArgo = rd.docs.filter(d=>ARGO.some(c=>d.id.startsWith(c+"_")));
  console.log(`\nSGT renewalsDone total: ${rd.size}  for Argo 9: ${rdArgo.length}`);
} catch (e) {
  console.log("SGT READ FAILED:", e.code || e.message);
}
process.exit(0);
