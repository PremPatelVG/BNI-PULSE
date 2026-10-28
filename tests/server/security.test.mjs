import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";
import { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, REFERRER_POLICY } from "../../src/securityHeaders.js";

beforeEach(() => seedRegion());

test("weekly entries: count fields must be numbers; numeric text is stored as a number", async () => {
  const put = body => call(users.saAlpha, "PUT", "weekly-data/Alpha/2026-10-06", body);
  for (const visitors of ["<img src=x onerror=alert(1)>", { $gt: 0 }, [1], true]) {
    const r = await put({ visitors });
    assert.equal(r.status, 400, JSON.stringify(visitors));
    assert.match(r.error, /visitors must be a number/);
  }
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06"), undefined, "nothing was written");
  assert.equal((await put({ visitors: "5", tlr: 72.5, conversionPct: null, references: "", successStory: "<b>ok</b>" })).status, 200);
  const e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.equal(e.visitors, 5);
  assert.equal(e.tlr, 72.5);
  assert.equal(e.conversionPct, null);
  assert.equal(e.references, "");
  assert.equal(e.successStory, "<b>ok</b>", "free text is stored as typed (the page escapes it)");
});

// Region-wide documents shaped like the real imports.
function seedRegionDocs() {
  fake.seed("meta", "monthlyMembers", {
    baselineMonth: "2025-07", baseline: 120, months: ["2025-07"],
    region: [{ month: "2025-07", members: 120 }],
    perChapter: [{ chapter: "Alpha", sizes: {} }, { chapter: "BNI Beta", sizes: {} }, { chapter: "Gamma", sizes: {} }],
    scorecard: { month: "2025-07", rows: [{ chapter: "Alpha" }, { chapter: "Beta" }, { chapter: "Gamma" }] },
    launches: { Gamma: "2025-09", Beta: "2025-10" },
    excludedChapters: ["Delta"]
  });
  fake.seed("meta", "growthSummary", { regionCumNet: 9, regionRetention: 80, months: [], chapters: { Alpha: { cumNet: 1 }, Beta: { cumNet: 2 }, Gamma: { cumNet: 3 } } });
  fake.seed("meta", "preCoreGrowth", { baseline: 100, endTotal: 110, region: [{}], perChapter: [{ chapter: "Alpha" }, { chapter: "Beta" }] });
  fake.seed("meta", "monthlyTargets", { "Alpha_2026-10_members": 40, "Beta_2026-10_members": 30, "Gamma_2026-10": 25 });
  fake.seed("meta", "chapterGoals", { Alpha: { dcGoal: "a" }, Beta: { dcGoal: "b" } });
  fake.seed("attendance", "2026-10-06", { "dc-alpha": true, "dc-alpha_name": "Dev Alpha", "dc-beta": true, "dc-beta_name": "Dina Beta", Alpha: true, Beta: true });
}

test("snapshot: chapter accounts get only their own chapters' region data and no region totals", async () => {
  seedRegionDocs();
  const { meta, collections } = (await call(users.saAlpha, "GET", "snapshot")).body;
  assert.deepEqual(meta.monthlyMembers.perChapter.map(r => r.chapter), ["Alpha"]);
  assert.deepEqual(meta.monthlyMembers.scorecard.rows.map(r => r.chapter), ["Alpha"]);
  assert.deepEqual(meta.monthlyMembers.launches, {});
  assert.equal(meta.monthlyMembers.region, undefined);
  assert.equal(meta.monthlyMembers.baseline, undefined);
  assert.equal(meta.monthlyMembers.baselineMonth, "2025-07", "what their screens use stays");
  assert.deepEqual(Object.keys(meta.growthSummary.chapters), ["Alpha"]);
  assert.equal(meta.growthSummary.regionCumNet, undefined);
  assert.deepEqual(meta.preCoreGrowth.perChapter.map(r => r.chapter), ["Alpha"]);
  assert.equal(meta.preCoreGrowth.endTotal, undefined);
  assert.deepEqual(Object.keys(meta.monthlyTargets).filter(k => k !== "id"), ["Alpha_2026-10_members"]);
  assert.deepEqual(Object.keys(meta.chapterGoals).filter(k => k !== "id"), ["Alpha"]);
  assert.deepEqual(Object.keys(collections.attendance[0]).sort(), ["Alpha", "dc-alpha", "dc-alpha_name", "id"]);
});

test("snapshot: a Senior Director gets their chapters (names matched loosely) and keeps the region totals", async () => {
  seedRegionDocs();
  const { meta } = (await call(users.srdcBeta, "GET", "snapshot")).body;
  assert.deepEqual(meta.monthlyMembers.perChapter.map(r => r.chapter), ["BNI Beta"], '"BNI Beta" is Beta');
  assert.deepEqual(meta.monthlyMembers.launches, { Beta: "2025-10" });
  assert.equal(meta.monthlyMembers.region.length, 1, "their region card still has its totals");
  assert.equal(meta.growthSummary.regionCumNet, 9);
  assert.deepEqual(Object.keys(meta.growthSummary.chapters), ["Beta"]);
});

test("snapshot: Area Director, ED and viewers still see the whole region", async () => {
  seedRegionDocs();
  for (const u of [users.ad, users.ed, users.viewer]) {
    const { meta, collections } = (await call(u, "GET", "snapshot")).body;
    assert.equal(meta.monthlyMembers.perChapter.length, 3, u.id);
    assert.equal(meta.monthlyMembers.region.length, 1, u.id);
    assert.equal(Object.keys(meta.chapterGoals).filter(k => k !== "id").length, 2, u.id);
    assert.equal(Object.keys(collections.attendance[0]).length, 7, u.id);
  }
});

test("direct reads are scoped like the snapshot: meta/:id and attendance", async () => {
  seedRegionDocs();
  const mm = (await call(users.dcBeta, "GET", "meta/monthlyMembers")).body.meta;
  assert.deepEqual(mm.perChapter.map(r => r.chapter), ["BNI Beta"]);
  assert.equal(mm.region, undefined);
  const goals = (await call(users.dcBeta, "GET", "meta/chapterGoals")).body.meta;
  assert.deepEqual(Object.keys(goals).filter(k => k !== "id"), ["Beta"]);
  const att = (await call(users.dcBeta, "GET", "attendance")).body.rows;
  assert.deepEqual(Object.keys(att[0]).sort(), ["Beta", "dc-beta", "dc-beta_name", "id"]);
  // A goal save answers with the writer's chapters only.
  const put = await call(users.dcBeta, "PUT", "meta/chapterGoals", { Beta: { dcGoal: "new" } });
  assert.deepEqual(Object.keys(put.body.meta).filter(k => k !== "id"), ["Beta"]);
  assert.equal(fake.read("meta", "chapterGoals").Alpha.dcGoal, "a", "other chapters are untouched");
});

test("tlr-upload: angle brackets are dropped from the uploaded cells", async () => {
  const rows = [{ name: "Alpha", score: "70", reportMonth: "<img src=x onerror=alert(1)>", chapterSize: "30" }];
  assert.equal((await call(users.ad, "POST", "tlr-upload", { monthIso: "2026-10", rows })).status, 200);
  const stored = fake.read("meta", "tlr").rows.find(r => r.name === "Alpha");
  assert.equal(stored.reportMonth, "img src=x onerror=alert(1)");
  assert.equal(stored.score, "70");
});

test("security headers: netlify.toml sends exactly the policy the Express server sends", () => {
  const toml = fs.readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
  const value = name => (toml.match(new RegExp(`^\\s*${name} = "([^"]*)"`, "m")) || [])[1];
  assert.equal(value("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
  assert.equal(value("Referrer-Policy"), REFERRER_POLICY);
  assert.equal(value("Permissions-Policy"), PERMISSIONS_POLICY);
  assert.equal(value("X-Frame-Options"), "DENY");
  assert.equal(value("X-Content-Type-Options"), "nosniff");
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'(;|$)/);
});
