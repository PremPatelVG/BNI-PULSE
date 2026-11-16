import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
// Local dates, as the page computes them (todayISO): a UTC date is a day behind in India
// between midnight and 5:30 am.
const localIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d); };
beforeEach(async () => {
  await seedRegion();
  fake.seed("miyagiMembers", "alpha_ravi_shah", { name: "Ravi Shah", chapter: "Alpha", joinDate: "2026-06-01", status: "active", score: 5, checkpoints: { msp: { done: true } }, checkins: {}, lastActivityDate: daysAgo(2) });
  fake.seed("miyagiMembers", "beta_mira_jain", { name: "Mira Jain", chapter: "Beta", joinDate: "2026-06-01", status: "active", score: 0, checkpoints: {}, checkins: {} });
  page = loadPage();
  await page.signIn(users.saAlpha);
  await page.loadData();
});

test("points per task and belt boundaries", async () => {
  const r = await page.run(`
    const all={};MIYAGI_TASKS.forEach(t=>all[t.key]={done:true});
    return {tasks:MIYAGI_TASKS.length,total:calcMiyagiScore(all),none:calcMiyagiScore({}),undone:calcMiyagiScore({msp:{done:false}}),
      belts:[0,4,5,29,30,49,50,74,75,99,100,135].map(s=>getMiyagiBelt(s).name)};`);
  assert.equal(r.tasks, 14);
  assert.equal(r.total, 105, "all 14 tasks");
  assert.equal(r.none, 0);
  assert.equal(r.undone, 0);
  assert.deepEqual(r.belts, ["No Belt", "No Belt", "White", "White", "Yellow", "Yellow", "Blue", "Blue", "Brown", "Brown", "Black", "Black"]);
});

test("member id and activity helpers", async () => {
  const r = await page.run(`return [miyagiId('BNI Hera','Dr. Asha  K-Patel'),miyagiId('Alpha','  Ravi Shah '),
    isMiyagiNeverStarted({checkpoints:{},checkins:{}}),isMiyagiNeverStarted({checkins:{'3month':{}}}),
    isMiyagiStalled({checkpoints:{msp:{done:true}},lastActivityDate:'${daysAgo(14)}'}),isMiyagiStalled({checkpoints:{msp:{done:true}},lastActivityDate:'${daysAgo(13)}'}),
    isMiyagiStalled({checkpoints:{},lastActivityDate:'${daysAgo(60)}'})];`);
  assert.deepEqual(r, ["bni_hera_dr_asha_k_patel", "alpha_ravi_shah", true, false, true, false, false]);
});

test("the Miyagi list is fetched scoped, and re-fetched each time the tab opens", async () => {
  await page.run(`await ensureMiyagiLoaded(true);`);
  assert.deepEqual(await page.run(`return S.miyagiMembers.map(m=>m.id);`), ["alpha_ravi_shah"]);
  fake.seed("miyagiMembers", "alpha_new", { name: "New One", chapter: "Alpha", status: "active", checkpoints: {} });
  fake.seed("_system", "cacheStamps", { miyagiMembers: "import-x" });           // what the import scripts write
  await page.run(`switchTab('miyagi');`);
  await page.run(`await ensureMiyagiLoaded(true);`);
  assert.equal(await page.run(`return S.miyagiMembers.length;`), 2);
});

test("empty chapter message says nothing has been uploaded yet", async () => {
  await page.signIn(users.saBeta);
  await page.run(`S.chapters=[{name:'Beta'}];S.miyagiMembers=[];MIYAGI_LOADED=true;S.tab='miyagi';renderMiyagiTab();`);
  assert.match(page.el("tab-miyagi").innerHTML, /No Miyagi members have been uploaded for Beta yet/);
});

test("saving ticks: only the changed ticks are sent, a tick saved meanwhile by someone else survives, score from stored ticks", async () => {
  await page.run(`await ensureMiyagiLoaded(true);`);
  // Someone else ticks 'mentorship' after this page loaded the list.
  fake.seed("miyagiMembers", "alpha_ravi_shah", { ...fake.read("miyagiMembers", "alpha_ravi_shah"), checkpoints: { msp: { done: true }, mentorship: { done: true } }, score: 10 });
  page.clearLog();
  await page.run(`MIYAGI_PENDING={alpha_ravi_shah:{powerTeam:true}};await saveMiyagiCheckpoints('alpha_ravi_shah');`);
  const put = page.log.calls.find(c => c.method === "PUT" && c.path === "/miyagiMembers/alpha_ravi_shah");
  assert.deepEqual(Object.keys(put.body.checkpoints), ["powerTeam"]);
  const m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.equal(m.checkpoints.mentorship.done, true);
  assert.equal(m.checkpoints.powerTeam.markedBy, "Alpha SA");
  assert.equal(m.score, 20, "5 + 5 + 10 from everyone's ticks");
  assert.equal(await page.run(`return S.miyagiMembers[0].score + ':' + Object.keys(MIYAGI_PENDING).length;`), "20:0");
});

test("a failed save keeps the ticks staged and says NOT saved; unticking works", async () => {
  await page.run(`await ensureMiyagiLoaded(true);`);
  page.failNext(/^PUT \/miyagiMembers/, 500);
  await page.run(`MIYAGI_PENDING={alpha_ravi_shah:{greenTLR:true}};await saveMiyagiCheckpoints('alpha_ravi_shah');`);
  assert.ok(page.log.toasts.some(t => /Miyagi progress NOT saved/.test(t)));
  assert.equal(await page.run(`return MIYAGI_PENDING.alpha_ravi_shah.greenTLR;`), true);
  await page.run(`MIYAGI_PENDING={alpha_ravi_shah:{msp:false}};await saveMiyagiCheckpoints('alpha_ravi_shah');`);
  const m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.equal(m.checkpoints.msp.done, false);
  assert.equal(m.score, 0);
});

test("check-in: only that check-in is sent and merged", async () => {
  fake.seed("miyagiMembers", "alpha_ravi_shah", { ...fake.read("miyagiMembers", "alpha_ravi_shah"), checkins: { "3month": { submittedDate: "2026-09-01" } } });
  await page.run(`await ensureMiyagiLoaded(true);MIYAGI_ACTIVE_CHECKIN={memberId:'alpha_ravi_shah',checkinKey:'6month'};await submitMiyagiCheckin();`);
  const m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.deepEqual(Object.keys(m.checkins).sort(), ["3month", "6month"]);
  assert.equal(m.checkins["6month"].submittedBy, "Alpha SA");
});

test("drop and reactivate record the milestone and final score", async () => {
  await page.run(`await ensureMiyagiLoaded(true);await markMiyagiDropped('alpha_ravi_shah');`);
  let m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.equal(m.status, "dropped");
  assert.equal(m.finalScore, 5);
  assert.equal(m.finalBelt, "White");
  assert.match(m.droppedAtMilestone, /month/);
  await page.run(`await reactivateMiyagiMember('alpha_ravi_shah');`);
  m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.equal(m.status, "active");
});

// A Length of Membership row as the parser hands it to the sync. `cum` / `rec` are the
// Cumulative and Recent Length in months.
const lom = (chapter, firstName, lastName, cum, cumulativeStart, rec = cum, recentStart = cumulativeStart) => ({
  chapter, firstName, lastName, name: (firstName + " " + lastName).trim(), cumulativeStart,
  cumulativeLength: cum === null ? "" : `${Math.floor(cum / 12)} years (${cum % 12} months)`, recentMonths: rec, recentStart
});
const sync = rows => { page.ctx.__lom = rows; return page.run(`S.chapters=[{name:'Alpha'}];document.getElementById('lomStatus').textContent='Uploaded ${rows.length} members';await syncMiyagiMembers(globalThis.__lom);`); };
const miyagiIds = () => fake.all("miyagiMembers").map(m => m.id).sort();

test("Length of Membership sync: adds members under 12 months, once, and leaves existing members alone", async () => {
  await sync([
    lom("Alpha", "RAVI", "SHAH", 5, "2026-06-01"),
    lom("Alpha", "Neha", "Rao", 3, "2026-08-01"),
    lom("Alpha", "Neha", "Rao", 3, "2026-08-01"),
    lom("Alpha", "Old", "Timer", 46, "2023-01-01"),
    lom("Beta", "Out", "Ofscope", 2, "2026-09-01")
  ]);
  assert.deepEqual(miyagiIds(), ["alpha_neha_rao", "alpha_ravi_shah", "beta_mira_jain"], "Ravi skipped, Neha once, over-12 and other chapter not added");
  const neha = fake.read("miyagiMembers", "alpha_neha_rao");
  assert.deepEqual([neha.firstName, neha.lastName, neha.cumulativeStart, neha.cumulativeLength, neha.joinDate, neha.score, neha.status],
    ["Neha", "Rao", "2026-08-01", "0 years (3 months)", "2026-08-01", 0, "active"]);
  assert.deepEqual(fake.read("miyagiMembers", "alpha_ravi_shah").checkpoints, { msp: { done: true } }, "existing progress untouched");
  assert.equal(fake.read("miyagiMembers", "alpha_ravi_shah").score, 5);
  assert.equal(page.el("lomStatus").textContent, "Uploaded 5 members - Miyagi: 1 new member added, 2 already in the program (skipped)");
  // The same report again changes nothing.
  page.clearLog();
  await sync([lom("Alpha", "Neha", "Rao", 3, "2026-08-01")]);
  assert.match(page.el("lomStatus").textContent, /0 new members added, 1 already in the program \(skipped\)/);
  assert.ok(!page.log.calls.some(c => c.path === "/miyagi-new-members"), "nothing to add, nothing sent");
});

test("Length of Membership sync goes by Recent Length, not Cumulative Length", async () => {
  await sync([
    // Rejoined: 3 months into this stint, over 4 years in BNI in total - counts from the rejoin.
    lom("Alpha", "Back", "Again", 52, "2021-02-01", 3, "2026-08-01"),
    lom("Alpha", "Kiran", "Mehta", 8, "2021-08-01", 0, "2026-11-01"),
    // Rejoined over a year ago: past the first year of this stint.
    lom("Alpha", "Past", "Year", 52, "2021-02-01", 13, "2025-10-01"),
    // Exactly 12 months is past the first year.
    lom("Alpha", "Just", "Done", 12, "2025-11-01"),
    lom("Alpha", "Almost", "There", 11, "2025-12-01")
  ]);
  assert.deepEqual(miyagiIds(), ["alpha_almost_there", "alpha_back_again", "alpha_kiran_mehta", "alpha_ravi_shah", "beta_mira_jain"]);
  const back = fake.read("miyagiMembers", "alpha_back_again");
  assert.deepEqual([back.cumulativeStart, back.cumulativeLength, back.joinDate], ["2021-02-01", "4 years (4 months)", "2026-08-01"],
    "first-ever start kept on record; the program runs from the current start");
  assert.match(page.el("lomStatus").textContent, /- Miyagi: 3 new members added$/);
});

test("Length of Membership sync: already in the program = chapter + first + last name + Cumulative Start Date", async () => {
  fake.seed("miyagiMembers", "alpha_neha_rao", { name: "Neha Rao", firstName: "Neha", lastName: "Rao", chapter: "Alpha", cumulativeStart: "2026-08-01", status: "active", score: 30, checkpoints: { msp: { done: true } }, checkins: {} });
  fake.seed("miyagiMembers", "alpha_gone_away", { name: "Gone Away", chapter: "Alpha", cumulativeStart: "2026-05-01", status: "dropped", score: 10, checkpoints: {}, checkins: {} });
  fake.seed("miyagiMembers", "alpha_all_done", { name: "All Done", chapter: "Alpha", status: "graduated", score: 80, checkpoints: {}, checkins: {} });
  await sync([
    lom("Alpha", "NEHA", "RAO", 3, "2026-08-01"),      // all four match: skipped
    lom("Alpha", "Neha", "Rao", 1, "2026-10-01"),      // same name, another start date: a different person
    lom("Alpha", "Neha", "Rao", 1, "2026-10-01"),      // ...listed twice, added once
    lom("Alpha", "Ravi", "Shah", 5, "2026-06-01"),     // sheet member with no start date on record: the name decides
    lom("Alpha", "Gone", "Away", 6, "2026-05-01"),     // dropped members are not added again
    lom("Alpha", "All", "Done", 11, "2025-12-01"),     // nor are 1-YEAR DONE members
    lom("Alpha", "No", "Date", 2, "")                  // no start date in the report: the name decides
  ]);
  assert.deepEqual(miyagiIds(), ["alpha_all_done", "alpha_gone_away", "alpha_neha_rao", "alpha_neha_rao_20261001", "alpha_no_date", "alpha_ravi_shah", "beta_mira_jain"]);
  assert.deepEqual([fake.read("miyagiMembers", "alpha_neha_rao").score, fake.read("miyagiMembers", "alpha_gone_away").status, fake.read("miyagiMembers", "alpha_all_done").status], [30, "dropped", "graduated"]);
  const second = fake.read("miyagiMembers", "alpha_neha_rao_20261001");
  assert.deepEqual([second.name, second.cumulativeStart, second.score], ["Neha Rao", "2026-10-01", 0]);
  assert.match(page.el("lomStatus").textContent, /2 new members added, 5 already in the program \(skipped\)$/);
  // Uploading again adds neither Neha a third time.
  await sync([lom("Alpha", "Neha", "Rao", 3, "2026-08-01"), lom("Alpha", "Neha", "Rao", 1, "2026-10-01"), lom("Alpha", "No", "Date", 2, "")]);
  assert.equal(fake.all("miyagiMembers").length, 7);
});

test("Length of Membership sync: a large report is saved in batches, and a failed batch is reported and can be retried", async () => {
  const rows = Array.from({ length: 230 }, (_, i) => lom("Alpha", "Member", "No" + i, i % 12, "2026-01-01"));
  page.failNext(/PUT \/miyagi-new-members/, 500);
  await sync(rows);
  const sent = page.log.calls.filter(c => c.path === "/miyagi-new-members");
  assert.deepEqual(sent.map(c => c.body.members.length), [100, 100, 30]);
  assert.equal(fake.all("miyagiMembers").length, 2 + 130, "the two batches that got through were saved");
  assert.match(page.el("lomStatus").textContent, /130 new members added, 100 NOT added$/);
  assert.match(page.log.alerts[0], /100 could NOT be added:[\s\S]*Member No0 \(Alpha\)[\s\S]*Upload the Length of Membership report again/);
  // The retry adds exactly the ones that are missing.
  page.clearLog();
  await sync(rows);
  assert.equal(fake.all("miyagiMembers").length, 2 + 230);
  assert.match(page.el("lomStatus").textContent, /100 new members added, 130 already in the program \(skipped\)$/);
  assert.equal(fake.all("activityLog").filter(a => a.action === "miyagi_members_added").reduce((n, a) => n + a.details.memberCount, 0), 230);
  const shown = await page.run(`S.tab='miyagi';renderMiyagiTab();return S.miyagiMembers.filter(m=>m.chapter==='Alpha').length;`);
  assert.equal(shown, 231, "the page's own list is refreshed after the upload");
});

test("Length of Membership sync: a row without Recent Length or a start date adds nobody", async () => {
  await sync([lom("Alpha", "Neha", "Rao", 3, "", null, "")]);
  assert.deepEqual(miyagiIds(), ["alpha_ravi_shah", "beta_mira_jain"]);
  assert.match(page.el("lomStatus").textContent, /0 new members added, 1 not added \(no Recent Length in the report\)$/);
});

const today = () => localIso(new Date());
// Member names in the Miyagi Completed table, in the order shown.
const completedNames = html => [...html.matchAll(/<td style="font-weight:700">([^<]*)<\/td>/g)].map(m => m[1]);

test("1-YEAR DONE moves a member to Miyagi Completed with the date, final belt and who marked it; Undo moves them back", async () => {
  await page.run(`await ensureMiyagiLoaded(true);`);
  // Unsaved ticks would be lost when the card closes, so they have to be saved first.
  await page.run(`MIYAGI_PENDING={alpha_ravi_shah:{powerTeam:true}};await markMiyagiOneYearDone('alpha_ravi_shah');MIYAGI_PENDING={};`);
  assert.ok(page.log.toasts.some(t => /Save the ticked tasks first/.test(t)));
  assert.equal(fake.read("miyagiMembers", "alpha_ravi_shah").status, "active");

  page.clearLog();
  await page.run(`await markMiyagiOneYearDone('alpha_ravi_shah');`);
  assert.match(page.log.confirms[0], /Mark Ravi Shah \(Alpha\) as 1-YEAR DONE/);
  const m = fake.read("miyagiMembers", "alpha_ravi_shah");
  assert.deepEqual([m.status, m.completedDate, m.completedBy, m.finalScore, m.finalBelt], ["graduated", today(), "Alpha SA", 5, "White"]);
  assert.ok(page.log.calls.some(c => c.path === "/activity" && c.body.action === "miyagi_member_completed"), "logged");
  for (const action of ["miyagi_member_completed", "miyagi_completion_undone"]) {
    assert.equal((await call(users.saAlpha, "POST", "activity", { action, details: { memberName: "Ravi Shah" } })).status, 204, action + " is accepted");
  }

  const miyagi = await page.run(`S.tab='miyagi';renderMiyagiTab();return document.getElementById('tab-miyagi').innerHTML;`);
  assert.doesNotMatch(miyagi, /Ravi Shah/, "no longer in the Miyagi list");
  assert.match(miyagi, /1-YEAR DONE/);
  const done = await page.run(`S.tab='miyagidone';renderMiyagiCompletedTab();return document.getElementById('tab-miyagidone').innerHTML;`);
  assert.deepEqual(completedNames(done), ["Ravi Shah"]);
  assert.doesNotMatch(done, /All Months/, "a chapter account gets no filters");

  await page.run(`await undoMiyagiOneYearDone('alpha_ravi_shah');`);
  assert.equal(fake.read("miyagiMembers", "alpha_ravi_shah").status, "active");
  assert.equal(fake.read("miyagiMembers", "alpha_ravi_shah").score, 5, "progress kept");
});

test("Miyagi Completed: leaders filter by chapter, month and date range; Senior DCs see only their chapters", async () => {
  const done = (id, name, chapter, completedDate) =>
    fake.seed("miyagiMembers", id, { name, chapter, joinDate: "2025-09-01", status: "graduated", completedDate, finalScore: 40, finalBelt: "Yellow", checkpoints: {} });
  done("alpha_a", "Asha Alpha", "Alpha", "2026-09-10");
  done("beta_b", "Bhavin Beta", "Beta", "2026-10-05");
  done("gamma_c", "Chirag Gamma", "Gamma", "2026-10-20");
  const view = async (code = "") => completedNames(await page.run(
    `${code};S.tab='miyagidone';renderMiyagiCompletedTab();return document.getElementById('tab-miyagidone').innerHTML;`));

  for (const u of [users.ad, users.ed, users.office]) {
    await page.signIn(u);
    await page.run(`S.chapters=[{name:'Alpha'},{name:'Beta'},{name:'Gamma'}];setMiyagiDoneFilter('clear');await ensureMiyagiLoaded(true);`);
    assert.deepEqual(await view(), ["Chirag Gamma", "Bhavin Beta", "Asha Alpha"], u.id + ": newest first");
    assert.match(page.el("tab-miyagidone").innerHTML, /All Chapters[\s\S]*All Months[\s\S]*From date[\s\S]*To date/, u.id);
    assert.deepEqual(await view(`setMiyagiDoneFilter('chapter','Beta')`), ["Bhavin Beta"], u.id);
    assert.deepEqual(await view(`setMiyagiDoneFilter('clear');setMiyagiDoneFilter('month','2026-10')`), ["Chirag Gamma", "Bhavin Beta"], u.id);
    assert.match(page.el("tab-miyagidone").innerHTML, /<option value="2026-09">Sep 2026<\/option>/);
    assert.deepEqual(await view(`setMiyagiDoneFilter('clear');setMiyagiDoneFilter('from','2026-09-10');setMiyagiDoneFilter('to','2026-10-05')`), ["Bhavin Beta", "Asha Alpha"], u.id + ": both ends included");
    assert.deepEqual(await view(`setMiyagiDoneFilter('chapter','Gamma')`), [], u.id);
    assert.match(page.el("tab-miyagidone").innerHTML, /No members match these filters/);
  }

  await page.signIn(users.srdc);
  await page.run(`setMiyagiDoneFilter('clear');await ensureMiyagiLoaded(true);`);
  assert.deepEqual(await view(), ["Chirag Gamma", "Asha Alpha"]);
  assert.match(page.el("tab-miyagidone").innerHTML, /All Months/, "Senior DC gets the filters");

  await page.signIn(users.dcBeta);
  await page.run(`await ensureMiyagiLoaded(true);`);
  assert.deepEqual(await view(), ["Bhavin Beta"]);
  assert.doesNotMatch(page.el("tab-miyagidone").innerHTML, /All Months|From date/);
});
