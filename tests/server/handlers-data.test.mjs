import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";
import { invalidateSnapshotCache } from "../../src/services/firestore.js";

beforeEach(() => seedRegion());

test("weekly data: chapter scope, server-stamped fields, delete", async () => {
  const r = await call(users.saAlpha, "PUT", "weekly-data/Alpha/2026-10-06", { visitors: 4, chapter: "Beta", updatedBy: "someone else", updatedByName: "Someone", updatedByRole: "ed" });
  assert.equal(r.status, 200);
  const e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.equal(e.chapter, "Alpha", "path wins over body");
  assert.equal(e.date, "2026-10-06");
  assert.deepEqual([e.updatedBy, e.updatedByName, e.updatedByRole], ["sa-alpha", "Alpha SA", "sa1"], "who saved it comes from the session");
  assert.ok(e.updatedAt);
  // Any account on the chapter may update it, whatever their role; the stamp follows.
  await call(users.srdc, "PUT", "weekly-data/Alpha/2026-10-06", { eoi: 2 });
  const e2 = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.equal(e2.visitors, 4, "saves merge");
  assert.deepEqual([e2.updatedByName, e2.updatedByRole], ["Sameer Senior", "srdc"]);
  assert.equal((await call(users.saAlpha, "PUT", "weekly-data/Beta/2026-10-09", { visitors: 1 })).status, 403);
  assert.equal((await call(users.viewer, "PUT", "weekly-data/Alpha/2026-10-13", { visitors: 1 })).status, 403);
  assert.equal((await call(users.dcBeta, "DELETE", "weekly-data/Alpha/2026-10-06")).status, 403);
  assert.equal((await call(users.dcAlpha, "DELETE", "weekly-data/Alpha/2026-10-06")).status, 204);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06"), undefined);
  const g = await call(users.saBeta, "GET", "weekly-data");
  assert.ok(g.body.weeklyData.every(w => w.chapter === "Beta"));
});

test("meta GET is scoped exactly like the snapshot", async () => {
  fake.seed("meta", "dues", { members: [{ chapter: "Alpha", name: "A1", phone: "1" }, { chapter: "Beta", name: "B1", phone: "2" }] });
  fake.seed("meta", "lengthOfMembership", { rows: [{ chapter: "Alpha" }, { chapter: "Beta" }] });
  invalidateSnapshotCache();
  assert.deepEqual((await call(users.saAlpha, "GET", "meta/dues")).body.meta.members.map(r => r.chapter), ["Alpha"]);
  assert.equal((await call(users.saAlpha, "GET", "meta/lengthOfMembership")).body.meta.rows.length, 1);
  assert.equal((await call(users.ad, "GET", "meta/dues")).body.meta.members.length, 2);
  assert.equal("srPinHash" in (await call(users.saAlpha, "GET", "meta/config")).body.meta, false);
  assert.equal((await call(users.ad, "GET", "meta/unknownDoc")).status, 404);
});

test("meta PUT: chapter-keyed goals/targets per chapter", async () => {
  assert.equal((await call(users.saAlpha, "PUT", "meta/monthlyTargets", { "Alpha_2026-10": 40, "Alpha_2026-10_members": 40 })).status, 200);
  assert.equal((await call(users.saAlpha, "PUT", "meta/monthlyTargets", { "Beta_2026-10": 1 })).status, 403);
  assert.equal((await call(users.saAlpha, "PUT", "meta/monthlyTargets", { nonsense: 1 })).status, 400);
  assert.equal((await call(users.saAlpha, "PUT", "meta/monthlyTargets", { "BNI_Hera_2026-10": 1 })).status, 403, "underscores in names parsed, still scope-checked");
  assert.equal((await call(users.dcAlpha, "PUT", "meta/chapterGoals", { Alpha: { dcGoal: "grow" } })).status, 200);
  await call(users.ad, "PUT", "meta/chapterGoals", { Alpha: { netAdd: 3 } });
  assert.deepEqual(fake.read("meta", "chapterGoals").Alpha, { dcGoal: "grow", netAdd: 3 }, "one field at a time, merged");
  assert.equal((await call(users.dcAlpha, "PUT", "meta/chapterGoals", { Beta: { dcGoal: "x" } })).status, 403);
  assert.equal((await call(users.viewer, "PUT", "meta/chapterGoals", { Alpha: { dcGoal: "x" } })).status, 403);
});

test("meta PUT: documents shared by every region are ED / BNI Office only; config/branding admins; PIN never settable", async () => {
  for (const doc of ["growthSummary", "preCoreGrowth", "monthlyMembers"]) {
    assert.equal((await call(users.srdc, "PUT", "meta/" + doc, { x: 1 })).status, 403, doc);
    assert.equal((await call(users.dcAlpha, "PUT", "meta/" + doc, { x: 1 })).status, 403, doc);
    // An Area Director runs one region; these documents hold every region's chapters.
    assert.equal((await call(users.ad, "PUT", "meta/" + doc, { x: 1 })).status, 403, doc);
    assert.equal((await call(users.ed, "PUT", "meta/" + doc, { x: 1 })).status, 200, doc);
    assert.equal((await call(users.office, "PUT", "meta/" + doc, { x: 1 })).status, 200, doc);
  }
  // The TLR and its history are kept one record per region and change only through the
  // TLR upload - not even the ED / BNI Office write them whole.
  for (const doc of ["tlr", "tlrHistory"]) {
    for (const u of [users.srdc, users.dcAlpha, users.ad, users.ed, users.office]) {
      assert.equal((await call(u, "PUT", "meta/" + doc, { rows: [] })).status, 403, doc + " " + u.id);
    }
  }
  assert.equal((await call(users.dcAlpha, "PUT", "meta/config", { srCallDay: "Monday" })).status, 403);
  assert.equal((await call(users.srdc, "PUT", "meta/branding", { argLogo: "y" })).status, 200);
  const hash = fake.read("meta", "config").srPinHash;
  await call(users.srdc, "PUT", "meta/config", { srCallDay: "Monday", srPinHash: "x", srPin: "1" });
  assert.equal(fake.read("meta", "config").srPinHash, hash);
  assert.equal(fake.read("meta", "config").srPin, undefined);
  assert.equal(fake.read("meta", "config").srCallDay, "Monday");
});

test("meta PUT: dues / LOM uploads merge by chapter and return only the writer's chapters", async () => {
  fake.seed("meta", "lengthOfMembership", { rows: [{ chapter: "Alpha", name: "old" }, { chapter: "Beta", name: "keep" }] });
  invalidateSnapshotCache();
  const r = await call(users.srdc, "PUT", "meta/lengthOfMembership", { rows: [{ chapter: "Alpha", name: "new" }], uploadedAt: "2026-10-23" });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.read("meta", "lengthOfMembership").rows.map(x => x.name).sort(), ["keep", "new"]);
  assert.ok(r.body.meta.rows.every(x => x.chapter !== "Beta"));
  const bad = await call(users.srdc, "PUT", "meta/dues", { members: [{ chapter: "Beta", name: "x" }] });
  assert.equal(bad.status, 400, "rows outside the writer's chapters are refused");
});

test("activity: allow-listed browser actions only, trimmed details, server duplicates ignored", async () => {
  assert.equal((await call(users.saAlpha, "POST", "activity", { action: "evil", details: {} })).status, 400);
  assert.equal((await call(users.saAlpha, "POST", "activity", { action: "member_deleted", details: { memberName: "fake" } })).status, 204);
  assert.equal(fake.all("activityLog").length, 0);
  await call(users.saAlpha, "POST", "activity", { action: "renewal_marked_done", details: { name: "x".repeat(300), nested: { a: 1 }, n: 5, "bad key": 1 } });
  const e = fake.all("activityLog")[0];
  assert.equal(e.source, "browser");
  assert.equal(e.details.name.length, 200);
  assert.equal(e.details.n, 5);
  assert.equal("nested" in e.details || "bad key" in e.details, false);
  assert.equal((await call(users.viewer, "POST", "activity", { action: "quick_update" })).status, 403);
});

test("collections: reads scoped, writes checked against the new AND existing chapter", async () => {
  fake.seed("renewalsDone", "Beta_x", { chapter: "Beta", name: "x" });
  fake.seed("visitorPipeline", "Alpha_v", { chapter: "Alpha", name: "v" });
  assert.deepEqual((await call(users.saAlpha, "GET", "renewalsDone")).body.rows, []);
  assert.equal((await call(users.saAlpha, "GET", "visitorPipeline")).body.rows.length, 1);
  assert.equal((await call(users.saAlpha, "PUT", "renewalsDone/Beta_x", { note: "hijack" })).status, 403, "existing row in another chapter");
  assert.equal((await call(users.saAlpha, "PUT", "renewalsDone/new", { chapter: "Beta" })).status, 403);
  assert.equal((await call(users.saAlpha, "PUT", "renewalsDone/Alpha_y", { chapter: "Alpha", name: "y" })).status, 200);
  assert.equal((await call(users.saAlpha, "DELETE", "renewalsDone/Alpha_y")).status, 404, "renewalsDone is not deletable");
  assert.equal((await call(users.saAlpha, "PUT", "renewalsDropped/Alpha_z", { chapter: "Alpha" })).status, 200);
  assert.equal((await call(users.saAlpha, "DELETE", "renewalsDropped/Alpha_z")).status, 204);
  assert.equal((await call(users.saAlpha, "PUT", "members/x", {})).status, 404, "members are not a generic collection");
  assert.equal((await call(users.saAlpha, "PUT", "activityLog/x", {})).status, 404);
  assert.equal((await call(users.viewer, "PUT", "visitorPipeline/Alpha_v", { stage: "x" })).status, 403);
});

test("collections: a 'new member' Miyagi record can never wipe existing progress", async () => {
  fake.seed("miyagiMembers", "alpha_ravi", { chapter: "Alpha", name: "Ravi", checkpoints: { msp: { done: true } }, score: 5 });
  const r = await call(users.saAlpha, "PUT", "miyagiMembers/alpha_ravi", { chapter: "Alpha", name: "Ravi", checkpoints: {}, score: 0, joinDate: "2026-05-01" });
  assert.equal(r.status, 200);
  const m = fake.read("miyagiMembers", "alpha_ravi");
  assert.equal(m.score, 5);
  assert.equal(m.checkpoints.msp.done, true);
  assert.equal(m.joinDate, "2026-05-01", "missing fields are filled in");
  await call(users.saAlpha, "PUT", "miyagiMembers/alpha_ravi", { checkpoints: { mentorship: { done: true } } });
  assert.deepEqual(Object.keys(fake.read("miyagiMembers", "alpha_ravi").checkpoints).sort(), ["mentorship", "msp"], "ticks merge");
  assert.equal(r.body.row.id, "alpha_ravi");
});

test("miyagi-new-members: adds in one request, never touches a member already there", async () => {
  fake.seed("miyagiMembers", "alpha_ravi", { chapter: "Alpha", name: "Ravi", checkpoints: { msp: { done: true } }, score: 5, status: "dropped" });
  const r = await call(users.saAlpha, "PUT", "miyagi-new-members", { members: [
    { id: "alpha_ravi", name: "Ravi", chapter: "Alpha", joinDate: "2026-09-01" },
    { id: "alpha_neha_rao", name: "  Neha   Rao ", chapter: "Alpha", joinDate: "2026-08-01", createdAt: "2026-11-16", firstName: "Neha", lastName: "Rao",
      cumulativeStart: "2026-08-01", cumulativeLength: "0 years (3 months)",
      // None of these may come from the request: a new member starts from zero.
      score: 90, status: "graduated", checkpoints: { msp: { done: true } }, checkins: { "3month": {} }, finalBelt: "Black" }
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { added: ["alpha_neha_rao"], existing: ["alpha_ravi"] });
  assert.deepEqual(fake.read("miyagiMembers", "alpha_ravi"), { chapter: "Alpha", name: "Ravi", checkpoints: { msp: { done: true } }, score: 5, status: "dropped" }, "existing record left exactly as it was");
  assert.deepEqual(fake.read("miyagiMembers", "alpha_neha_rao"), {
    name: "Neha Rao", chapter: "Alpha", joinDate: "2026-08-01", status: "active", score: 0, checkpoints: {}, checkins: {},
    lastActivityDate: "2026-11-16", createdAt: "2026-11-16", firstName: "Neha", lastName: "Rao", cumulativeStart: "2026-08-01", cumulativeLength: "0 years (3 months)"
  });
  const logged = fake.all("activityLog").filter(a => a.action === "miyagi_members_added");
  assert.deepEqual(logged.map(a => [a.details.memberCount, a.details.chapters, a.userName]), [[1, "Alpha 1", "Alpha SA"]]);
  // Sending the same list again adds nobody and logs nothing.
  const again = await call(users.saAlpha, "PUT", "miyagi-new-members", { members: [{ id: "alpha_neha_rao", name: "Neha Rao", chapter: "Alpha" }] });
  assert.deepEqual(again.body, { added: [], existing: ["alpha_neha_rao"] });
  assert.equal(fake.all("activityLog").filter(a => a.action === "miyagi_members_added").length, 1);
});

test("miyagi-new-members: own chapters only, and a bad list adds nobody", async () => {
  const m = (id, chapter) => ({ id, name: "N " + id, chapter });
  const count = () => fake.all("miyagiMembers").length;
  assert.equal((await call(users.viewer, "PUT", "miyagi-new-members", { members: [m("alpha_a", "Alpha")] })).status, 403);
  assert.equal((await call(null, "PUT", "miyagi-new-members", { members: [m("alpha_a", "Alpha")] })).status, 401);
  // One row outside the uploader's chapters refuses the whole request.
  assert.equal((await call(users.saAlpha, "PUT", "miyagi-new-members", { members: [m("alpha_a", "Alpha"), m("beta_b", "Beta")] })).status, 403);
  assert.equal((await call(users.srdc, "PUT", "miyagi-new-members", { members: [m("beta_b", "Beta")] })).status, 403);
  for (const members of [undefined, [], "x", [{ id: "alpha_a", chapter: "Alpha" }], [{ id: "Alpha/../x", name: "A", chapter: "Alpha" }], [m("alpha_a", "Alpha"), m("alpha_a", "Alpha")],
    Array.from({ length: 201 }, (_, i) => m("alpha_m" + i, "Alpha"))]) {
    assert.equal((await call(users.ad, "PUT", "miyagi-new-members", { members })).status, 400);
  }
  assert.equal(count(), 0, "nothing was written by any refused request");
  const ok = await call(users.srdc, "PUT", "miyagi-new-members", { members: Array.from({ length: 200 }, (_, i) => m("gamma_m" + i, "Gamma")) });
  assert.equal(ok.body.added.length, 200);
  assert.equal(count(), 200);
  // The Miyagi list is cached on the server; the new members must show up straight away.
  assert.equal((await call(users.srdc, "GET", "miyagiMembers")).body.rows.length, 200);
});

test("tlr-upload: leadership only, validated, Sr.DC scoped", async () => {
  const rows = [{ name: "Alpha", score: "80" }, { name: "Beta", score: "60" }];
  assert.equal((await call(users.dcAlpha, "POST", "tlr-upload", { monthIso: "2026-10", rows })).status, 403);
  assert.equal((await call(users.ad, "POST", "tlr-upload", { monthIso: "Oct", rows })).status, 400);
  assert.equal((await call(users.ad, "POST", "tlr-upload", { monthIso: "2026-10", rows: [] })).status, 400);
  const s = await call(users.srdc, "POST", "tlr-upload", { monthIso: "2026-10", monthLabel: "October 2026", rows });
  assert.equal(s.body.chaptersUpdated, 1);
  const a = await call(users.ad, "POST", "tlr-upload", { monthIso: "2026-10", monthLabel: "October 2026", rows });
  assert.equal(a.body.chaptersUpdated, 2);
  assert.ok(fake.all("activityLog").some(e => e.action === "tlr_report_uploaded"));
});

test("snapshot and bootstrap", async () => {
  const s = await call(users.saBeta, "GET", "snapshot");
  assert.deepEqual(s.body.collections.chapters.map(c => c.name), ["Beta"]);
  const b = await call(users.saBeta, "GET", "bootstrap");
  assert.deepEqual(b.body.chapters.map(c => c.name), ["Beta"]);
  assert.ok(b.body.meta);
});
