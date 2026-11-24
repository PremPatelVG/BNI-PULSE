// The weekly team call day is kept per region (meta/config.srCallDays). Each region's
// leaders change only their own region's day; the ED and BNI Office change either.
// Made-up accounts and chapters (tests/helpers/region.mjs, plus a made-up North Gujarat).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call, PIN, OFFICE_PIN } from "../helpers/region.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
const adNorth = { id: "ad-ng", role: "ad", chapter: null, chapters: [] };
const srdcNorth = { id: "srdc-ng", role: "srdc", chapter: "Kappa", chapters: ["Kappa"] };
const adAhmedabad = { id: "ad-1", role: "ad", chapter: null, chapters: [] };
const config = () => fake.read("meta", "config");
const save = (user, body) => call(user, "PUT", "meta/config", body);

beforeEach(async () => {
  await seedRegion();
  const pinHash = bcrypt.hashSync(PIN, 4);
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash });
  fake.seed("members", "srdc-ng", { name: "Kiran North", role: "srdc", chapter: "Kappa", chapters: ["Kappa"], pinHash });
  invalidateSnapshotCache();
  await publishCacheStamps();
});

test("each region keeps its own call day; saving one leaves the other alone", async () => {
  assert.equal((await save(adNorth, { srCallDays: { [NG]: "Monday" } })).status, 200);
  assert.equal((await save(adAhmedabad, { srCallDays: { ahmedabad: "Thursday" } })).status, 200);
  assert.deepEqual(config().srCallDays, { [NG]: "Monday", ahmedabad: "Thursday" });
  assert.equal(config().srCallDay, "Friday", "the older single day is untouched");
  // And again later, whenever the call moves.
  assert.equal((await save(srdcNorth, { srCallDays: { [NG]: "Saturday" } })).status, 200, "a Senior Director of the region too");
  assert.deepEqual(config().srCallDays, { [NG]: "Saturday", ahmedabad: "Thursday" });
});

test("a leader cannot change another region's call day; the ED and BNI Office can change both", async () => {
  assert.equal((await save(adNorth, { srCallDays: { ahmedabad: "Monday" } })).status, 403);
  assert.equal((await save(adNorth, { srCallDay: "Monday" })).status, 403, "the older single day is Ahmedabad's");
  assert.equal((await save(srdcNorth, { srCallDays: { ahmedabad: "Monday" } })).status, 403);
  assert.equal((await save(users.srdc, { srCallDays: { [NG]: "Monday" } })).status, 403);
  assert.equal((await save(adAhmedabad, { srCallDays: { [NG]: "Monday" } })).status, 403);
  assert.equal((await save(users.dcAlpha, { srCallDays: { ahmedabad: "Monday" } })).status, 403);
  assert.equal(config().srCallDays, undefined, "nothing was saved");
  assert.equal(config().srCallDay, "Friday");
  for (const user of [users.ed, users.office]) {
    assert.equal((await save(user, { srCallDays: { ahmedabad: "Wednesday", [NG]: "Tuesday" } })).status, 200);
  }
  assert.deepEqual(config().srCallDays, { ahmedabad: "Wednesday", [NG]: "Tuesday" });
});

test("only real days and known regions are stored", async () => {
  assert.equal((await save(users.ed, { srCallDays: { [NG]: "Funday" } })).status, 400);
  assert.equal((await save(users.ed, { srCallDays: { mars: "Monday" } })).status, 400);
  assert.equal((await save(users.ed, { srCallDays: "Monday" })).status, 400);
  assert.equal((await save(adAhmedabad, { srCallDay: "<b>x</b>" })).status, 400);
  assert.equal(config().srCallDays, undefined);
});

test("a leader may change only the call day in config; the BNI Office sign-out date is never writable", async () => {
  assert.equal((await save(adAhmedabad, { somethingElse: 1 })).status, 403);
  assert.equal((await save(users.srdc, { srCallDays: { ahmedabad: "Monday" }, somethingElse: 1 })).status, 403);
  assert.equal(config().somethingElse, undefined);
  // A future date here would make every BNI Office sign-in count as older than a PIN change.
  const future = new Date(Date.now() + 365 * 864e5).toISOString();
  for (const user of [adAhmedabad, users.ed]) {
    assert.equal((await save(user, { srCallDays: { ahmedabad: "Monday" }, srPinChangedAt: future })).status, 200);
  }
  assert.equal(config().srPinChangedAt, undefined);
  assert.equal((await call(null, "POST", "auth/login", { memberId: "__srdc__", pin: OFFICE_PIN })).status, 200);
});
