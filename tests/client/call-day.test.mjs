// The Team Call Day on the page: each region keeps its own day. The ED / BNI Office set
// both in Settings; an Area Director sets their own region's. Made-up chapters and people
// (tests/helpers/region.mjs, plus a made-up North Gujarat: Kappa and Lambda).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, PIN } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
const adNorth = { id: "ad-ng", role: "ad", chapter: null, chapters: [] };
let page;

beforeEach(async () => {
  await seedRegion();
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("chapters", "Lambda", { name: "Lambda", day: "Thursday", order: 11, area: NG });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash: bcrypt.hashSync(PIN, 4) });
  invalidateSnapshotCache();
  await publishCacheStamps();
  page = loadPage();
});

const settings = () => page.run(`S.tab='settings';renderSettings();return document.getElementById('tab-settings').innerHTML;`);
const attendanceNote = () => page.run(`S.attendance={};runAttendanceReport();return document.getElementById('reportContent').innerHTML;`);
const choose = (area, day) => page.run(`document.getElementById('srCallDaySelect-${area}').value='${day}';await saveSrCallDay('${area}');`);

test("the ED sets each region's call day on its own, and the wording follows the region on screen", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  const html = await settings();
  assert.match(html, /each region keeps its own day/);
  assert.match(html, />Ahmedabad<\/div><select id="srCallDaySelect-ahmedabad"/);
  assert.match(html, />North Gujarat<\/div><select id="srCallDaySelect-north-gujarat"/);
  assert.match(html, /id="srCallDaySelect-north-gujarat"[^>]*>(<option>[A-Za-z]+<\/option>)*<option selected>Friday</, "a region not set yet shows the old shared day");

  await choose(NG, "Monday");
  assert.deepEqual(fake.read("meta", "config").srCallDays, { [NG]: "Monday" });
  assert.equal(fake.read("meta", "config").srCallDay, "Friday", "Ahmedabad's day is unchanged");
  assert.ok(page.log.toasts.some(t => /North Gujarat team call day set to Monday/.test(t)));
  await choose("ahmedabad", "Thursday");
  assert.deepEqual(fake.read("meta", "config").srCallDays, { [NG]: "Monday", ahmedabad: "Thursday" });

  await page.run(`await refreshSnapshot();`);
  assert.match(await attendanceNote(), /during your Thursday call/, "Ahmedabad is on screen");
  await page.run(`setAreaView('north-gujarat');`);
  assert.match(await attendanceNote(), /during your Monday call/);
  // Changed again later - nothing is fixed.
  await choose(NG, "Wednesday");
  await page.run(`await refreshSnapshot();`);
  assert.match(await attendanceNote(), /during your Wednesday call/);
  assert.match(await settings(), /id="srCallDaySelect-north-gujarat"[^>]*>(<option>[A-Za-z]+<\/option>)*<option selected>Wednesday</);
});

test("an Area Director sees and sets only their own region's call day", async () => {
  fake.seed("meta", "config", { ...fake.read("meta", "config"), srCallDays: { ahmedabad: "Thursday" } });
  invalidateSnapshotCache(); await publishCacheStamps();
  await page.signIn(adNorth);
  await page.loadData();
  const html = await settings();
  assert.match(html, />North Gujarat<\/div><select id="srCallDaySelect-north-gujarat"/);
  assert.doesNotMatch(html, /srCallDaySelect-ahmedabad/);
  await choose(NG, "Saturday");
  assert.deepEqual(fake.read("meta", "config").srCallDays, { ahmedabad: "Thursday", [NG]: "Saturday" });
  await page.run(`await refreshSnapshot();`);
  assert.match(await attendanceNote(), /during your Saturday call/);
});

test("an Ahmedabad Area Director sees Settings as before - one day, no region names", async () => {
  await page.signIn(users.ad);
  await page.loadData();
  const html = await settings();
  assert.match(html, /The day you run your weekly team call/);
  assert.doesNotMatch(html, /North Gujarat/);
  assert.match(html, /<select id="srCallDaySelect-ahmedabad"/);
  await choose("ahmedabad", "Tuesday");
  assert.deepEqual(fake.read("meta", "config").srCallDays, { ahmedabad: "Tuesday" });
  assert.ok(page.log.toasts.some(t => /^Team call day set to Tuesday/.test(t)));
});
