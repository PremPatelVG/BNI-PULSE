// Seeds a realistic Sicilian Barter scenario so the local preview shows every screen
// with content: a populated board, an OPEN request sitting in two inboxes (to show the
// Decline button), and one CONFIRMED trade (to fill My Trades and the leadership
// analytics). Every prospect is prefixed DEMO so it is unmistakable.
//
//   node scripts/seed-barter-demo.js          -> seed
//   node scripts/seed-barter-demo.js --purge  -> remove ALL checks + barterRequests
import { getDb } from "../src/firebaseAdmin.js";
import DCS from "./barter-test-accounts.js";

const BASE = "http://localhost:3000/api";
const PURGE = process.argv.includes("--purge");

const login = async m => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: m.id, pin: m.pin }) });
  const j = await r.json(); if (!r.ok) throw new Error(`login ${m.id}: ${j.error}`); return j.token;
};
const api = async (t, p, method = "GET", body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const x = await r.text(); const j = x ? JSON.parse(x) : null;
  if (!r.ok) throw new Error(`${method} ${p}: ${(j && j.error) || r.status}`); return j;
};

if (PURGE) {
  const db = getDb();
  let c = 0, r = 0;
  for (const d of (await db.collection("checks").get()).docs) { await d.ref.delete(); c++; }
  for (const d of (await db.collection("barterRequests").get()).docs) { await d.ref.delete(); r++; }
  console.log(`purged ${c} checks and ${r} barter requests — board is empty again`);
  process.exit(0);
}

const t = {};
for (const [k, m] of Object.entries(DCS)) t[k] = await login(m);

const add = (who, sub, name, phone) => api(t[who], "/barter/checks", "POST", { sub, prospectName: "DEMO " + name, phone });

// --- a board with a few categories across chapters ---
await add("heena",  "App Developer",      "Ravi Shah",      "9820011111");
await add("heena",  "Digital Content",    "Neha Trivedi",   "9820022222");
await add("alpesh", "Architect",          "Kunal Desai",    "9820033333");
await add("alpesh", "Commercial Real Estate",  "Priya Nair",     "9820044444");
await add("nilay",  "Architect",          "Sameer Joshi",   "9820055555");
await add("punit",  "Interior Design - Residential",  "Anita Rao",      "9820066666");
await add("vyomesh","Agronomist",         "Mahesh Patel",   "9820077777");
await add("hardik", "Boarding",           "Farah Sheikh",   "9820088888");

// --- one CONFIRMED trade: Punit wants Real Estate Agent, Alpesh takes Interior Designer ---
const tradeReq = await api(t.punit, "/barter/requests", "POST", { sub: "Commercial Real Estate" });
const alpeshInbox = await api(t.alpesh, "/barter/inbox");
const item = (alpeshInbox.inbox || []).find(i => i.requestId === tradeReq.request.id);
const offered = item && (item.offered || []).find(o => o.sub === "Interior Design - Residential");
if (offered) {
  await api(t.alpesh, `/barter/requests/${tradeReq.request.id}/confirm`, "POST", { offeredCheckId: offered.checkId });
  console.log("confirmed trade  : Punit Periwal (Alethia) ⇄ Alpesh Shah (Ares)");
}

// --- one OPEN request routed to TWO holders, so the Decline button is visible ---
const openReq = await api(t.heena, "/barter/requests", "POST", { sub: "Architect" });
console.log(`open request     : Heena Poriya (Crios) wants Architect → ${openReq.request.recipientCount} inbox(es)`);

const board = await api(t.heena, "/barter/board");
console.log(`board            : ${board.totalAvailable} checks available across ${Object.keys(board.counts).length} classifications`);
console.log("\nDemo data seeded. Purge it with:  node scripts/seed-barter-demo.js --purge");
process.exit(0);
