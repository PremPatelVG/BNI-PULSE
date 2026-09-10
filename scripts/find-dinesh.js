// READ-ONLY: find Dinesh Sitlani in SGT, and dump all SrDC records for context.
import { getDb } from "../src/firebaseAdmin.js";
const db = getDb();
const mem = (await db.collection("members").get()).docs.map(d=>({id:d.id,...d.data()}));

const hit = mem.filter(m=>/dinesh|sit(h)?lani/i.test(m.name||"")||/dinesh|sitlani/i.test(m.id||""));
console.log(`\nMembers matching "dinesh"/"sitlani": ${hit.length}`);
hit.forEach(m=>console.log(`  - id=${m.id}  name="${m.name}"  role=${m.role}  chapter=${m.chapter||(m.chapters||[]).join("/")}  reportsTo=${m.reportsTo||""}`));

console.log(`\nAll Senior Directors (role=srdc):`);
mem.filter(m=>m.role==="srdc").forEach(m=>{
  console.log(`  - id=${m.id}  name="${m.name}"  chapters=${JSON.stringify(m.chapters||[m.chapter])}  reportsTo=${m.reportsTo||""}`);
});

console.log(`\nPrometheus-linked members (Dinesh's Argonauts home chapter):`);
mem.filter(m=>m.chapter==="Prometheus"||(m.chapters||[]).includes("Prometheus")).forEach(m=>{
  console.log(`  - id=${m.id}  name="${m.name}"  role=${m.role}`);
});
process.exit(0);
