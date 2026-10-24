import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import * as fs from "../../src/services/firestore.js";

beforeEach(() => seedRegion());

test("credentials never leave the server: members, login directory, meta/config", async () => {
  const member = { name: "A", role: "dc", chapter: "X", chapters: ["X"], pin: "1", pinHash: "h", phone: "9", reportsTo: "S", pinChangedAt: "2026-01-01" };
  assert.deepEqual(Object.keys(fs.stripPrivateMember(member)).sort(), ["chapter", "chapters", "name", "pinChangedAt", "reportsTo", "role"]);
  assert.deepEqual(Object.keys(fs.loginDirectoryMember(member)).sort(), ["chapter", "chapters", "name", "reportsTo", "role"]);
  const cfg = await fs.getMetaDoc("config");
  assert.equal("srPinHash" in cfg, false);
  assert.equal("srPin" in fs.stripPrivateMeta("config", { srPin: "1", srCallDay: "Friday" }), false);
  const snap = await fs.buildSnapshot(users.saAlpha);
  assert.equal("srPinHash" in snap.meta.config, false);
  assert.ok(snap.collections.members.every(m => !("pinHash" in m) && !("phone" in m)));
});

test("getMetaDoc / setMetaDoc refuse documents outside the known list", async () => {
  await assert.rejects(fs.getMetaDoc("secrets"), e => e.status === 404);
  await assert.rejects(fs.setMetaDoc("secrets", { a: 1 }), e => e.status === 404);
  const saved = await fs.setMetaDoc("monthlyTargets", { "Alpha_2026-10": 40 });
  assert.equal(saved["Alpha_2026-10"], 40);
});

test("snapshot is scoped per user", async () => {
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06" });
  fake.seed("weeklyData", "Beta_2026-10-09", { chapter: "Beta", date: "2026-10-09" });
  fake.seed("attendance", "2026-W41", { m1: true });
  fake.seed("meta", "dues", { members: [{ chapter: "Alpha", name: "A1", phone: "1" }, { chapter: "Beta", name: "B1", phone: "2" }] });
  fake.seed("meta", "tlr", { rows: [{ name: "Alpha", score: 80 }, { name: "Beta", score: 60 }] });
  fake.seed("meta", "lengthOfMembership", { rows: [{ chapter: "Alpha", name: "A1" }, { chapter: "Beta", name: "B1" }] });
  fs.invalidateSnapshotCache();
  const sa = await fs.buildSnapshot(users.saAlpha);
  assert.deepEqual(sa.collections.chapters.map(c => c.name), ["Alpha"]);
  assert.deepEqual(sa.collections.weeklyData.map(w => w.chapter), ["Alpha"]);
  assert.equal(sa.collections.attendance.length, 1, "attendance carries no chapter and is not scoped");
  assert.deepEqual(sa.meta.dues.members.map(r => r.chapter), ["Alpha"]);
  assert.deepEqual(sa.meta.tlr.rows.map(r => r.name), ["Alpha"]);
  assert.equal(sa.meta.tlr.rows[0].chapter, undefined, "synthetic chapter key removed from TLR rows");
  assert.deepEqual(sa.meta.lengthOfMembership.rows.map(r => r.chapter), ["Alpha"]);
  const srdc = await fs.buildSnapshot(users.srdc);
  assert.deepEqual(srdc.collections.chapters.map(c => c.name).sort(), ["Alpha", "Gamma"]);
  const ad = await fs.buildSnapshot(users.ad);
  assert.equal(ad.collections.chapters.length, 3);
  assert.equal(ad.meta.dues.members.length, 2);
});

test("a repeat snapshot costs one read (the shared stamps document), not the dataset", async () => {
  await fs.buildSnapshot(users.ad);
  fake.resetStats();
  await fs.buildSnapshot(users.ad);
  assert.deepEqual(Object.keys(fake.stats.byCollection), ["_system"]);
  assert.equal(fake.stats.reads, 1);
});

test("a write on one server instance is seen by another instance on its next request", async () => {
  const A = await import("../../src/services/firestore.js?instance=A");
  const B = await import("../../src/services/firestore.js?instance=B");
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06", visitors: 1 });
  await A.buildSnapshot(users.ad);
  await B.buildSnapshot(users.ad);
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06", visitors: 9 });
  A.invalidateSnapshotCache("weeklyData");
  await A.writeActivity(users.saAlpha, "weekly_entry_saved", {});
  fake.resetStats();
  const b = await B.buildSnapshot(users.ad);
  assert.equal(b.collections.weeklyData[0].visitors, 9);
  assert.equal(fake.stats.byCollection.weeklyData.reads, 1, "only the changed collection is re-read");
  assert.equal(fake.stats.byCollection.members, undefined);
});

test("the activity log stays instance-local; a stamps outage never fails a save", async () => {
  fs.invalidateSnapshotCache("weeklyData");
  await fs.writeActivity(users.ad, "x", {});
  assert.equal("activityLog" in (fake.read("_system", "cacheStamps") || {}), false);
  fake.failWhen((op, path) => path.startsWith("_system/"));
  fs.invalidateSnapshotCache("weeklyData");
  await assert.doesNotReject(fs.writeActivity(users.ad, "y", {}));
});

test("writeActivity records the person's name, id, role and source", async () => {
  await fs.writeActivity(users.saAlpha, "a1", { x: 1 });
  await fs.writeActivity(users.office, "a2", {});
  await fs.writeActivity({ sub: "gone-account", role: "dc" }, "a3", {}, { source: "browser" });
  await fs.writeActivity(null, "a4", {});
  const log = Object.fromEntries(fake.all("activityLog").map(e => [e.action, e]));
  assert.equal(log.a1.userName, "Alpha SA");
  assert.equal(log.a1.userId, "sa-alpha");
  assert.equal(log.a1.userRole, "sa1");
  assert.equal(log.a1.source, "server");
  assert.equal(log.a1.team, "bni_chapter_pulse");
  assert.equal(log.a2.userName, "BNI Office Account");
  assert.equal(log.a3.userName, "gone-account");
  assert.equal(log.a3.source, "browser");
  assert.equal(log.a4.userName, "system");
});

test("applyTlrForMonth merges by chapter, refreshes that month's entries, and scopes a Senior DC", async () => {
  fake.seed("meta", "tlr", { rows: [{ name: "Beta", score: 50 }] });
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06", tlr: 0 });
  fake.seed("weeklyData", "Alpha_2026-09-29", { chapter: "Alpha", date: "2026-09-29", tlr: 0 });
  const r = await fs.applyTlrForMonth(users.ad, { monthIso: "2026-10", monthLabel: "October 2026", rows: [{ name: "BNI Alpha", score: "80", conversion: "25.5%" }, { name: "Alpha", score: "70" }] });
  assert.equal(r.chaptersUpdated, 1, "duplicate rows for one chapter collapse to one");
  const tlr = fake.read("meta", "tlr");
  assert.deepEqual(tlr.rows.map(x => x.name).sort(), ["BNI Alpha", "Beta"], "Beta kept: merge by chapter");
  assert.equal(tlr.uploadedBy, "Arun Area", "uploader's name, not 'system'");
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").tlr, 80);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").conversionPct, 26);
  assert.equal(fake.read("weeklyData", "Alpha_2026-09-29").tlr, 0, "other months untouched");

  const s = await fs.applyTlrForMonth(users.srdc, { monthIso: "2026-10", monthLabel: "October 2026", rows: [{ name: "Gamma", score: "90" }, { name: "Beta", score: "1" }] });
  assert.equal(s.chaptersUpdated, 1, "a Senior DC only updates their own chapters");
  assert.equal(fake.read("meta", "tlr").rows.find(x => x.name === "Beta").score, 50);
});

test("currentMember / currentConfig read through the shared cache", async () => {
  assert.equal((await fs.currentMember("dc-alpha")).name, "Dev Alpha");
  assert.equal(await fs.currentMember("nobody"), null);
  assert.equal((await fs.currentConfig()).srCallDay, "Friday");
});

test("listCollection applies orderBy and limit", async () => {
  ["c", "a", "b"].forEach((k, i) => fake.seed("activityLog", k, { timestamp: "2026-10-0" + (i + 1) }));
  const rows = await fs.listCollection("activityLog", { field: "timestamp", direction: "desc" }, 2);
  assert.deepEqual(rows.map(r => r.id), ["b", "a"]);
});
