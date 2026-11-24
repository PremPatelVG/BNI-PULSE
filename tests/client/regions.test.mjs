// Two regions on the page: the made-up test region (Alpha, Beta, Gamma - Ahmedabad) and two
// made-up North Gujarat chapters, Kappa and Lambda. The ED / BNI Office pick the region in
// the header switch; an Area Director only ever has their own region.
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

const names = () => page.run(`return visibleChapterNames();`);

test("the ED's region switch filters every chapter list and is remembered", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  const sw = await page.run(`renderAreaSwitch();return document.getElementById('areaSwitch').innerHTML;`);
  assert.match(sw, />Ahmedabad</);
  assert.match(sw, />North Gujarat</);
  assert.doesNotMatch(sw, /Both/, "one region at a time - there is no 'both regions' view");
  assert.deepEqual(await names(), ["Alpha", "Beta", "Gamma"], "Ahmedabad is shown first");
  await page.run(`setAreaView('north-gujarat');`);
  assert.deepEqual(await names(), ["Kappa", "Lambda"]);
  assert.equal(await page.run(`return localStorage.getItem('areaView');`), NG);
  assert.match(await page.run(`return document.getElementById('areaSwitch').innerHTML;`), /class="on" aria-pressed="true"[^>]*>North Gujarat</);
  await page.run(`setAreaView('all');`);
  assert.equal(await page.run(`return areaView();`), NG, "'all' is not a choice");
  await page.run(`setAreaView('mars');`);
  assert.equal(await page.run(`return areaView();`), NG, "an unknown region is ignored");
  // A browser that remembered the old "Both" choice opens on Ahmedabad.
  assert.equal(await page.run(`localStorage.setItem('areaView','all');S.areaView=null;return areaView();`), "ahmedabad");
});

test("switching region clears a chapter picked in the other region", async () => {
  await page.signIn(users.office);
  await page.loadData();
  await page.run(`S.callChapter='Alpha';S.miyagiFilterChapter='Beta';setAreaView('north-gujarat');`);
  assert.equal(await page.run(`return S.callChapter;`), null);
  assert.equal(await page.run(`return S.miyagiFilterChapter;`), "");
});

test("with only one region there is no switch and nothing is filtered", async () => {
  fake.remove("chapters", "Kappa");
  fake.remove("chapters", "Lambda");
  invalidateSnapshotCache();
  await publishCacheStamps();
  await page.signIn(users.ed);
  await page.loadData();
  assert.equal(await page.run(`renderAreaSwitch();return document.getElementById('areaSwitch').innerHTML;`), "");
  assert.deepEqual(await names(), ["Alpha", "Beta", "Gamma"]);
  assert.equal(await page.run(`return document.getElementById('hdrSub').textContent;`), "Regional Leadership Dashboard");
});

test("an Area Director has no switch; their region names the header", async () => {
  await page.signIn(adNorth);
  await page.loadData();
  assert.deepEqual(await names(), ["Kappa", "Lambda"]);
  assert.equal(await page.run(`renderAreaSwitch();return document.getElementById('areaSwitch').innerHTML;`), "");
  assert.equal(await page.run(`return document.getElementById('hdrSub').textContent;`), "North Gujarat - Regional Leadership Dashboard");
});

test("Area Director targets: Ahmedabad's targets, none for North Gujarat", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  const card = (view, total) => page.run(`setAreaView('${view}');return renderAreaDirectorTargets(${total},visibleChapters(),[{chapter:'Alpha',membersClose:30},{chapter:'Kappa',membersClose:20}]);`);
  let html = await card("ahmedabad", 30);
  assert.match(html, /Area Director Targets - Ahmedabad/);
  assert.match(html, /\/ 4404/);
  assert.match(html, /Support Scorecard Target/);
  html = await card(NG, 20);
  assert.match(html, /Members and Movement - North Gujarat/);
  assert.doesNotMatch(html, /4404|Support Scorecard|per quarter/);
  assert.match(html, /No member target is set for North Gujarat/);
});

test("the North Gujarat Area Director's overview has no Ahmedabad targets", async () => {
  await page.signIn(adNorth);
  await page.loadData();
  const html = await page.run(`S.tab='overview';renderOverview();return document.getElementById('tab-overview').innerHTML;`);
  assert.doesNotMatch(html, /4404|Support Scorecard/);
  assert.match(html, /Members and Movement - North Gujarat/);
});

test("Call Mode's previous / next stay inside the region on screen", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  fake.seed("weeklyData", "Gamma_2026-11-18", { chapter: "Gamma", date: "2026-11-18", membersStart: 20 });
  invalidateSnapshotCache(); await publishCacheStamps();
  await page.run(`await refreshSnapshot();setAreaView('ahmedabad');S.callChapter='Gamma';S.tab='call';switchTab('call');`);
  const html = await page.run(`return document.getElementById('callContent').innerHTML;`);
  assert.match(html, /<- Beta/);
  assert.doesNotMatch(html, /Kappa ->/, "Gamma is Ahmedabad's last chapter");
});

test("report rows: an exact chapter name wins over a partial one", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  const got = await page.run(`S.chapters=[{name:'Titans'},{name:'Titan'}];S.areaView='all';return [matchChapterName('India > Somewhere > BNI Titan'),matchChapterName('BNI Titans'),matchChapterName('Titan Club')];`);
  assert.deepEqual(got, ["Titan", "Titans", "Titan"]);
});

test("the ED's uploads cover the region on screen; an AD's cover their own", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  await page.run(`setAreaView('ahmedabad');`);
  assert.deepEqual((await page.run(`return uploadScopeChapters();`)).sort(), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual((await page.run(`return uploadScopeChapters(true);`)).sort(), ["Alpha", "Beta", "Gamma", "Kappa", "Lambda"], "every region, for a TLR that names its region");
  const rows = await page.run(`return filterRowsToScope([{chapter:'Kappa',name:'A',dueDate:'2026-12-01'},{chapter:'Alpha',name:'B',dueDate:'2026-12-01'}]).map(r=>r.chapter);`);
  assert.deepEqual(rows, ["Alpha"], "a North Gujarat row is not taken in the Ahmedabad view");
  await page.run(`setAreaView('north-gujarat');`);
  const ng = await page.run(`return filterRowsToScope([{chapter:'Kappa',name:'A',dueDate:'2026-12-01'},{chapter:'Alpha',name:'B',dueDate:'2026-12-01'},{chapter:'Alphas',name:'C',dueDate:'2026-12-01'}]).map(r=>r.chapter);`);
  assert.deepEqual(ng, ["Kappa"], "nor an Ahmedabad row - or a partly matching name - in North Gujarat's");
  const north = loadPage();
  await north.signIn({ id: "ad-ng", role: "ad", chapter: null, chapters: [] });
  await north.loadData();
  assert.deepEqual(await north.run(`return uploadScopeChapters();`), ["Kappa", "Lambda"]);
});

test("the ED's renewals upload for North Gujarat sends only those chapters: Ahmedabad's renewals stay exactly as the server has them", async () => {
  const ahmedabad = [{ chapter: "Alpha", firstName: "Ravi", lastName: "Shah", name: "Ravi Shah", industry: "Steel", dueDate: "2026-12-01" }];
  fake.seed("meta", "dues", { members: ahmedabad });
  invalidateSnapshotCache(); await publishCacheStamps();
  await page.signIn(users.ed);
  await page.loadData();
  await page.run(`setAreaView('north-gujarat');`);
  // Meanwhile someone else saves a newer Ahmedabad renewal; this page still has the old copy.
  const newer = [...ahmedabad, { chapter: "Beta", firstName: "Mira", lastName: "Jain", name: "Mira Jain", industry: "CA", dueDate: "2026-12-15" }];
  fake.seed("meta", "dues", { ...fake.read("meta", "dues"), members: newer });
  invalidateSnapshotCache(); await publishCacheStamps();
  page.set("readExcelRows", async () => [["Chapter Name", "First Name", "Last Name", "Industry", "Renewal Due"],
    ["BNI Kappa", "Kiran", "Vyas", "Solar", "2026-12-20"], ["BNI Alpha", "Not", "Ours", "Steel", "2026-12-21"]]);
  page.clearLog();
  await page.run(`await handleDuesUpload({files:[{name:'renewals.xls'}],value:'x'});`);
  const sent = page.log.calls.find(c => c.path === "/meta/dues").body.members.map(m => m.chapter);
  assert.deepEqual(sent, ["Kappa"], "only the North Gujarat chapter in the file - the Alpha row is not taken in the North Gujarat view");
  const ahmedabadRecord = fake.read("meta", "dues");
  assert.deepEqual(ahmedabadRecord, { members: newer }, "Ahmedabad's renewals record not written at all - the newer row included, no new header");
  const northRecord = fake.read("meta", "dues-north-gujarat");
  assert.deepEqual(northRecord.members.map(m => m.chapter + " " + m.name), ["Kappa Kiran Vyas"], "North Gujarat's renewals go to its own record");
  // The page still reads one list: both regions' rows.
  const merged = (await page.run(`return (await apiFetch('/meta/dues')).meta.members.map(m=>m.chapter);`)).sort();
  assert.deepEqual(merged, ["Alpha", "Beta", "Kappa"]);
});

test("a TLR upload tells the server the report's region, so a closed chapter's row stays in that region's records", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  await page.run(`setAreaView('north-gujarat');`);
  page.set("readExcelRows", async () => [["Parameters"], ["Region:", "North Gujarat"], ["Year:", "2026"], ["Month:", "November"],
    ["Chapter Name", "Chapter Size", "Member Growth (6 Months)", "Retention", "Referrals", "Visitors", "Conversion", "Absenteeism", "Score"],
    ["BNI Kappa", "40", "1", "70", "1", "1", "10", "5", "60"], ["BNI Omega", "16", "1", "48", "1", "1", "10", "5", "15"]]);
  page.clearLog();
  await page.run(`await handleTLRUpload({files:[{name:'nov.xls'}],value:'x'});`);
  const post = page.log.calls.find(c => c.path === "/tlr-upload");
  assert.equal(post.body.area, NG);
  assert.deepEqual(fake.read("meta", "tlr-north-gujarat").rows.map(r => r.name).sort(), ["Kappa", "Omega"]);
  assert.equal(fake.read("meta", "tlr"), undefined, "no Ahmedabad TLR record written");
});

test("Weekly Data Missed: a chapter that started later is counted only from its start date", async () => {
  await page.signIn(users.ed);
  await page.loadData();
  const rows = await page.run(`S.weeklyData=[];return weeklyMissedRows('2026-10-01','2026-11-23',[{name:'Kappa',day:'Tuesday',weeklyFrom:'2026-11-10'},{name:'Alpha',day:'Tuesday'}]).map(r=>r.chapter+' '+r.week);`);
  assert.deepEqual(rows.filter(r => r.startsWith("Kappa")), ["Kappa 2026-11-17", "Kappa 2026-11-10"]);
  assert.equal(rows.filter(r => r.startsWith("Alpha")).length, 7, "Alpha from 1 Oct, as before");
});

test("the ED's Ahmedabad view: attendance weeks, activity log and the Retrospective total are Ahmedabad's only", async () => {
  fake.seed("attendance", "2026-11-17", { "dc-alpha": true, "dc-alpha_name": "Dev Alpha" });
  fake.seed("attendance", "2026-11-24", { "dc-kappa": true });
  fake.seed("members", "dc-kappa", { name: "Kavi Kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"] });
  invalidateSnapshotCache(); await publishCacheStamps();
  await page.signIn(users.ed);
  await page.loadData();
  await page.run(`setAreaView('ahmedabad');`);
  assert.deepEqual(await page.run(`return Object.keys(S.attendance).filter(attendanceWeekInView).sort();`), ["2026-11-17"]);
  await page.run(`setAreaView('north-gujarat');`);
  assert.deepEqual(await page.run(`return Object.keys(S.attendance).filter(attendanceWeekInView).sort();`), ["2026-11-24"]);
  await page.run(`setAreaView('ahmedabad');S.activityLog=[{action:'tlr_report_uploaded'},{action:'meta_saved',area:'north-gujarat'}];renderActivityLogTab();`);
  assert.match(page.el("tab-activitylog").innerHTML, /1 of 1 shown/);
});
