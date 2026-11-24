// Two regions in one dashboard: the made-up test region (Alpha, Beta, Gamma - no `area`,
// so Ahmedabad) plus two made-up North Gujarat chapters, Kappa and Lambda, with their own
// Area Director. Each Area Director sees and changes only their own region; the
// Executive Director and the BNI Office account run both.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call, PIN } from "../helpers/region.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
const NEW_PIN = "135792";   // made up; new accounts need 6+ digits
const adNorth = { id: "ad-ng", role: "ad", chapter: null, chapters: [] };
const dcKappa = { id: "dc-kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"] };
const adAhmedabad = { id: "ad-1", role: "ad", chapter: null, chapters: [] };   // a bare session: the server fills in the region

beforeEach(async () => {
  await seedRegion();
  const pinHash = bcrypt.hashSync(PIN, 4);
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("chapters", "Lambda", { name: "Lambda", day: "Thursday", order: 11, area: NG });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash });
  fake.seed("members", "srdc-ng", { name: "Kiran North", role: "srdc", chapter: "Kappa", chapters: ["Kappa", "Lambda"], pinHash });
  fake.seed("members", "dc-kappa", { name: "Kavi Kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"], phone: "9000000010", pinHash });
  fake.seed("weeklyData", "Alpha_2026-11-17", { chapter: "Alpha", date: "2026-11-17", visitors: 3 });
  fake.seed("weeklyData", "Kappa_2026-11-17", { chapter: "Kappa", date: "2026-11-17", visitors: 5 });
  invalidateSnapshotCache();
  await publishCacheStamps();
});

const chaptersOf = async user => (await call(user, "GET", "snapshot")).body.collections.chapters.map(c => c.name).sort();

test("each Area Director's snapshot holds only their region; the ED and BNI Office get both", async () => {
  assert.deepEqual(await chaptersOf(adNorth), ["Kappa", "Lambda"]);
  assert.deepEqual(await chaptersOf(adAhmedabad), ["Alpha", "Beta", "Gamma"], "chapters without a region are Ahmedabad's");
  assert.deepEqual(await chaptersOf(users.ed), ["Alpha", "Beta", "Gamma", "Kappa", "Lambda"]);
  assert.deepEqual(await chaptersOf(users.office), ["Alpha", "Beta", "Gamma", "Kappa", "Lambda"]);
  assert.deepEqual(await chaptersOf(users.viewer), ["Alpha", "Beta", "Gamma", "Kappa", "Lambda"]);
  const weekly = (await call(adNorth, "GET", "snapshot")).body.collections.weeklyData.map(w => w.chapter);
  assert.deepEqual(weekly, ["Kappa"]);
});

test("a chapter moved into a region belongs to that region's Area Director on the next request", async () => {
  assert.equal((await call(adNorth, "PUT", "weekly-data/Gamma/2026-11-19", { visitors: 1 })).status, 403);
  assert.equal((await call(users.ed, "POST", "chapters", { id: "Gamma", name: "Gamma", area: NG })).status, 201);
  assert.equal((await call(adNorth, "PUT", "weekly-data/Gamma/2026-11-19", { visitors: 1 })).status, 200);
  assert.ok(!(await chaptersOf(adAhmedabad)).includes("Gamma"));
});

test("weekly data: an Area Director writes only in their own region", async () => {
  assert.equal((await call(adNorth, "PUT", "weekly-data/Kappa/2026-11-17", { visitors: 6 })).status, 200);
  assert.equal((await call(adNorth, "PUT", "weekly-data/Alpha/2026-11-17", { visitors: 9 })).status, 403);
  assert.equal(fake.read("weeklyData", "Alpha_2026-11-17").visitors, 3, "Ahmedabad data untouched");
  assert.equal((await call(adAhmedabad, "PUT", "weekly-data/Kappa/2026-11-17", { visitors: 9 })).status, 403);
  assert.equal((await call(users.ed, "PUT", "weekly-data/Kappa/2026-11-17", { visitors: 7 })).status, 200);
});

test("chapters: an Area Director adds chapters to their own region only; the ED and BNI Office choose", async () => {
  const add = await call(adNorth, "POST", "chapters", { name: "Mu", day: "Friday" });
  assert.equal(add.status, 201);
  assert.equal(fake.read("chapters", "Mu").area, NG, "added to the AD's own region");
  assert.equal((await call(adNorth, "POST", "chapters", { name: "Nu", area: "ahmedabad" })).status, 403);
  assert.equal((await call(adNorth, "POST", "chapters", { id: "Alpha", name: "Alpha", day: "Monday" })).status, 403, "cannot edit another region's chapter");
  assert.equal((await call(adAhmedabad, "POST", "chapters", { id: "Kappa", name: "Kappa", area: "ahmedabad" })).status, 403);
  assert.equal((await call(users.office, "POST", "chapters", { name: "Xi", area: NG })).status, 201);
  assert.equal(fake.read("chapters", "Xi").area, NG);
  assert.equal((await call(users.ed, "POST", "chapters", { name: "Omicron", area: "mars" })).status, 400, "unknown region");
  // An Ahmedabad AD's new chapter is Ahmedabad's.
  assert.equal((await call(adAhmedabad, "POST", "chapters", { name: "Pi" })).status, 201);
  assert.equal(fake.read("chapters", "Pi").area, "ahmedabad");
});

test("accounts: an Area Director manages their own region's accounts; Viewers and other regions belong to the ED / BNI Office", async () => {
  const save = (u, m) => call(u, "POST", "members", m);
  assert.equal((await save(adNorth, { name: "Lata Lambda", role: "dc", chapter: "Lambda", chapters: ["Lambda"], pin: NEW_PIN })).status, 201);
  assert.equal((await save(adNorth, { name: "Arjun Alpha", role: "dc", chapter: "Alpha", chapters: ["Alpha"], pin: NEW_PIN })).status, 403);
  assert.equal((await save(adNorth, { id: "dc-alpha", name: "Dev Alpha", role: "dc", chapter: "Kappa", chapters: ["Kappa"] })).status, 403, "cannot pull another region's account in");
  assert.equal((await save(adNorth, { id: "ad-ng", name: "Nisha North", role: "ad" })).status, 201, "may edit their own account");
  assert.equal(fake.read("members", "ad-ng").area, NG, "a save without area keeps the region");
  assert.equal((await save(adNorth, { id: "ad-ng", name: "Nisha North", role: "ad", area: "ahmedabad" })).status, 403, "cannot move themselves to another region");
  assert.equal((await save(adNorth, { id: "ad-1", name: "Arun Area", role: "ad" })).status, 403, "cannot edit the other region's AD");
  assert.equal((await save(adNorth, { name: "New Viewer", role: "viewer", pin: NEW_PIN })).status, 403);
  assert.equal((await call(adNorth, "DELETE", "members/dc-alpha")).status, 403);
  assert.equal((await call(adNorth, "DELETE", "members/dc-kappa")).status, 204);
  // The ED / BNI Office set an Area Director's region.
  assert.equal((await save(users.office, { name: "Second North AD", role: "ad", area: NG, pin: NEW_PIN })).status, 201);
  assert.equal((await save(users.ed, { name: "Bad Region", role: "ad", area: "mars" })).status, 400);
  // Only an Area Director account carries a region.
  assert.equal((await save(users.ed, { id: "dc-beta", name: "Dina Beta", role: "dc", chapter: "Beta", chapters: ["Beta"], area: NG })).status, 201);
  assert.equal(fake.read("members", "dc-beta").area, undefined);
});

test("contact numbers: an Area Director gets their own region's only", async () => {
  const names = async u => (await call(u, "GET", "member-contacts")).body.contacts.map(c => c.name).sort();
  const north = await names(adNorth);
  assert.ok(north.includes("Kavi Kappa") && north.includes("Kiran North") && north.includes("Nisha North"));
  assert.ok(!north.includes("Dev Alpha") && !north.includes("Arun Area"), JSON.stringify(north));
  const ed = await names(users.ed);
  assert.ok(ed.includes("Dev Alpha") && ed.includes("Kavi Kappa"));
});

test("reports: TLR and dues uploads apply to the uploader's region only", async () => {
  const rows = [{ name: "Alpha", score: "80" }, { name: "Kappa", score: "65" }];
  const t = await call(adNorth, "POST", "tlr-upload", { monthIso: "2026-11", monthLabel: "November 2026", rows });
  assert.equal(t.body.chaptersUpdated, 1);
  assert.equal(fake.read("weeklyData", "Kappa_2026-11-17").tlr, 65);
  assert.equal(fake.read("weeklyData", "Alpha_2026-11-17").tlr, undefined, "Ahmedabad's week untouched");
  // A North Gujarat upload keeps the Ahmedabad rows already on file.
  fake.seed("meta", "dues", { members: [{ chapter: "Alpha", name: "Asha A", dueDate: "2026-12-01" }] });
  invalidateSnapshotCache(); await publishCacheStamps();
  assert.equal((await call(adNorth, "PUT", "meta/dues", { members: [{ chapter: "Kappa", name: "Kunal K", dueDate: "2026-12-05" }] })).status, 200);
  assert.deepEqual(fake.read("meta", "dues"), { members: [{ chapter: "Alpha", name: "Asha A", dueDate: "2026-12-01" }] }, "Ahmedabad's renewals record not written");
  assert.deepEqual(fake.read("meta", "dues-north-gujarat").members.map(m => m.chapter), ["Kappa"], "North Gujarat's own record");
  assert.equal((await call(adNorth, "PUT", "meta/dues", { members: [{ chapter: "Alpha", name: "X", dueDate: "2026-12-05" }] })).status, 400, "rows outside the region are refused");
  const seen = (await call(adNorth, "GET", "snapshot")).body.meta.dues.members.map(m => m.chapter);
  assert.deepEqual(seen, ["Kappa"]);
});

test("barter: an Area Director's oversight covers their own region", async () => {
  fake.seed("meta", "barterCategories", { tree: [{ main: "Finance", subs: ["CA"] }], mainCount: 1, subCount: 1 });
  invalidateSnapshotCache(); await publishCacheStamps();
  const cheque = (u, sub) => call(u, "POST", "barter/checks", { sub, prospectName: "P " + u.id, phone: "98" + Math.floor(Math.random() * 1e8), companyName: "Co", paymentType: "UPI" });
  assert.equal((await cheque(users.dcAlpha, "CA")).status, 201);
  assert.equal((await cheque(dcKappa, "CA")).status, 201);
  const board = (await call(adNorth, "GET", "barter/board")).body;
  const held = JSON.stringify(board);
  assert.ok(!held.includes("Dev Alpha") && !held.includes("Alpha"), "no Ahmedabad holders on the North Gujarat AD's board");
  assert.equal((await call(adNorth, "GET", "barter/trades")).body.scope, "region");
});
