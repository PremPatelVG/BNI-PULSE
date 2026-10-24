import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
beforeEach(async () => {
  await seedRegion();
  page = loadPage();
  await page.signIn(users.saAlpha);
  await page.loadData();
  await page.run(`S.dcActiveChapter='Alpha';S.tab='entry';`);
});
// Fills the Data Entry form fields the save reads.
const fill = (date, fields = {}) => page.run(`
  document.getElementById('eDate').value='${date}';
  ${Object.entries({ eMStart: "", eInd: "0", eDrop: "0", eVis: "0", ...fields }).map(([k, v]) => `document.getElementById('${k}').value='${v}';`).join("")}`);

test("member counts carry over week to week, anchored on the first entry or the chapter's opening count", async () => {
  const r = await page.run(`
    S.weeklyData=[{chapter:'Alpha',date:'2026-10-06',membersStart:30,inductions:2,drops:1},{chapter:'Alpha',date:'2026-10-13',membersStart:0,inductions:1,drops:0},
      {chapter:'Gamma',date:'2026-10-07',membersStart:0,inductions:1,drops:0}];
    S.chapters=[{name:'Alpha'},{name:'Gamma',openingMembers:22}];
    return {a:getCascadedEntries('Alpha').map(e=>e.membersStart+'>'+e.membersClose),g:getCascadedEntries('Gamma').map(e=>e.membersStart+'>'+e.membersClose),
      none:getCascadedEntries('Beta').length,neg:calcActiveMembers(1,0,5)};`);
  assert.deepEqual(r.a, ["30>31", "31>32"]);
  assert.deepEqual(r.g, ["22>23"], "a first entry saved as 0 starts from the opening count");
  assert.equal(r.none, 0);
  assert.equal(r.neg, 0, "never below zero");
});

test("saving a weekly entry writes it to the server; the meeting day and first-entry rules are enforced", async () => {
  await fill("2026-10-07", { eMStart: "30" });                         // a Wednesday; Alpha meets Tuesdays
  await page.run(`await saveEntry();`);
  assert.equal(fake.all("weeklyData").length, 0);
  assert.ok(page.log.toasts.some(t => /meets on Tuesdays/.test(t)));
  await fill("2026-10-06", { eMStart: "" });
  await page.run(`await saveEntry();`);
  assert.equal(fake.all("weeklyData").length, 0, "first entry needs Members at Start");
  assert.ok(page.log.toasts.some(t => /Members at Start/.test(t)));
  await fill("2026-10-06", { eMStart: "30", eInd: "2", eVis: "5" });
  await page.run(`await saveEntry();`);
  const e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.deepEqual([e.membersStart, e.inductions, e.membersClose, e.visitors, e.filledBy, e.updatedBy], [30, 2, 32, 5, "Alpha SA", "sa-alpha"]);
  assert.ok(page.log.toasts.some(t => /Saved & synced/.test(t)));
  assert.equal(await page.run(`return ENTRY_DIRTY;`), false);
});

test("overwrite protection: asks before replacing an entry, and again if someone changed it after Edit", async () => {
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06", membersStart: 30, visitors: 2, updatedAt: "2026-10-06T10:00:00.000Z", updatedBy: "dc-alpha" });
  fake.seed("_system", "cacheStamps", { weeklyData: "t1" });
  await page.loadData();
  await fill("2026-10-06", { eMStart: "30", eVis: "7" });
  page.answerConfirm(false);
  await page.run(`await saveEntry();`);
  assert.match(page.log.confirms.at(-1), /already has an entry .* submitted by Dev Alpha/s);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 2, "Cancel keeps their entry");
  // Open it with Edit, then someone else saves it again before we do.
  await page.run(`loadEdit('Alpha','2026-10-06');`);
  fake.seed("weeklyData", "Alpha_2026-10-06", { ...fake.read("weeklyData", "Alpha_2026-10-06"), visitors: 9, updatedAt: "2026-10-06T11:00:00.000Z", updatedBy: "dc-alpha" });
  fake.seed("_system", "cacheStamps", { weeklyData: "t2" });
  await fill("2026-10-06", { eMStart: "30", eVis: "4" });
  page.clearLog();
  await page.run(`await saveEntry();`);
  assert.match(page.log.confirms.at(-1), /changed this Alpha entry .* after you opened it/s);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 9);
  page.answerConfirm(true);
  await page.run(`await saveEntry();`);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 4, "OK overwrites deliberately");
  page.clearLog();
  await fill("2026-10-06", { eMStart: "30", eVis: "5" });
  await page.run(`await saveEntry();`);
  assert.equal(page.log.confirms.length, 0, "saving again after your own save does not ask");
  await page.run(`clearForm();`);
  await fill("2026-10-06", { eMStart: "30" });
  await page.run(`await saveEntry();`);
  assert.match(page.log.confirms.at(-1), /already has an entry/, "after Clear it asks again");
});

test("delete: shows an error when the server refuses", async () => {
  fake.seed("weeklyData", "Alpha_2026-10-06", { chapter: "Alpha", date: "2026-10-06", membersStart: 30 });
  page.failNext(/^DELETE \/weekly-data/, 403);
  await page.run(`await delEntry('Alpha','2026-10-06');`);
  assert.ok(page.log.toasts.some(t => /Entry NOT deleted/.test(t)));
  assert.ok(fake.read("weeklyData", "Alpha_2026-10-06"));
  await page.run(`await delEntry('Alpha','2026-10-06');`);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06"), undefined);
});

test("'Who Visited the Chapter' lists the DC, SA and the chapter's Senior DC - each person once", async () => {
  const r = await page.run(`
    S.chapters=[{name:'Alpha',seniorDirector:'Sameer Senior',seniorDirectorId:'srdc-1'},{name:'Gamma',seniorDirector:'Sameer Senior',seniorDirectorId:'srdc-1'}];
    S.members=[{id:'dc-alpha',name:'Dev Alpha',role:'dc',chapters:['Alpha']},{id:'sa-alpha',name:'Alpha SA',role:'sa1',chapters:['Alpha']},
      {id:'dc-gamma',name:'Sameer Senior',role:'dc',chapters:['Gamma']},{id:'srdc-1',name:'Sameer Senior',role:'srdc',chapters:['Gamma']}];
    return {alpha:visitorOptions('Alpha').map(o=>o.name),gamma:visitorOptions('Gamma').map(o=>o.name)};`);
  assert.deepEqual(r.alpha, ["Dev Alpha (Chapter Director (CD/DC))", "Alpha SA (SA)", "Sameer Senior (Senior Director)"]);
  assert.deepEqual(r.gamma, ["Sameer Senior (Chapter Director (CD/DC) & Senior Director)"]);
});
