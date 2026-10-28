import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";
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

// A week of Alpha data saved by its DC (as the server stores it).
const dcSaved = (extra = {}) => fake.seed("weeklyData", "Alpha_2026-10-06", {
  chapter: "Alpha", date: "2026-10-06", membersStart: 30, inductions: 1, visitors: 2, references: 5, successStory: "Big deal",
  filledBy: "Dev Alpha", filledByRole: "dc", savedAt: "2026-10-06T09:00:00.000Z",
  updatedAt: "2026-10-06T09:00:00.000Z", updatedBy: "dc-alpha", updatedByName: "Dev Alpha", updatedByRole: "dc", ...extra
});
const openWeek = date => page.run(`document.getElementById('eDate').value='${date}';showWeekEntryInForm();`);
const field = id => page.run(`return String(document.getElementById('${id}').value);`);
const setField = (id, v) => page.run(`document.getElementById('${id}').value='${v}';`);
const save = () => page.run(`await saveEntry();`);

test("a week someone already filled opens with their latest data and says who saved it", async () => {
  dcSaved();
  fake.seed("_system", "cacheStamps", { weeklyData: "t1" });
  await page.loadData();
  await openWeek("2026-10-06");
  assert.deepEqual([await field("eVis"), await field("eRefs"), await field("eStory"), await field("eInd")], ["2", "5", "Big deal", "1"]);
  const note = page.el("entryWeekNote");
  assert.equal(note.style.display, "block");
  assert.match(note.innerHTML, /submitted by <strong>Dev Alpha \(DC\)<\/strong>/);
  assert.match(note.innerHTML, /show the latest saved data/);
  // A week with nothing saved starts blank again.
  await openWeek("2026-10-13");
  assert.deepEqual([await field("eVis"), await field("eRefs"), await field("eStory")], ["0", "0", ""]);
  assert.equal(note.style.display, "none");
});

test("saving over someone else's week asks Override or Cancel - and any role can override any other", async () => {
  dcSaved();
  fake.seed("_system", "cacheStamps", { weeklyData: "t1" });
  await page.loadData();
  await openWeek("2026-10-06");
  await setField("eVis", "7");
  page.answerOverride(false);
  await save();
  assert.equal(page.log.overrides.length, 1);
  assert.match(page.log.overrides[0], /Alpha<\/strong> - meeting on .*submitted by <strong>Dev Alpha \(DC\)<\/strong>/s);
  assert.match(page.log.overrides[0], />Override<\/button>.*>Cancel<\/button>/s);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 2, "Cancel keeps the DC's data");
  assert.ok(page.log.toasts.some(t => /Not saved/.test(t)));
  assert.equal(await field("eVis"), "7", "what the SA typed is still in the form");

  // The SA overrides the DC...
  page.answerOverride(true);
  await save();
  let e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.deepEqual([e.visitors, e.references, e.filledBy, e.updatedByName, e.updatedByRole], [7, 5, "Alpha SA", "Alpha SA", "sa1"]);

  // ...the DC then sees the SA's data and can override it...
  await page.signIn(users.dcAlpha);
  await page.loadData();
  await page.run(`S.dcActiveChapter='Alpha';EDITING_ENTRY=null;`);
  await openWeek("2026-10-06");
  assert.equal(await field("eVis"), "7");
  assert.match(page.el("entryWeekNote").innerHTML, /Alpha SA \(SA\)/);
  await setField("eVis", "8");
  page.clearLog();
  await save();
  assert.match(page.log.overrides[0], /submitted by <strong>Alpha SA \(SA\)/);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 8);

  // ...and so can the Senior DC, after which the SA is told it was the Senior DC.
  await page.signIn(users.srdc);
  await page.loadData();
  await page.run(`document.getElementById('eChapter').value='Alpha';EDITING_ENTRY=null;`);
  await openWeek("2026-10-06");
  await setField("eVis", "9");
  page.clearLog();
  await save();
  assert.match(page.log.overrides[0], /Dev Alpha \(DC\)/);
  e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.deepEqual([e.visitors, e.updatedByName, e.updatedByRole], [9, "Sameer Senior", "srdc"]);
  await page.signIn(users.saAlpha);
  await page.loadData();
  await page.run(`EDITING_ENTRY=null;`);
  await openWeek("2026-10-06");
  assert.match(page.el("entryWeekNote").innerHTML, /Sameer Senior \(Senior DC\)/);
});

test("re-saving your own latest save does not ask; a newer save by anyone asks again and Cancel shows it", async () => {
  await openWeek("2026-10-06");
  await fill("2026-10-06", { eMStart: "30", eVis: "3" });
  await save();
  await setField("eVis", "4");
  await save();
  assert.equal(page.log.overrides.length, 0, "the first save and re-saving your own data never ask");
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 4);

  // The DC saves the week while the SA still has it open.
  assert.equal((await call(users.dcAlpha, "PUT", "weekly-data/Alpha/2026-10-06", { visitors: 9 })).status, 200);
  await setField("eVis", "5");
  page.answerOverride(false);
  await save();
  assert.match(page.log.overrides[0], /saved again after you opened it/);
  assert.match(page.log.overrides[0], /last updated by <strong>Dev Alpha \(DC\)/);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 9);
  assert.equal(await field("eVis"), "9", "Cancel loads the latest data into the form");

  // Overriding it still asks (it is the DC's save now), then saves.
  page.clearLog();
  page.answerOverride(true);
  await setField("eVis", "6");
  await save();
  assert.equal(page.log.overrides.length, 1);
  assert.doesNotMatch(page.log.overrides[0], /saved again after you opened it/);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 6);

  // Clear empties the form; the week is still saved, so saving asks again.
  await page.run(`clearForm();`);
  assert.equal(await field("eVis"), "0");
  assert.match(page.el("entryWeekNote").innerHTML, /Show saved data/);
  page.clearLog();
  await fill("2026-10-06", { eMStart: "30", eVis: "1" });
  await save();
  assert.equal(page.log.overrides.length, 1, "after Clear it asks again");
});

test("Call Mode quick update asks the same way before replacing someone else's data", async () => {
  dcSaved();
  fake.seed("_system", "cacheStamps", { weeklyData: "t1" });
  await page.loadData();
  const quick = (vis, version) => page.run(`
    document.getElementById('qu_vis').value='${vis}';document.getElementById('qu_ind').value='1';
    globalThis.event={target:document.getElementById('quBtn')};await quickSave('Alpha','2026-10-06','${version}');`);
  page.answerOverride(false);
  await quick(4, "2026-10-06T09:00:00.000Z");
  assert.match(page.log.overrides[0], /Dev Alpha \(DC\)/);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 2);
  page.answerOverride(true);
  await quick(4, "2026-10-06T09:00:00.000Z");
  const e = fake.read("weeklyData", "Alpha_2026-10-06");
  assert.deepEqual([e.visitors, e.updatedByName, e.references], [4, "Alpha SA", 5]);
  page.clearLog();
  await quick(5, e.updatedAt);
  assert.equal(page.log.overrides.length, 0, "updating your own latest save does not ask");
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 5);
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
