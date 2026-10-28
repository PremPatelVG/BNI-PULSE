import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

// Alpha meets on Tuesdays (DC Dev Alpha), Beta on Fridays (DC Dina Beta), Gamma on
// Wednesdays (no DC); Sameer Senior oversees Alpha and Gamma, Bina Senior oversees Beta.
let page;
beforeEach(async () => {
  await seedRegion();
  const weekly = (chapter, date) => fake.seed("weeklyData", `${chapter}_${date}`, { chapter, date, membersStart: 30 });
  ["2026-09-29", "2026-10-06", "2026-10-20"].forEach(d => weekly("Alpha", d));          // missed 13-16 Oct
  ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23"].forEach(d => weekly("Beta", d)); // missed none
  weekly("Gamma", "2026-10-14");                                                          // missed three
  page = loadPage();
});
const open = async user => { await page.signIn(user); await page.loadData(); };
const missed = (from, to, chapter = "") => page.run(`
  return weeklyMissedRows('${from}','${to}',visibleChapters().filter(c=>!'${chapter}'||c.name==='${chapter}'));`);
const runReport = (from, to, chapter = "") => page.run(`
  document.getElementById('rFrom').value='${from}';document.getElementById('rTo').value='${to}';document.getElementById('rChap').value='${chapter}';
  runWeeklyMissedReport();return document.getElementById('reportContent').innerHTML;`);

test("Weekly Data Missed: one row per chapter per missed week, by chapter then newest week", async () => {
  await open(users.ad);
  const rows = await missed("2026-09-29", "2026-10-23");
  assert.deepEqual(rows.map(r => `${r.chapter} ${r.week}`), ["Alpha 2026-10-13", "Gamma 2026-10-20", "Gamma 2026-10-06", "Gamma 2026-09-29"]);
  assert.deepEqual(rows[0], { chapter: "Alpha", week: "2026-10-13", dc: "Dev Alpha", srdc: "Sameer Senior", day: "Tuesday" });
  assert.deepEqual(rows[1], { chapter: "Gamma", week: "2026-10-20", dc: "-", srdc: "Sameer Senior", day: "Wednesday" });
  assert.deepEqual((await missed("2026-09-29", "2026-10-23", "Gamma")).length, 3, "chapter filter");
  // A meeting outside the range is not counted: Gamma's 30 Sep meeting is before 1 Oct.
  assert.deepEqual((await missed("2026-10-01", "2026-10-23")).map(r => `${r.chapter} ${r.week}`), ["Alpha 2026-10-13", "Gamma 2026-10-20", "Gamma 2026-10-06"]);
});

test("Weekly Data Missed: weeks before the region went live, and meetings not held yet, are not counted", async () => {
  await open(users.ad);
  await page.run(`S.weeklyData=[];`);
  const rows = await missed("2026-08-01", "2026-09-12");
  assert.ok(rows.length && rows.every(r => r.week >= "2026-09-01"), "nothing before 1 Sep 2026");
  assert.equal(rows.length, 6, "two weeks x three chapters");
  // On Wednesday 21 Oct only Alpha's Tuesday meeting has passed; today's and Friday's have not.
  const thisWeek = await page.run(`const real=todayISO;todayISO=()=>'2026-10-21';
    try{return weeklyMissedRows('2026-10-20','2026-10-23',visibleChapters()).map(r=>r.chapter);}finally{todayISO=real;}`);
  assert.deepEqual(thisWeek, ["Alpha"]);
});

test("Weekly Data Missed: the report table has the five columns asked for; Senior DCs see only their chapters", async () => {
  await open(users.srdc);
  await page.run(`S.tab='reports';renderReportTab();document.getElementById('reportType').value='weekly_missed';renderReport();`);
  const html = await runReport("2026-09-29", "2026-10-23");
  const heads = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ["Chapter Name", "Week", "DC Name", "Sr DC Name", "Meeting Day"]);
  const rows = [...html.matchAll(/<tr><td style="font-weight:700">([^<]*)<\/td><td[^>]*>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map(m => m.slice(1));
  assert.deepEqual(rows, [
    ["Alpha", "13 Oct - 16 Oct 2026", "Dev Alpha", "Sameer Senior", "Tuesday"],
    ["Gamma", "20 Oct - 23 Oct 2026", "-", "Sameer Senior", "Wednesday"],
    ["Gamma", "6 Oct - 9 Oct 2026", "-", "Sameer Senior", "Wednesday"],
    ["Gamma", "29 Sept - 2 Oct 2026", "-", "Sameer Senior", "Wednesday"]   // en-IN writes September as "Sept"
  ], "Beta belongs to another Senior DC");
  assert.match(html, /4 missed weeks across 2 chapters/);
  assert.equal(page.el("reportExportRow").style.display, "flex", "export offered");
});

test("Reports: the export button sits above the report; Weekly Data Missed is for Senior DC, AD, ED and BNI Office only", async () => {
  for (const [u, offered] of [[users.srdc, true], [users.ad, true], [users.ed, true], [users.office, true], [users.dcAlpha, false], [users.saAlpha, false], [users.viewer, false]]) {
    await open(u);
    const html = await page.run(`S.tab='reports';renderReportTab();return document.getElementById('tab-reports').innerHTML;`);
    assert.ok(html.indexOf('id="reportExportRow"') < html.indexOf('id="reportContent"'), u.id + ": export above the report");
    assert.equal(html.includes('value="weekly_missed"'), offered, u.id);
  }
});

test("Miyagi Completed: Export CSV sits above the list and saves exactly the filtered members", async () => {
  const done = (id, name, chapter, completedDate) => fake.seed("miyagiMembers", id, { name, chapter, status: "graduated", completedDate, joinDate: "2025-09-01", finalScore: 40, finalBelt: "Yellow", completedBy: "Sameer Senior", checkpoints: {} });
  done("alpha_a", "Asha, \"AP\" Alpha", "Alpha", "2026-09-10");
  done("beta_b", "Bhavin Beta", "Beta", "2026-10-05");
  await open(users.ad);
  await page.run(`S.chapters=[{name:'Alpha'},{name:'Beta'},{name:'Gamma'}];setMiyagiDoneFilter('clear');await ensureMiyagiLoaded(true);
    globalThis.__dl=null;dl=function(c,f,t){globalThis.__dl={c:c,f:f,t:t};};`);
  const html = await page.run(`S.tab='miyagidone';renderMiyagiCompletedTab();return document.getElementById('tab-miyagidone').innerHTML;`);
  assert.ok(html.indexOf("exportMiyagiCompleted()") > 0 && html.indexOf("exportMiyagiCompleted()") < html.indexOf("<table"), "button above the list");
  const file = await page.run(`setMiyagiDoneFilter('chapter','Alpha');exportMiyagiCompleted();return globalThis.__dl;`);
  assert.match(file.f, /^BNI_Miyagi_Completed_\d{4}-\d{2}-\d{2}\.csv$/);
  assert.deepEqual(file.c.split("\r\n"), [
    '"Member","Chapter","Joined","1-Year Done On","Final Belt","Final Score","Marked By"',
    '"Asha, ""AP"" Alpha","Alpha","2025-09-01","2026-09-10","Yellow","40","Sameer Senior"'
  ]);
});
