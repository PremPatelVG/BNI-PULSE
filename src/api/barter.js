// Sicilian Barter: a region-wide, anonymous marketplace where DCs/SAs trade "cheques"
// (a prospect whose category is full in their chapter) for a category their chapter
// needs. Strict two-way barter, first-come-first-served, identities hidden until a
// match confirms. This lives OUTSIDE the shared snapshot on purpose: the snapshot ships
// the whole dataset to every client, which would break anonymity. Every read here
// returns only what the caller is allowed to see.
//
// Note: the Firestore collection, routes and field names stay "check*" - renaming
// live data has no upside. "Cheque" is the spelling users see.

import { getDb } from "../firebaseAdmin.js";
import { badRequest, forbidden, isAreaDirector, notFound } from "../services/scope.js";

const MAX_RECIPIENTS = 3;          // a request routes to at most 3 holders (oldest first)
const CHECK_TTL_DAYS = 30;         // checks auto-expire after 30 days
const TRADE_ROLES = new Set(["dc", "cd", "sa1", "sa2"]);

const ok = (body, status = 200) => ({ status, body });
const noContent = () => ({ status: 204, body: null });
const nowIso = () => new Date().toISOString();
const plusDaysIso = n => new Date(Date.now() + n * 86400000).toISOString();
const chapterOf = user => user?.chapter || (user?.chapters && user.chapters[0]) || null;
const notExpired = c => !c.expiresAt || c.expiresAt > nowIso();

function assertCanTrade(user) {
  if (!TRADE_ROLES.has(user?.role) || !chapterOf(user)) {
    throw forbidden("Only a Chapter Director or Support Ambassador can trade cheques");
  }
}

let CAT_CACHE = null; // { at, tree, subToMain, subs:Set }
async function getCategories() {
  if (CAT_CACHE && Date.now() - CAT_CACHE.at < 300000) return CAT_CACHE;
  const doc = await getDb().collection("meta").doc("barterCategories").get();
  const data = doc.exists ? doc.data() : { tree: [], mainCount: 0, subCount: 0 };
  const subToMain = new Map();
  (data.tree || []).forEach(m => (m.subs || []).forEach(s => subToMain.set(s, m.main)));
  CAT_CACHE = { at: Date.now(), tree: data.tree || [], mainCount: data.mainCount || 0, subCount: data.subCount || 0, subToMain, subs: new Set(subToMain.keys()) };
  return CAT_CACHE;
}

async function memberName(id) {
  if (!id) return "";
  try { const d = await getDb().collection("members").doc(id).get(); return d.exists ? (d.data().name || id) : id; }
  catch { return id; }
}

// One batched read for many ids - the board resolves every holder at once.
async function memberNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  if (!unique.length) return out;
  try {
    const db = getDb();
    const docs = await db.getAll(...unique.map(id => db.collection("members").doc(id)));
    docs.forEach((d, i) => out.set(unique[i], (d.exists && d.data().name) || unique[i]));
  } catch { unique.forEach(id => out.set(id, id)); }
  return out;
}

// ---- reads -------------------------------------------------------------------

async function board(user) {
  const snap = await getDb().collection("checks").where("status", "==", "available").get();
  const live = snap.docs.map(d => d.data()).filter(notExpired);
  const counts = {};
  live.forEach(c => { counts[c.sub] = (counts[c.sub] || 0) + 1; });
  const cats = await getCategories();
  const mainTotals = {};
  for (const [sub, n] of Object.entries(counts)) { const main = cats.subToMain.get(sub) || "Other"; mainTotals[main] = (mainTotals[main] || 0) + n; }
  const totalAvailable = Object.values(counts).reduce((s, n) => s + n, 0);

  // Area/Executive Directors and the BNI Office also see WHICH DC is holding each
  // cheque, for oversight. DCs and SAs still get counts only - the board stays
  // anonymous between chapters. Prospect names and phones are never returned here.
  let holders;
  if (isAreaDirector(user)) {
    const names = await memberNames(live.map(c => c.dcId));
    holders = {};
    for (const c of live) {
      (holders[c.sub] = holders[c.sub] || []).push({
        name: names.get(c.dcId) || c.dcId, chapter: c.chapter || "", listedAt: c.createdAt || ""
      });
    }
    for (const list of Object.values(holders)) list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return ok({ counts, mainTotals, totalAvailable, holders, updatedAt: nowIso() });
}

async function myAvailableChecks(dcId) {
  const snap = await getDb().collection("checks").where("dcId", "==", dcId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status === "available" && notExpired(c));
}

async function mine(user) {
  const db = getDb();
  const dcId = user.sub;
  const checkSnap = await db.collection("checks").where("dcId", "==", dcId).get();
  const checks = checkSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.status === "available" || c.status === "matched")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const reqSnap = await db.collection("barterRequests").where("requesterDcId", "==", dcId).get();
  const requests = [];
  for (const d of reqSnap.docs) {
    const r = { id: d.id, ...d.data() };
    if (r.status === "withdrawn") continue;
    const row = { id: r.id, requestedSub: r.requestedSub, requestedMain: r.requestedMain, status: r.status, recipientCount: (r.recipients || []).length, declinedCount: (r.declinedBy || []).length, createdAt: r.createdAt };
    if (r.status === "confirmed") {
      // Requester receives the winner's check (wonCheckId); partner revealed.
      const won = r.wonCheckId ? await db.collection("checks").doc(r.wonCheckId).get() : null;
      row.match = { partnerChapter: r.confirmedByChapter, partnerName: await memberName(r.confirmedByDcId), receivedProspect: won && won.exists ? won.data().prospectName : "", receivedPhone: won && won.exists ? (won.data().phone || "") : "", receivedCategory: r.requestedSub, matchedAt: r.matchedAt };
    }
    requests.push(row);
  }
  requests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // Enrich matched checks with what the holder received in the trade.
  const enriched = [];
  for (const c of checks) {
    const out = { id: c.id, sub: c.sub, main: c.main, prospectName: c.prospectName, phone: c.phone || "", status: c.status, createdAt: c.createdAt, expiresAt: c.expiresAt };
    if (c.status === "matched" && c.matchedWithCheckId) {
      const other = await db.collection("checks").doc(c.matchedWithCheckId).get();
      if (other.exists) { const o = other.data(); out.tradedFor = { category: o.sub, prospect: o.prospectName, phone: o.phone || "", partnerChapter: o.chapter, partnerName: await memberName(o.dcId) }; }
    }
    enriched.push(out);
  }
  return ok({ checks: enriched, requests });
}

async function inbox(user) {
  assertCanTrade(user);
  const db = getDb();
  const snap = await db.collection("barterRequests").where("recipientDcIds", "array-contains", user.sub).get();
  // Requests this holder has already passed on drop out of their inbox, but stay live
  // for the other recipients.
  const open = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.status === "open" && !(r.declinedBy || []).includes(user.sub));
  const items = [];
  for (const r of open) {
    const mineRecipient = (r.recipients || []).find(x => x.holderDcId === user.sub);
    if (!mineRecipient) continue;
    // The requester's CURRENT available checks - category + opaque check id only
    // (no prospect name, chapter or DC identity until a match confirms).
    const offered = (await myAvailableChecks(r.requesterDcId)).map(c => ({ sub: c.sub, main: c.main, checkId: c.id }));
    items.push({ requestId: r.id, requestedSub: r.requestedSub, requestedMain: r.requestedMain, myCheckId: mineRecipient.checkId, offered, createdAt: r.createdAt });
  }
  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return ok({ inbox: items });
}

// Confirmed trade history. A DC/SA sees only their own trades; Area/Executive
// Directors and the BNI Office account (role "ad") see every confirmed trade for
// oversight - who traded with whom and which category each side offered.
async function trades(user) {
  const db = getDb();
  const seesAll = isAreaDirector(user);
  if (!seesAll && !TRADE_ROLES.has(user.role)) throw forbidden("No barter trade history for this account");
  const snap = await db.collection("barterRequests").where("status", "==", "confirmed").get();
  let reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!seesAll) reqs = reqs.filter(r => r.requesterDcId === user.sub || r.confirmedByDcId === user.sub);
  reqs.sort((a, b) => String(b.matchedAt).localeCompare(String(a.matchedAt)));

  const out = [];
  for (const r of reqs) {
    const [wonD, offD] = await Promise.all([
      r.wonCheckId ? db.collection("checks").doc(r.wonCheckId).get() : Promise.resolve(null),
      r.tradedOfferedCheckId ? db.collection("checks").doc(r.tradedOfferedCheckId).get() : Promise.resolve(null)
    ]);
    const won = wonD && wonD.exists ? wonD.data() : {};  // confirmer's check -> requester (category = requestedSub)
    const off = offD && offD.exists ? offD.data() : {};  // requester's check -> confirmer
    out.push({
      id: r.id, matchedAt: r.matchedAt,
      aName: await memberName(r.requesterDcId), aChapter: r.requesterChapter,
      aOfferedCategory: off.sub || "", aOfferedProspect: off.prospectName || "", aOfferedPhone: off.phone || "",
      bName: await memberName(r.confirmedByDcId), bChapter: r.confirmedByChapter,
      bOfferedCategory: r.requestedSub || won.sub || "", bOfferedProspect: won.prospectName || "", bOfferedPhone: won.phone || "",
      iAmRequester: r.requesterDcId === user.sub, iAmConfirmer: r.confirmedByDcId === user.sub
    });
  }
  return ok({ trades: out, scope: seesAll ? "all" : "mine" });
}

// ---- writes ------------------------------------------------------------------

async function addCheck(user, body) {
  assertCanTrade(user);
  const sub = String(body?.sub || "").trim();
  const prospectName = String(body?.prospectName || "").trim();
  const phone = String(body?.phone || "").trim();
  const cats = await getCategories();
  if (!cats.subs.has(sub)) throw badRequest("Pick a valid sub-category from the list");
  if (!prospectName) throw badRequest("Prospect name is required");
  if (!phone) throw badRequest("Contact number is required");
  const check = {
    sub, main: cats.subToMain.get(sub) || "Other", chapter: chapterOf(user), dcId: user.sub,
    prospectName, phone, status: "available", createdAt: nowIso(), expiresAt: plusDaysIso(CHECK_TTL_DAYS)
  };
  const ref = await getDb().collection("checks").add(check);
  return ok({ check: { id: ref.id, ...check } }, 201);
}

async function withdrawCheck(user, checkId) {
  assertCanTrade(user);
  const ref = getDb().collection("checks").doc(checkId);
  const doc = await ref.get();
  if (!doc.exists) throw notFound("Cheque not found");
  if (doc.data().dcId !== user.sub) throw forbidden("That cheque isn't yours");
  if (doc.data().status !== "available") throw badRequest("Only an available cheque can be withdrawn");
  await ref.set({ status: "withdrawn", withdrawnAt: nowIso() }, { merge: true });
  return noContent();
}

async function createRequest(user, body) {
  assertCanTrade(user);
  const db = getDb();
  const sub = String(body?.sub || "").trim();
  const cats = await getCategories();
  if (!cats.subs.has(sub)) throw badRequest("Pick a valid sub-category from the list");
  const myChapter = chapterOf(user);

  // Strict barter: you must be holding at least one check to offer in return.
  const offered = await myAvailableChecks(user.sub);
  if (!offered.length) throw badRequest("You need at least one available cheque of your own to barter");

  // One open request per category at a time.
  const existing = await db.collection("barterRequests").where("requesterDcId", "==", user.sub).get();
  if (existing.docs.some(d => d.data().status === "open" && d.data().requestedSub === sub)) {
    throw badRequest("You already have an open request for this category");
  }

  // Up to MAX_RECIPIENTS available checks for `sub` held by OTHER chapters, oldest first.
  const holdersSnap = await db.collection("checks").where("sub", "==", sub).get();
  const holders = holdersSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.status === "available" && notExpired(c) && c.chapter !== myChapter)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, MAX_RECIPIENTS);
  if (!holders.length) throw badRequest("No other chapter is currently holding that category");

  const recipients = holders.map(c => ({ checkId: c.id, holderDcId: c.dcId, holderChapter: c.chapter }));
  const req = {
    requesterDcId: user.sub, requesterChapter: myChapter, requestedSub: sub,
    requestedMain: cats.subToMain.get(sub) || "Other",
    recipients, recipientDcIds: [...new Set(recipients.map(r => r.holderDcId))],
    status: "open", createdAt: nowIso()
  };
  const ref = await db.collection("barterRequests").add(req);
  return ok({ request: { id: ref.id, requestedSub: sub, recipientCount: recipients.length } }, 201);
}

async function confirmRequest(user, requestId, body) {
  assertCanTrade(user);
  const db = getDb();
  const offeredCheckId = String(body?.offeredCheckId || "");
  if (!offeredCheckId) throw badRequest("Pick which of the offered cheques you want");

  const result = await db.runTransaction(async t => {
    const reqRef = db.collection("barterRequests").doc(requestId);
    const reqDoc = await t.get(reqRef);
    if (!reqDoc.exists) throw notFound("Request not found");
    const r = reqDoc.data();
    if (r.status !== "open") throw badRequest("This request has already been matched or withdrawn");
    const mineRecipient = (r.recipients || []).find(x => x.holderDcId === user.sub);
    if (!mineRecipient) throw forbidden("This request wasn't routed to you");
    // Having passed on a request rules out confirming it later - otherwise a stale
    // inbox page could still take a trade this chapter had already declined.
    if ((r.declinedBy || []).includes(user.sub)) throw badRequest("You have already passed on this request");

    const myCheckRef = db.collection("checks").doc(mineRecipient.checkId);   // goes to the requester
    const offeredRef = db.collection("checks").doc(offeredCheckId);          // comes to me
    const [myCheck, offered] = await Promise.all([t.get(myCheckRef), t.get(offeredRef)]);
    if (!myCheck.exists || myCheck.data().status !== "available" || myCheck.data().dcId !== user.sub) throw badRequest("Your cheque for this category is no longer available");
    if (!offered.exists || offered.data().status !== "available" || offered.data().dcId !== r.requesterDcId) throw badRequest("That offered cheque is no longer available");

    const at = nowIso();
    t.set(reqRef, { status: "confirmed", confirmedByDcId: user.sub, confirmedByChapter: chapterOf(user), wonCheckId: mineRecipient.checkId, tradedOfferedCheckId: offeredCheckId, matchedAt: at }, { merge: true });
    t.set(myCheckRef, { status: "matched", matchedRequestId: requestId, matchedWithCheckId: offeredCheckId, matchedAt: at }, { merge: true });
    t.set(offeredRef, { status: "matched", matchedRequestId: requestId, matchedWithCheckId: mineRecipient.checkId, matchedAt: at }, { merge: true });
    return { requesterDcId: r.requesterDcId, requesterChapter: r.requesterChapter, receivedProspect: offered.data().prospectName, receivedPhone: offered.data().phone || "", receivedCategory: offered.data().sub, gaveCategory: r.requestedSub };
  });

  // Winner receives the requester's offered check; requester is revealed to the winner.
  return ok({ matched: true, partner: { chapter: result.requesterChapter, name: await memberName(result.requesterDcId) }, receivedProspect: result.receivedProspect, receivedPhone: result.receivedPhone, receivedCategory: result.receivedCategory });
}

// A recipient passing on a request. This is per-recipient: it only leaves THAT
// holder's inbox, so the request stays live for the others and first-come-first-served
// still applies. When every recipient has passed, the request closes itself so the
// requester learns nobody took it instead of waiting indefinitely.
async function declineRequest(user, requestId) {
  assertCanTrade(user);
  const db = getDb();
  const result = await db.runTransaction(async t => {
    const ref = db.collection("barterRequests").doc(requestId);
    const doc = await t.get(ref);
    if (!doc.exists) throw notFound("Request not found");
    const r = doc.data();
    if (r.status !== "open") throw badRequest("This request is no longer open");
    const recipientIds = r.recipientDcIds || [];
    if (!recipientIds.includes(user.sub)) throw forbidden("This request wasn't routed to you");

    const declinedBy = [...new Set([...(r.declinedBy || []), user.sub])];
    const allDeclined = recipientIds.every(id => declinedBy.includes(id));
    const patch = { declinedBy };
    if (allDeclined) { patch.status = "declined"; patch.closedAt = nowIso(); }
    t.set(ref, patch, { merge: true });
    return { allDeclined, remaining: recipientIds.filter(id => !declinedBy.includes(id)).length };
  });
  return ok({ declined: true, closed: result.allDeclined, remaining: result.remaining });
}

async function cancelRequest(user, requestId) {
  assertCanTrade(user);
  const ref = getDb().collection("barterRequests").doc(requestId);
  const doc = await ref.get();
  if (!doc.exists) throw notFound("Request not found");
  if (doc.data().requesterDcId !== user.sub) throw forbidden("That request isn't yours");
  if (doc.data().status !== "open") throw badRequest("Only an open request can be cancelled");
  await ref.set({ status: "withdrawn", withdrawnAt: nowIso() }, { merge: true });
  return noContent();
}

// ---- router ------------------------------------------------------------------

export async function routeBarter({ method, segments, body, user }) {
  const [, second, third, fourth] = segments; // segments[0] === "barter"

  if (second === "categories" && method === "GET") {
    const c = await getCategories();
    return ok({ tree: c.tree, mainCount: c.mainCount, subCount: c.subCount });
  }
  if (second === "board" && method === "GET") return board(user);
  if (second === "mine" && method === "GET") return mine(user);
  if (second === "inbox" && method === "GET") return inbox(user);
  if (second === "trades" && method === "GET") return trades(user);

  if (second === "checks" && !third && method === "POST") return addCheck(user, body);
  if (second === "checks" && third && method === "DELETE") return withdrawCheck(user, third);

  if (second === "requests" && !third && method === "POST") return createRequest(user, body);
  if (second === "requests" && third && fourth === "confirm" && method === "POST") return confirmRequest(user, third, body);
  if (second === "requests" && third && fourth === "decline" && method === "POST") return declineRequest(user, third);
  if (second === "requests" && third && fourth === "cancel" && method === "POST") return cancelRequest(user, third);

  throw notFound("Unknown barter route");
}
