// Renewals, Length of Membership, the TLR and its history hold rows for every chapter.
// They are kept one record per region: Ahmedabad's in the original documents (meta/dues
// ...), North Gujarat's in its own (meta/dues-north-gujarat ...). Whoever uploads - the
// North Gujarat Area Director, Senior Director or a DC, or the ED / BNI Office - a North
// Gujarat upload never writes Ahmedabad's records. Made-up chapters, people and figures:
// Alpha / Beta / Gamma (Ahmedabad) and Kappa / Lambda (North Gujarat).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call, PIN } from "../helpers/region.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
const adNorth = { id: "ad-ng", role: "ad", chapter: null, chapters: [] };
const srdcNorth = { id: "srdc-ng", role: "srdc", chapter: "Kappa", chapters: ["Kappa", "Lambda"] };
const dcKappa = { id: "dc-kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"] };
const adAhmedabad = { id: "ad-1", role: "ad", chapter: null, chapters: [] };

// Ahmedabad's records as they are before North Gujarat goes live (headers included).
const AHMEDABAD = {
  dues: { uploadedAt: "2026-11-10", uploadedBy: "Arun Area", lastUploadChapters: ["Alpha", "Beta"],
    members: [{ chapter: "Alpha", name: "Asha A", dueDate: "2026-12-01" }, { chapter: "Beta", name: "Bina B", dueDate: "2026-12-09" }] },
  lengthOfMembership: { uploadedAt: "2026-11-16", uploadedBy: "Arun Area",
    rows: [{ chapter: "Alpha", name: "Asha A", recentLength: "3 Months" }, { chapter: "Gamma", name: "Gita G", recentLength: "2 Years" }] },
  tlr: { reportMonth: "2026-10", monthLabel: "October 2026", uploadedAt: "2026-11-05", uploadedBy: "Arun Area",
    rows: [{ name: "Alpha", score: "80", chapterSize: "30" }, { name: "Beta", score: "60", chapterSize: "20" }] }
};
const ahmedabadRecords = () => ({ dues: fake.read("meta", "dues"), lengthOfMembership: fake.read("meta", "lengthOfMembership"),
  tlr: fake.read("meta", "tlr"), tlrHistory: fake.read("meta", "tlrHistory") });

beforeEach(async () => {
  await seedRegion();
  const pinHash = bcrypt.hashSync(PIN, 4);
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("chapters", "Lambda", { name: "Lambda", day: "Thursday", order: 11, area: NG });
  // An Ahmedabad chapter whose name contains a North Gujarat chapter's.
  fake.seed("chapters", "Kappa Club", { name: "Kappa Club", day: "Friday", order: 12 });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash });
  fake.seed("members", "srdc-ng", { name: "Kiran North", role: "srdc", chapter: "Kappa", chapters: ["Kappa", "Lambda"], pinHash });
  fake.seed("members", "dc-kappa", { name: "Kavi Kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"], pinHash });
  for (const [doc, data] of Object.entries(AHMEDABAD)) fake.seed("meta", doc, structuredClone(data));
  invalidateSnapshotCache();
  await publishCacheStamps();
});

const renewal = (chapter, name) => ({ chapter, name, dueDate: "2026-12-20" });
const lom = (chapter, name) => ({ chapter, name, firstName: name, lastName: "N", recentLength: "1 Month" });

test("North Gujarat's uploads - by its Area Director, Senior Director, a DC, the ED and the BNI Office - never write Ahmedabad's records", async () => {
  const before = structuredClone(ahmedabadRecords());
  // Renewals and Length of Membership, from every account that can upload them.
  for (const [user, who] of [[adNorth, "AD"], [srdcNorth, "SrDC"], [dcKappa, "DC"], [users.ed, "ED"], [users.office, "Office"]]) {
    const chapter = user === dcKappa ? "Kappa" : "Lambda";
    assert.equal((await call(user, "PUT", "meta/dues", { members: [renewal(chapter, "R " + who)], uploadedAt: "2026-11-24", uploadedBy: who, lastUploadChapters: [chapter] })).status, 200, "dues " + who);
    assert.equal((await call(user, "PUT", "meta/lengthOfMembership", { rows: [lom(chapter, "L " + who)], uploadedAt: "2026-11-24", uploadedBy: who })).status, 200, "LOM " + who);
  }
  // The TLR, from the Area Director, the Senior Director, the ED and the BNI Office.
  const tlrRow = (name, score) => ({ name, score: String(score), chapterSize: "20", retention: "70" });
  for (const user of [adNorth, srdcNorth, users.ed, users.office]) {
    const r = await call(user, "POST", "tlr-upload", { monthIso: "2026-11", monthLabel: "November 2026", rows: [tlrRow("Kappa", 61), tlrRow("Lambda", 52)], area: NG });
    assert.equal(r.status, 200, "TLR " + user.id);
  }
  assert.equal((await call(adNorth, "POST", "tlr-upload", { monthIso: "2026-12", monthLabel: "December 2026", rows: [tlrRow("Kappa", 63)] })).status, 200);

  assert.deepEqual(ahmedabadRecords(), before, "every Ahmedabad record exactly as it was - rows, headers, and no TLR history created");
  // North Gujarat's own records hold its rows.
  assert.deepEqual(fake.read("meta", "dues-north-gujarat").members.map(m => m.name).sort(), ["R DC", "R Office"],
    "the last upload of each chapter wins: Kappa (the DC's), Lambda (the BNI Office's)");
  assert.deepEqual(fake.read("meta", "lengthOfMembership-north-gujarat").rows.map(m => m.name).sort(), ["L DC", "L Office"]);
  assert.equal(fake.read("meta", "lengthOfMembership-north-gujarat").uploadedBy, "Office");
  assert.deepEqual(fake.read("meta", "tlr-north-gujarat").rows.map(r => [r.name, r.monthIso]).sort(), [["Kappa", "2026-12"], ["Lambda", "2026-11"]]);
  assert.deepEqual(fake.read("meta", "tlrHistory-north-gujarat").months, ["2026-11", "2026-12"]);
});

test("each region's leaders read their own rows; the ED / BNI Office read both; the record ids are not reachable directly", async () => {
  await call(adNorth, "PUT", "meta/lengthOfMembership", { rows: [lom("Kappa", "Kiran")] });
  await call(adNorth, "PUT", "meta/dues", { members: [renewal("Lambda", "Lata")] });
  const rowsOf = async (user, doc, field) => (await call(user, "GET", "meta/" + doc)).body.meta[field].map(r => r.chapter).sort();
  assert.deepEqual(await rowsOf(adNorth, "lengthOfMembership", "rows"), ["Kappa"]);
  assert.deepEqual(await rowsOf(adAhmedabad, "lengthOfMembership", "rows"), ["Alpha", "Gamma"]);
  assert.deepEqual(await rowsOf(users.ed, "lengthOfMembership", "rows"), ["Alpha", "Gamma", "Kappa"]);
  assert.deepEqual(await rowsOf(users.office, "dues", "members"), ["Alpha", "Beta", "Lambda"]);
  assert.deepEqual(await rowsOf(adAhmedabad, "dues", "members"), ["Alpha", "Beta"]);
  // Ahmedabad's rows come first, in their stored order.
  assert.deepEqual((await call(users.ed, "GET", "meta/dues")).body.meta.members.map(m => m.name), ["Asha A", "Bina B", "Lata"]);
  for (const id of ["dues-north-gujarat", "lengthOfMembership-north-gujarat", "tlr-north-gujarat"]) {
    assert.equal((await call(users.ed, "GET", "meta/" + id)).status, 404, id);
    assert.equal((await call(users.ed, "PUT", "meta/" + id, { rows: [] })).status, 404, id);
  }
});

test("Ahmedabad's own uploads work exactly as before: rows merged by chapter in Ahmedabad's record", async () => {
  await call(adNorth, "PUT", "meta/lengthOfMembership", { rows: [lom("Kappa", "Kiran")] });
  const northBefore = structuredClone(fake.read("meta", "lengthOfMembership-north-gujarat"));
  assert.equal((await call(adAhmedabad, "PUT", "meta/lengthOfMembership", { rows: [lom("Alpha", "Anil")], uploadedAt: "2026-11-25", uploadedBy: "Arun Area" })).status, 200);
  assert.deepEqual(fake.read("meta", "lengthOfMembership"), { uploadedAt: "2026-11-25", uploadedBy: "Arun Area",
    rows: [{ chapter: "Gamma", name: "Gita G", recentLength: "2 Years" }, lom("Alpha", "Anil")] }, "Gamma kept, Alpha replaced - the same merge as before");
  assert.deepEqual(fake.read("meta", "lengthOfMembership-north-gujarat"), northBefore, "and North Gujarat's record is not written either");
  assert.equal((await call(adAhmedabad, "PUT", "meta/lengthOfMembership", { rows: [lom("Kappa", "X")] })).status, 400, "an Ahmedabad leader cannot upload North Gujarat rows");
});

test("TLR: a row naming another region's chapter is not taken because the names overlap; a closed chapter goes with the report's region", async () => {
  const tlrRow = (name, score) => ({ name, score: String(score), chapterSize: "20" });
  // "Kappa Club" is Ahmedabad's; its name contains North Gujarat's Kappa.
  const r = await call(adNorth, "POST", "tlr-upload", { monthIso: "2026-11", monthLabel: "November 2026", rows: [tlrRow("Kappa", 61), tlrRow("Kappa Club", 99), tlrRow("Omega", 40)] });
  assert.equal(r.body.chaptersUpdated, 1, "only Kappa: not Ahmedabad's Kappa Club, and not Omega, which is none of the AD's chapters");
  assert.equal(fake.read("meta", "tlr").rows.some(x => x.name === "Kappa Club" || x.name === "Omega"), false);
  assert.deepEqual(fake.read("meta", "tlr-north-gujarat").rows.map(x => x.name), ["Kappa"]);
  // The ED's upload of a North Gujarat report keeps a closed chapter's row in North
  // Gujarat's records (the report's "Region:" cell).
  await call(users.ed, "POST", "tlr-upload", { monthIso: "2026-11", monthLabel: "November 2026", rows: [tlrRow("Kappa", 61), tlrRow("Omega", 40)], area: NG });
  assert.deepEqual(fake.read("meta", "tlr-north-gujarat").rows.map(x => x.name).sort(), ["Kappa", "Omega"]);
  // The ED's upload of a report without a Region cell: the closed chapter goes with the
  // report's one region.
  await call(users.ed, "POST", "tlr-upload", { monthIso: "2026-10", monthLabel: "October 2026", rows: [tlrRow("Lambda", 50), tlrRow("Sigma", 30)] });
  assert.ok(fake.read("meta", "tlrHistory-north-gujarat").rows.some(x => x.name === "Sigma"));
  assert.equal(fake.read("meta", "tlrHistory"), undefined, "nothing in Ahmedabad's history");
  assert.equal((await call(users.ed, "POST", "tlr-upload", { monthIso: "2026-10", rows: [tlrRow("Lambda", 50)], area: "mars" })).status, 400);
});

test("TLR: a North Gujarat report uploaded by the ED / BNI Office never changes an Ahmedabad chapter, even if it names one", async () => {
  fake.seed("weeklyData", "Alpha_2026-11-17", { chapter: "Alpha", date: "2026-11-17", tlr: 70 });
  invalidateSnapshotCache(); await publishCacheStamps();
  const before = structuredClone(ahmedabadRecords());
  for (const user of [users.ed, users.office]) {
    const r = await call(user, "POST", "tlr-upload", { monthIso: "2026-11", monthLabel: "November 2026", area: NG,
      rows: [{ name: "Kappa", score: "61" }, { name: "Alpha", score: "5" }, { name: "Kappa Club", score: "5" }] });
    assert.equal(r.body.chaptersUpdated, 1, "only Kappa");
  }
  assert.deepEqual(ahmedabadRecords(), before);
  assert.deepEqual(fake.read("weeklyData", "Alpha_2026-11-17"), { chapter: "Alpha", date: "2026-11-17", tlr: 70 }, "Alpha's week keeps its score");
  assert.deepEqual(fake.read("meta", "tlr-north-gujarat").rows.map(r => r.name), ["Kappa"]);
});

test("attendance: a week only North Gujarat has marked is not one of Ahmedabad's weeks", async () => {
  fake.seed("attendance", "2026-11-17", { "dc-alpha": true, "dc-alpha_name": "Dev Alpha" });
  fake.seed("attendance", "2026-11-24", { "dc-kappa": true, "dc-kappa_name": "Kavi Kappa" });
  fake.seed("attendance", "2026-11-03", {});
  invalidateSnapshotCache(); await publishCacheStamps();
  const weeks = async user => (await call(user, "GET", "snapshot")).body.collections.attendance.map(w => w.id).sort();
  assert.deepEqual(await weeks(adAhmedabad), ["2026-11-03", "2026-11-17"], "an empty week stays, as before; North Gujarat's week does not show");
  assert.deepEqual(await weeks(users.srdcBeta), ["2026-11-03", "2026-11-17"]);
  assert.deepEqual(await weeks(adNorth), ["2026-11-03", "2026-11-24"]);
  assert.deepEqual((await call(adAhmedabad, "GET", "attendance")).body.rows.map(w => w.id).sort(), ["2026-11-03", "2026-11-17"]);
  assert.deepEqual(await weeks(users.ed), ["2026-11-03", "2026-11-17", "2026-11-24"], "the ED gets every week; the page shows the region on screen");
});

test("activity log: each region sees its own; one region's activity never pushes the other's entries out", async () => {
  const entry = (i, extra) => ({ action: "weekly_entry_saved", userName: "x", timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), ...extra });
  // 500 older Ahmedabad entries (from before regions: no area), then 50 newer North Gujarat ones.
  for (let i = 0; i < 500; i++) fake.seed("activityLog", "a" + i, entry(i, { chapter: "Alpha", userId: "dc-alpha" }));
  for (let i = 0; i < 50; i++) fake.seed("activityLog", "n" + i, entry(600 + i, { chapter: "Kappa", userId: "dc-kappa" }));
  fake.seed("activityLog", "nad", entry(700, { chapter: null, userId: "ad-ng", action: "tlr_report_uploaded" }));
  fake.seed("activityLog", "office-ng", entry(701, { chapter: null, userId: "__srdc__", action: "tlr_report_uploaded", area: NG }));
  fake.seed("activityLog", "office", entry(702, { chapter: null, userId: "__srdc__", action: "tlr_report_uploaded" }));
  invalidateSnapshotCache(); await publishCacheStamps();
  const rows = async user => (await call(user, "GET", "activityLog")).body.rows;
  const ahm = await rows(adAhmedabad);
  assert.equal(ahm.length, 500, "all of Ahmedabad's newest 500");
  assert.ok(ahm.every(r => r.chapter === "Alpha" || r.id === "office"), "nothing of North Gujarat's");
  assert.deepEqual((await rows(adNorth)).map(r => r.id).sort(), [...Array.from({ length: 50 }, (_, i) => "n" + i), "nad", "office-ng"].sort());
  const ed = await rows(users.ed);
  assert.equal(ed.filter(r => r.area === NG).length, 52);
  assert.equal(ed.filter(r => !r.area).length, 500, "the ED keeps Ahmedabad's newest 500 too");
});

test("activity entries are saved with their region", async () => {
  await call(adNorth, "PUT", "meta/dues", { members: [renewal("Kappa", "Kiran")] });
  await call(users.office, "POST", "tlr-upload", { monthIso: "2026-11", rows: [{ name: "Lambda", score: "50" }], area: NG });
  await call(adAhmedabad, "PUT", "meta/dues", { members: [renewal("Alpha", "Asha")] });
  await call(users.office, "POST", "activity", { action: "dues_uploaded", details: { memberCount: 1, area: NG } });
  const all = (await fake.getDb().collection("activityLog").get()).docs.map(d => d.data());
  const areaOf = action => all.filter(e => e.action === action).map(e => e.area || "ahmedabad");
  assert.deepEqual(areaOf("meta_saved").sort(), ["ahmedabad", NG]);
  assert.deepEqual(areaOf("tlr_report_uploaded"), [NG]);
  assert.ok(all.filter(e => e.action === "meta_saved" && !e.area).length === 1, "Ahmedabad's entries look as they always have - no new field");
});

test("an Ahmedabad leader's snapshot has no North Gujarat Area Director account, and the reverse", async () => {
  const ads = async user => (await call(user, "GET", "snapshot")).body.collections.members.filter(m => m.role === "ad").map(m => m.id).sort();
  assert.deepEqual(await ads(adAhmedabad), ["ad-1"]);
  assert.deepEqual(await ads(adNorth), ["ad-ng"]);
  assert.deepEqual(await ads(users.srdc), ["ad-1"]);
  assert.deepEqual(await ads(users.ed), ["ad-1", "ad-ng"]);
});
