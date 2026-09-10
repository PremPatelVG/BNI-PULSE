// End-to-end API test of the Check Barter flow against the local server.
// Two DCs in different chapters do a full barter, then we assert + clean up.
// Requires the server running on http://localhost:3000.
import { getDb } from "../src/firebaseAdmin.js";
import { account } from "./barter-test-accounts.js";

const BASE = "http://localhost:3000/api";
const A = account("heena");    // Crios
const B = account("alpesh");   // Ares
const SUB_A = "App Developer";   // A holds & offers this
const SUB_B = "Architect";       // B holds; A requests this

const created = { checks: [], requests: [] };
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`); if (!cond) failures++; };

async function login(m) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: m.id, pin: m.pin }) });
  const j = await r.json(); if (!r.ok) throw new Error(`login ${m.id}: ${j.error}`); return j.token;
}
async function api(token, path, method = "GET", body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); const j = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(`${method} ${path}: ${(j && j.error) || r.status}`); return j;
}

try {
  const [ta, tb] = [await login(A), await login(B)];
  console.log("logged in both DCs");

  const ca = await api(ta, "/barter/checks", "POST", { sub: SUB_A, prospectName: "Alice Dev", phone: "9990001111" });
  created.checks.push(ca.check.id); ok(ca.check.id, `A listed a ${SUB_A} check`);
  const cb = await api(tb, "/barter/checks", "POST", { sub: SUB_B, prospectName: "Bob Arch", phone: "8887776666" });
  created.checks.push(cb.check.id); ok(cb.check.id, `B listed a ${SUB_B} check`);

  const board = await api(ta, "/barter/board");
  ok((board.counts[SUB_A] || 0) >= 1 && (board.counts[SUB_B] || 0) >= 1, `board shows both categories (${SUB_A}:${board.counts[SUB_A]}, ${SUB_B}:${board.counts[SUB_B]})`);

  const req = await api(ta, "/barter/requests", "POST", { sub: SUB_B });
  created.requests.push(req.request.id); ok(req.request.recipientCount >= 1, `A requested ${SUB_B}, routed to ${req.request.recipientCount} holder(s)`);

  const inbox = await api(tb, "/barter/inbox");
  const item = (inbox.inbox || []).find(x => x.requestId === req.request.id);
  ok(!!item, "B sees the request in inbox");
  ok(item && item.requestedSub === SUB_B, "inbox shows the requested category");
  const offer = item && (item.offered || []).find(o => o.sub === SUB_A);
  ok(!!offer && !!offer.checkId, `inbox shows A's offered ${SUB_A} (anonymised, with checkId)`);
  ok(item && item.offered.every(o => o.prospectName === undefined), "offered items do NOT leak prospect names");

  const conf = await api(tb, `/barter/requests/${req.request.id}/confirm`, "POST", { offeredCheckId: offer.checkId });
  ok(conf.matched === true, "B confirmed the barter");
  ok(conf.receivedProspect === "Alice Dev" && conf.receivedCategory === SUB_A, `B receives Alice Dev / ${SUB_A}`);
  ok(conf.partner && conf.partner.chapter === "Crios", `B sees partner chapter (${conf.partner && conf.partner.chapter})`);

  const mineA = await api(ta, "/barter/mine");
  const rA = (mineA.requests || []).find(r => r.id === req.request.id);
  ok(rA && rA.status === "confirmed", "A's request now shows confirmed");
  ok(rA && rA.match && rA.match.receivedProspect === "Bob Arch", `A receives Bob Arch (${rA && rA.match && rA.match.receivedProspect})`);

  const board2 = await api(ta, "/barter/board");
  ok((board2.counts[SUB_A] || 0) < (board.counts[SUB_A] || 0) && (board2.counts[SUB_B] || 0) < (board.counts[SUB_B] || 0), "both checks left the board after the match");

  // double-confirm should fail (already matched)
  let doubleFailed = false;
  try { await api(tb, `/barter/requests/${req.request.id}/confirm`, "POST", { offeredCheckId: offer.checkId }); } catch { doubleFailed = true; }
  ok(doubleFailed, "confirming again is rejected (first-come-first-served)");
} catch (e) {
  console.log("ERROR:", e.message); failures++;
} finally {
  // cleanup test docs
  const db = getDb();
  for (const id of created.checks) { try { await db.collection("checks").doc(id).delete(); } catch {} }
  for (const id of created.requests) { try { await db.collection("barterRequests").doc(id).delete(); } catch {} }
  console.log(`\ncleaned up ${created.checks.length} checks + ${created.requests.length} requests`);
  console.log(failures ? `\n❌ ${failures} check(s) failed` : `\n✅ all checks passed`);
  process.exit(failures ? 1 : 0);
}
