import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call, PIN } from "../helpers/region.mjs";
import { invalidateSnapshotCache } from "../../src/services/firestore.js";

const dcGamma = { id: "dc-gamma", role: "dc", chapter: "Gamma", chapters: ["Gamma"] };
const dcDelta = { id: "dc-delta", role: "dc", chapter: "Delta", chapters: ["Delta"] };

beforeEach(async () => {
  await seedRegion();
  const pinHash = bcrypt.hashSync(PIN, 4);
  fake.seed("members", "dc-gamma", { name: "Gita Gamma", role: "dc", chapter: "Gamma", chapters: ["Gamma"], phone: "9000000003", pinHash });
  fake.seed("members", "dc-delta", { name: "Dhruv Delta", role: "dc", chapter: "Delta", chapters: ["Delta"], phone: "9000000004", pinHash });
  fake.seed("chapters", "Delta", { name: "Delta", day: "Monday", order: 4 });
  fake.seed("meta", "barterCategories", { tree: [{ main: "Health", subs: ["Dentist", "Physio"] }, { main: "Finance", subs: ["CA", "Insurance"] }], mainCount: 2, subCount: 4 });
  invalidateSnapshotCache();
});

const cheque = (u, sub, extra = {}) => call(u, "POST", "barter/checks", { sub, prospectName: "Prospect " + sub + " of " + u.id, phone: "98" + Math.floor(Math.random() * 1e8), companyName: "Co " + u.id, paymentType: "UPI", ...extra });

test("categories are served from meta/barterCategories", async () => {
  const r = await call(users.dcAlpha, "GET", "barter/categories");
  assert.equal(r.body.subCount, 4);
  assert.deepEqual(r.body.tree.map(t => t.main), ["Health", "Finance"]);
});

test("adding a cheque: who may, and what is required", async () => {
  const ok = await cheque(users.dcAlpha, "Dentist");
  assert.equal(ok.status, 201);
  assert.equal(ok.body.check.main, "Health");
  assert.equal(ok.body.check.chapter, "Alpha");
  assert.equal(ok.body.check.status, "available");
  assert.ok(ok.body.check.expiresAt > new Date(Date.now() + 29 * 86400000).toISOString(), "expires after 30 days");
  assert.equal((await cheque(users.saAlpha, "CA")).status, 201, "SAs trade too");
  assert.equal((await cheque(users.dcAlpha, "Astronaut")).status, 400, "unknown sub-category");
  assert.equal((await call(users.dcAlpha, "POST", "barter/checks", { sub: "CA", phone: "1" })).status, 400, "prospect name required");
  assert.equal((await call(users.dcAlpha, "POST", "barter/checks", { sub: "CA", prospectName: "x" })).status, 400, "phone required");
  for (const u of [users.ad, users.ed, users.viewer, users.office]) assert.equal((await cheque(u, "CA")).status, 403, u.id);
  assert.equal((await cheque(users.srdc, "CA")).status, 400, "a Sr.DC must name one of their chapters");
  assert.equal((await cheque(users.srdc, "CA", { chapter: "Beta" })).status, 400);
  assert.equal((await cheque(users.srdc, "CA", { chapter: "Gamma" })).body.check.chapter, "Gamma");
});

test("the board is anonymous for traders; holders are visible to leadership only", async () => {
  await cheque(users.dcAlpha, "Dentist");
  await cheque(users.dcBeta, "Dentist");
  await cheque(dcGamma, "Physio");
  const dc = await call(dcDelta, "GET", "barter/board");
  assert.deepEqual(dc.body.counts, { Dentist: 2, Physio: 1 });
  assert.equal(dc.body.mainTotals.Health, 3);
  assert.equal(dc.body.holders, undefined, "a DC sees counts only");
  assert.doesNotMatch(JSON.stringify(dc.body), /Prospect|98\d{6}|Co dc/, "no prospect, phone or company on the board");
  const ad = await call(users.ad, "GET", "barter/board");
  assert.deepEqual(ad.body.holders.Dentist.map(h => h.name).sort(), ["Dev Alpha", "Dina Beta"]);
  const sr = await call(users.srdc, "GET", "barter/board");
  assert.equal(sr.body.scoped, "chapters");
  assert.deepEqual(Object.keys(sr.body.counts).sort(), ["Dentist", "Physio"], "Alpha + Gamma only");
  assert.equal(sr.body.counts.Dentist, 1);
  const srAsDc = await call(users.srdc, "GET", "barter/board", undefined, { query: { actingChapter: "Gamma" } });
  assert.equal(srAsDc.body.holders, undefined, "a Sr.DC in DC View sees the anonymous board");
  assert.equal(srAsDc.body.counts.Dentist, 2);
});

test("requests: strict barter, routed to up to 3 other-chapter holders, oldest first", async () => {
  assert.equal((await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).status, 400, "must hold a cheque to offer");
  await cheque(users.dcAlpha, "CA");
  assert.equal((await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).status, 400, "nobody else holds Dentist");
  await cheque(users.saAlpha, "Dentist");                        // same chapter - never a recipient
  for (const u of [users.dcBeta, dcGamma, dcDelta, users.saBeta]) await cheque(u, "Dentist");
  const r = await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.recipientCount, 3);
  const req = fake.all("barterRequests")[0];
  assert.deepEqual(req.recipients.map(x => x.holderDcId), ["dc-beta", "dc-gamma", "dc-delta"], "oldest three, other chapters only");
  assert.equal((await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).status, 400, "one open request per category");
});

test("inbox shows the request with the requester's cheques - categories only, no identities", async () => {
  await cheque(users.dcAlpha, "CA");
  await cheque(users.dcAlpha, "Insurance");
  await cheque(users.dcBeta, "Dentist");
  await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" });
  const inbox = await call(users.dcBeta, "GET", "barter/inbox");
  assert.equal(inbox.body.inbox.length, 1);
  const item = inbox.body.inbox[0];
  assert.deepEqual(item.offered.map(o => o.sub).sort(), ["CA", "Insurance"]);
  assert.doesNotMatch(JSON.stringify(item), /Prospect|Dev Alpha|Alpha"|98\d{6}/, "no prospect, requester name, chapter or phone");
  assert.equal((await call(dcGamma, "GET", "barter/inbox")).body.inbox.length, 0);
  assert.equal((await call(users.viewer, "GET", "barter/inbox")).status, 403);
});

test("confirm: swaps both cheques and reveals each partner's contact only then", async () => {
  const mine = (await cheque(users.dcAlpha, "CA")).body.check;
  await cheque(users.dcBeta, "Dentist");
  const req = (await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).body.request;
  assert.equal((await call(dcGamma, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: mine.id })).status, 403, "not routed to Gamma");
  assert.equal((await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, {})).status, 400, "must pick a cheque");
  assert.equal((await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: "nope" })).status, 400);
  const c = await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: mine.id });
  assert.equal(c.status, 200);
  assert.equal(c.body.partner.name, "Dev Alpha");
  assert.equal(c.body.partner.phone, "9000000001");
  assert.equal(c.body.partner.chapter, "Alpha");
  assert.equal(c.body.receivedCategory, "CA");
  assert.match(c.body.receivedProspect, /Prospect CA/);
  assert.ok(fake.all("checks").every(x => x.status === "matched"));
  assert.equal(fake.read("barterRequests", req.id).status, "confirmed");
  assert.equal((await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: mine.id })).status, 400, "already matched");
  const m = await call(users.dcAlpha, "GET", "barter/mine");
  const match = m.body.requests[0].match;
  assert.equal(match.partnerName, "Dina Beta");
  assert.equal(match.partnerPhone, "9000000002");
  assert.match(match.receivedProspect, /Prospect Dentist/);
  assert.equal(m.body.checks[0].tradedFor.category, "Dentist");
  const board = await call(dcDelta, "GET", "barter/board");
  assert.equal(board.body.totalAvailable, 0, "matched cheques leave the board");
});

test("decline is per recipient; the request closes when everyone has passed", async () => {
  await cheque(users.dcAlpha, "CA");
  await cheque(users.dcBeta, "Dentist");
  await cheque(dcGamma, "Dentist");
  const req = (await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).body.request;
  const d1 = await call(users.dcBeta, "POST", `barter/requests/${req.id}/decline`, {});
  assert.deepEqual([d1.body.closed, d1.body.remaining], [false, 1]);
  assert.equal((await call(users.dcBeta, "GET", "barter/inbox")).body.inbox.length, 0, "leaves the decliner's inbox");
  assert.equal((await call(dcGamma, "GET", "barter/inbox")).body.inbox.length, 1, "still live for the other");
  const mineCheck = fake.all("checks").find(x => x.dcId === "dc-alpha");
  assert.equal((await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: mineCheck.id })).status, 400, "cannot confirm after passing");
  assert.equal((await call(dcDelta, "POST", `barter/requests/${req.id}/decline`, {})).status, 403);
  const d2 = await call(dcGamma, "POST", `barter/requests/${req.id}/decline`, {});
  assert.equal(d2.body.closed, true);
  assert.equal(fake.read("barterRequests", req.id).status, "declined");
});

test("cancel and withdraw: owner only, open/available only", async () => {
  const ch = (await cheque(users.dcAlpha, "CA")).body.check;
  await cheque(users.dcBeta, "Dentist");
  const req = (await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).body.request;
  assert.equal((await call(users.dcBeta, "POST", `barter/requests/${req.id}/cancel`, {})).status, 403);
  assert.equal((await call(users.dcAlpha, "POST", `barter/requests/${req.id}/cancel`, {})).status, 204);
  assert.equal((await call(users.dcAlpha, "POST", `barter/requests/${req.id}/cancel`, {})).status, 400);
  assert.equal((await call(users.dcAlpha, "POST", "barter/requests/nope/cancel", {})).status, 404);
  assert.equal((await call(users.dcBeta, "DELETE", `barter/checks/${ch.id}`)).status, 403);
  assert.equal((await call(users.dcAlpha, "DELETE", `barter/checks/${ch.id}`)).status, 204);
  assert.equal((await call(users.dcAlpha, "DELETE", `barter/checks/${ch.id}`)).status, 400);
  assert.equal((await call(users.dcAlpha, "DELETE", "barter/checks/nope")).status, 404);
  assert.equal((await call(users.dcAlpha, "GET", "barter/nonsense")).status, 404);
});

test("expired cheques are not on the board and cannot be requested", async () => {
  await cheque(users.dcAlpha, "CA");
  const old = (await cheque(users.dcBeta, "Dentist")).body.check;
  fake.seed("checks", old.id, { ...fake.read("checks", old.id), expiresAt: "2020-01-01T00:00:00.000Z" });
  await cheque(dcGamma, "Physio");                                  // write drops the board cache
  assert.equal((await call(dcDelta, "GET", "barter/board")).body.counts.Dentist, undefined);
  assert.equal((await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).status, 400);
});

test("trade history: own for DC/SA, own chapters for Sr.DC, everything for AD; viewers none", async () => {
  const a = (await cheque(users.dcAlpha, "CA")).body.check;
  await cheque(users.dcBeta, "Dentist");
  const req = (await call(users.dcAlpha, "POST", "barter/requests", { sub: "Dentist" })).body.request;
  await call(users.dcBeta, "POST", `barter/requests/${req.id}/confirm`, { offeredCheckId: a.id });
  assert.equal((await call(users.dcAlpha, "GET", "barter/trades")).body.trades.length, 1);
  assert.equal((await call(dcGamma, "GET", "barter/trades")).body.trades.length, 0);
  const t = (await call(users.ad, "GET", "barter/trades")).body;
  assert.equal(t.scope, "all");
  assert.equal(t.trades[0].aName, "Dev Alpha");
  assert.equal(t.trades[0].bName, "Dina Beta");
  assert.equal(t.trades[0].aOfferedCategory, "CA");
  assert.equal(t.trades[0].bOfferedCategory, "Dentist");
  assert.equal((await call(users.srdc, "GET", "barter/trades")).body.trades.length, 1, "Alpha was part of it");
  assert.equal((await call(users.viewer, "GET", "barter/trades")).status, 403);
});
