import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
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

test("Length of Membership sync: chapter + first + last name; new members keep BNI's start date", async () => {
  page.ctx.__lom = [
    { chapter: "Alpha", firstName: "RAVI", lastName: "SHAH", name: "RAVI SHAH", recentMonths: 4, recentStart: "2026-06-01", cumulativeStart: "2026-06-01" },
    { chapter: "Alpha", firstName: "Neha", lastName: "Rao", name: "Neha Rao", recentMonths: 2, recentStart: "2026-08-01", cumulativeStart: "2026-08-01", cumulativeLength: "0 years (2 months)" },
    { chapter: "Alpha", firstName: "Neha", lastName: "Rao", name: "Neha Rao", recentMonths: 2, recentStart: "2026-08-01", cumulativeStart: "2026-08-01" },
    { chapter: "Alpha", firstName: "Old", lastName: "Timer", name: "Old Timer", recentMonths: 40, recentStart: "2023-01-01", cumulativeStart: "2023-01-01" },
    { chapter: "Beta", firstName: "Out", lastName: "Ofscope", name: "Out Ofscope", recentMonths: 1, recentStart: "2026-09-01", cumulativeStart: "2026-09-01" }
  ];
  await page.run(`S.chapters=[{name:'Alpha'}];document.getElementById('lomStatus').textContent='Uploaded 5 members';await syncMiyagiMembers(globalThis.__lom);`);
  const all = fake.all("miyagiMembers").map(m => m.id).sort();
  assert.deepEqual(all, ["alpha_neha_rao", "alpha_ravi_shah", "beta_mira_jain"], "Ravi skipped, Neha once, over-12 and other chapter not added");
  const neha = fake.read("miyagiMembers", "alpha_neha_rao");
  assert.deepEqual([neha.firstName, neha.lastName, neha.cumulativeStart, neha.joinDate, neha.score], ["Neha", "Rao", "2026-08-01", "2026-08-01", 0]);
  assert.equal(fake.read("miyagiMembers", "alpha_ravi_shah").score, 5, "existing progress untouched");
  assert.match(page.el("lomStatus").textContent, /1 new member added, 2 already in the program \(skipped\)/);
});
