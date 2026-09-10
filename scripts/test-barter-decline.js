// Tests the Decline flow: one recipient passing keeps the request live for the others;
// when every recipient passes, the request closes itself. Cleans up after itself.
import { getDb } from "../src/firebaseAdmin.js";
import { account } from "./barter-test-accounts.js";

const BASE = "http://localhost:3000/api";
const A = account("heena");    // requester - Crios
const B = account("alpesh");   // holder 1  - Ares
const C = account("nilay");    // holder 2  - Atlas
const WANT = "Architect";      // A wants this; B and C hold it
const OFFER = "App Developer"; // A offers this

const created = { checks: [], requests: [] };
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ✓" : "  ✗ FAIL") + " " + m); if (!c) fails++; };

const login = async m => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: m.id, pin: m.pin }) });
  const j = await r.json(); if (!r.ok) throw new Error(`login ${m.id}: ${j.error}`); return j.token;
};
const api = async (t, p, method = "GET", body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const x = await r.text(); const j = x ? JSON.parse(x) : null;
  if (!r.ok) throw new Error(`${method} ${p}: ${(j && j.error) || r.status}`); return j;
};
const inboxHas = (inbox, id) => (inbox.inbox || []).some(i => i.requestId === id);
const myReq = (mine, id) => (mine.requests || []).find(r => r.id === id);

try {
  const [ta, tb, tc] = [await login(A), await login(B), await login(C)];

  const ca = await api(ta, "/barter/checks", "POST", { sub: OFFER, prospectName: "Decline Test A", phone: "111" });
  created.checks.push(ca.check.id);
  const cb = await api(tb, "/barter/checks", "POST", { sub: WANT, prospectName: "Decline Test B", phone: "222" });
  created.checks.push(cb.check.id);
  const cc = await api(tc, "/barter/checks", "POST", { sub: WANT, prospectName: "Decline Test C", phone: "333" });
  created.checks.push(cc.check.id);

  const req = await api(ta, "/barter/requests", "POST", { sub: WANT });
  const id = req.request.id; created.requests.push(id);
  ok(req.request.recipientCount === 2, `request routed to 2 holders (got ${req.request.recipientCount})`);
  ok(inboxHas(await api(tb, "/barter/inbox"), id), "B sees it in inbox");
  ok(inboxHas(await api(tc, "/barter/inbox"), id), "C sees it in inbox");

  // --- one recipient declines ---
  const d1 = await api(tb, `/barter/requests/${id}/decline`, "POST", {});
  ok(d1.declined === true && d1.closed === false, `B declined; request NOT closed (remaining ${d1.remaining})`);
  ok(!inboxHas(await api(tb, "/barter/inbox"), id), "it left B's inbox");
  ok(inboxHas(await api(tc, "/barter/inbox"), id), "it is STILL live in C's inbox");
  const rA1 = myReq(await api(ta, "/barter/mine"), id);
  ok(rA1 && rA1.status === "open", "requester still sees it as open");
  ok(rA1 && rA1.declinedCount === 1, `requester sees 1 passed (got ${rA1 && rA1.declinedCount})`);

  // B can no longer confirm what they declined
  let blocked = false;
  try { await api(tb, `/barter/requests/${id}/confirm`, "POST", { offeredCheckId: ca.check.id }); } catch { blocked = true; }
  ok(blocked, "B cannot confirm after declining");

  // --- last recipient declines -> auto-close ---
  const d2 = await api(tc, `/barter/requests/${id}/decline`, "POST", {});
  ok(d2.closed === true, "all passed -> request auto-closed");
  ok(!inboxHas(await api(tc, "/barter/inbox"), id), "it left C's inbox too");
  const rA2 = myReq(await api(ta, "/barter/mine"), id);
  ok(rA2 && rA2.status === "declined", `requester now sees "No takers" (status ${rA2 && rA2.status})`);

  // a closed request can no longer be confirmed
  let closedBlocked = false;
  try { await api(tc, `/barter/requests/${id}/confirm`, "POST", { offeredCheckId: ca.check.id }); } catch { closedBlocked = true; }
  ok(closedBlocked, "a closed request cannot be confirmed");
} catch (e) {
  console.log("ERROR:", e.message); fails++;
} finally {
  const db = getDb();
  for (const cid of created.checks) { try { await db.collection("checks").doc(cid).delete(); } catch {} }
  for (const rid of created.requests) { try { await db.collection("barterRequests").doc(rid).delete(); } catch {} }
  console.log(`\ncleaned up ${created.checks.length} checks + ${created.requests.length} request(s)`);
  console.log(fails ? `\n❌ ${fails} failed` : `\n✅ all decline checks passed`);
  process.exit(fails ? 1 : 0);
}
