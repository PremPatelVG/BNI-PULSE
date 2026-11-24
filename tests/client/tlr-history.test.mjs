// The TLR history on the page: chapters with no weekly entries yet (a newly added region)
// show their past TLR months in Call Mode, the SD Report, Retention, the Overview and the
// Retrospective. Made-up chapters and figures: Kappa and Lambda are a made-up North
// Gujarat; Lambda first appears in the October report, so it started during the year.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, PIN } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
const h = (monthIso, name, size, score, retention, extra = {}) =>
  ({ monthIso, name, chapterSize: String(size), score: String(score), retention: String(retention), referrals: "1.10", visitors: "1.50", conversion: "20.00", absenteeism: "6.00", memberGrowth: "2.00", ...extra });
let page;

// North Gujarat's TLR and its history are kept in its own records (meta/tlr-north-gujarat,
// meta/tlrHistory-north-gujarat); Ahmedabad's are meta/tlr and meta/tlrHistory.
beforeEach(async () => {
  await seedRegion();
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("chapters", "Lambda", { name: "Lambda", day: "Thursday", order: 11, area: NG });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash: bcrypt.hashSync(PIN, 4) });
  fake.seed("meta", "tlrHistory-north-gujarat", { months: ["2026-09", "2026-10", "2026-11"], rows: [
    h("2026-09", "Kappa", 38, 60, 70), h("2026-10", "Kappa", 40, 65, 72), h("2026-11", "Kappa", 43, 80, 78, { absenteeism: "5.00" }),
    h("2026-10", "Lambda", 9, 30, 0), h("2026-11", "Lambda", 12, 45, 55)
  ] });
  fake.seed("meta", "tlr-north-gujarat", { reportMonth: "2026-11", rows: [h("2026-11", "Kappa", 43, 80, 78), h("2026-11", "Lambda", 12, 45, 55)] });
  invalidateSnapshotCache();
  await publishCacheStamps();
  page = loadPage();
  await page.signIn(users.ed);
  await page.loadData();
  await page.run(`setAreaView('north-gujarat');`);
});

test("Call Mode: a chapter with no weekly entries shows its TLR history", async () => {
  const html = await page.run(`S.callChapter='Kappa';S.tab='call';renderCallMode();return document.getElementById('callContent').innerHTML;`);
  assert.match(html, /No weekly entries yet - showing the chapter's TLR history \(3 months, Sep 26 – Nov 26\)/);
  assert.match(html, /TLR for Nov 26/);
  assert.match(html, /class="call-val">43<\/div><div class="call-lbl">MEMBERS/);
  assert.match(html, /▲ \+3<\/span> <span style="opacity:.4">vs Oct 26/, "members against the month before");
  assert.match(html, />\+5<\/div><div class="call-lbl">CHANGE SINCE SEP 26/);
  assert.match(html, /class="pos">▼ 1.0%<\/span>/, "lower absenteeism is good news");
  assert.match(html, /12-MONTH TLR HISTORY \(Sep 26 – Nov 26\)/);
  assert.match(html, /Lambda ->/, "previous / next still work");
  assert.doesNotMatch(html, /No data yet/);
});

test("Call Mode: with weekly entries the TLR history sits, collapsed, under the 8-week trends", async () => {
  fake.seed("weeklyData", "Kappa_2026-11-17", { chapter: "Kappa", date: "2026-11-17", membersStart: 43, membersClose: 43 });
  invalidateSnapshotCache(); await publishCacheStamps();
  const html = await page.run(`await refreshSnapshot();S.callChapter='Kappa';S.tab='call';renderCallMode();return document.getElementById('callContent').innerHTML;`);
  assert.doesNotMatch(html, /No weekly entries yet/);
  assert.match(html, /8-WEEK TRENDS/);
  assert.match(html, /12-MONTH TLR HISTORY \(Sep 26 – Nov 26\) v<\/div><div class="hidden">/);
});

test("SD Report: the TLR months are listed, and the month's TLR fills chapters without weekly entries", async () => {
  const html = await page.run(`S.tab='sdreport';renderSDReport();return document.getElementById('tab-sdreport').innerHTML;`);
  assert.match(html, /<option value="2026-11" selected>/);
  assert.match(html, /<option value="2026-09">/);
  assert.match(html, /Kappa<div class="tm"[^>]*>from the Nov 26 TLR<\/div>/);
  // Current 43, previous month 40, no inductions / drops in a TLR, net +3
  assert.match(html, /Kappa<div[^<]*<\/div><\/td><td>[^<]*<\/td><td[^>]*>[^<]*<\/td><td style="font-weight:700">43<\/td><td style="color:var\(--muted\);">40<\/td><td style="color:var\(--green\);"><span class="tm">–<\/span><\/td><td style="color:var\(--red\);"><span class="tm">–<\/span><\/td><td style="font-weight:800;color:var\(--green\)">\+3<\/td>/);
  assert.match(html, /2 chapters have no weekly entries for/);
  assert.match(html, /<td>TOTAL<\/td><td><\/td><td><\/td><td>55<\/td><td>49<\/td><td style="color:var\(--green\);"><span class="tm">–<\/span><\/td><td style="color:var\(--red\);"><span class="tm">–<\/span><\/td>/, "no inductions or drops behind the totals either");
  assert.match(html, /Month-wise Members \(TLR history\)/);
  // Lambda's first month is October: no change shown for it before then
  const oct = await page.run(`document.getElementById('sdReportMonth').value='2026-10';renderSDReport();return document.getElementById('tab-sdreport').innerHTML;`);
  assert.match(oct, /Lambda<div class="tm"[^>]*>from the Oct 26 TLR<\/div>/);
});

test("Retention: BNI's retention from the TLR history, per chapter and for the region", async () => {
  const html = await page.run(`S.tab='retention';renderAreaDirectorRetentionTab();return document.getElementById('tab-retention').innerHTML;`);
  assert.match(html, /Chapter Retention \(BNI TLR\)/);
  // (78*43 + 55*12) / 55 = 73.0
  assert.match(html, /Region \(Nov 26\)<\/div><div class="month-val" style="color:var\(--green\)">73.0%/);
  assert.match(html, /Kappa<\/td>.*?>78%<\/td><td style="color:var\(--green\)">\+6 pts<\/td>/s);
  assert.match(html, /Lambda<\/td>.*?>55%<\/td>/s);
});

test("Retention: a new chapter's 0% (no renewals yet) is labelled and left out of the region figure", async () => {
  const rows = fake.read("meta", "tlrHistory-north-gujarat").rows.map(r => r.name === "Lambda" && r.monthIso === "2026-11" ? { ...r, retention: "0.00", memberGrowth: "12.00" } : r);
  fake.seed("meta", "tlrHistory-north-gujarat", { months: ["2026-09", "2026-10", "2026-11"], rows });
  invalidateSnapshotCache(); await publishCacheStamps();
  const html = await page.run(`await refreshSnapshot();S.tab='retention';renderAreaDirectorRetentionTab();return document.getElementById('tab-retention').innerHTML;`);
  assert.match(html, /Lambda<div class="tm" style="font-size:10px;">no renewals yet<\/div>/);
  assert.match(html, /Region \(Nov 26\)<\/div><div class="month-val" style="color:var\(--green\)">78.0%/, "Kappa alone");
  assert.match(html, /Below 60%<\/div><div class="month-val" style="color:var\(--red\)">0</);
  assert.match(html, /Not in the region figure or the counts: Lambda/);
});

test("Retention history: months the TLR shows 0% (no renewals yet) are not counted as 0", async () => {
  // Like a chapter in its first year: 0% for months, then BNI's first real figure.
  const rows = fake.read("meta", "tlrHistory-north-gujarat").rows.map(r => r.name === "Kappa" && r.monthIso === "2026-09" ? { ...r, retention: "0.00" }
    : r.name === "Lambda" && r.monthIso === "2026-10" ? { ...r, retention: "0.00" } : r);
  fake.seed("meta", "tlrHistory-north-gujarat", { months: ["2026-09", "2026-10", "2026-11"], rows });
  invalidateSnapshotCache(); await publishCacheStamps();
  const html = await page.run(`await refreshSnapshot();S.tab='retention';renderAreaDirectorRetentionTab();return document.getElementById('tab-retention').innerHTML;`);
  // Kappa: 0 (Sep), 72 (Oct), 78 (Nov) -> average 75.0 over 2 months, lowest 72% in October
  assert.match(html, /Kappa<\/td>.*?>78%<\/td><td style="color:var\(--green\)">\+6 pts<\/td><td style="color:var\(--green\)">75.0%<div class="tm" style="font-size:10px;">2 months measured<\/div><\/td><td><span style="color:var\(--green\)">72%<\/span> <span class="tm" style="font-size:10px;">Oct 26<\/span>/s);
  assert.match(html, /title="Sep 26: 0% - no renewals yet"/);
  // Lambda: 0 (Oct) then 55 (Nov) - no change is worked out from the 0
  assert.match(html, /Lambda<\/td>.*?>55%<\/td><td style="color:var\(--muted\)">–<\/td><td style="color:var\(--red\)">55.0%/s);
  const call = await page.run(`S.callChapter='Lambda';S.tab='call';renderCallMode();return document.getElementById('callContent').innerHTML;`);
  assert.match(call, /55%<\/div><div class="call-lbl">RETENTION<\/div><div class="call-delta"><span style="opacity:.4">first month measured<\/span>/);
  const kappa = await page.run(`S.callChapter='Kappa';renderCallMode();return document.getElementById('callContent').innerHTML;`);
  assert.match(kappa, /Sep 26<\/td>(<td[^>]*>.*?<\/td>){3}<td[^>]*><span style="color:var\(--muted\);font-weight:700;">0%<\/span>/, "shown, greyed, in the month table");
});

test("Overview: the region's cumulative net comes from the TLR history; a chapter that started during the year counts from 0", async () => {
  const html = await page.run(`return renderAreaDirectorTargets(55,visibleChapters(),[]);`);
  assert.match(html, /Members and Movement - North Gujarat/);
  assert.match(html, /since Sep 26 · 2 chapters · from the region TLRs/);
  // Kappa 38 -> 43, Lambda 0 -> 12
  assert.match(html, />\+17<\/div>\s*<div[^>]*>38 → 55<\/div>/);
  assert.match(html, /Launched during the year, counted from 0: Lambda \(Oct 26\)/);
  assert.match(html, /with its Sep 26 size \(from the region TLRs/, "the note names the start month used");
  // No weekly entries at all yet: the members come from the current TLR, not 0
  const fresh = await page.run(`return renderAreaDirectorTargets(0,visibleChapters(),[]);`);
  assert.match(fresh, /line-height:1;">55<\/div>/);
  assert.match(fresh, /from the Nov 26 TLR - no weekly entries yet/);
});

test("Retrospective: another region's month-wise totals stay out; the TLR history is shown instead", async () => {
  fake.seed("meta", "monthlyMembers", { baselineMonth: "2026-09", months: ["2026-09"], region: [{ month: "2026-09", chapters: 3, members: 999, joins: null, drops: null, net: null }],
    baseline: 999, window: { start: "2026-09", end: "2026-09" }, perChapter: [{ chapter: "Alpha", sizes: { "2026-09": 30 }, joins: 0, drops: 0, net: 0 }] });
  invalidateSnapshotCache(); await publishCacheStamps();
  const html = await page.run(`await refreshSnapshot();S.tab='retro';renderRetroTab();return document.getElementById('tab-retro').innerHTML;`);
  assert.doesNotMatch(html, /999/, "Ahmedabad's totals are not North Gujarat's");
  assert.match(html, /Month-wise Members \(TLR history\)/);
  const ahm = await page.run(`setAreaView('ahmedabad');S.tab='retro';renderRetroTab();return document.getElementById('tab-retro').innerHTML;`);
  assert.match(ahm, /Month-wise Members \(Reference\)/);
});

test("Upload: several TLR files at once go up oldest first, after one confirmation", async () => {
  const file = (month, size) => ({ name: month + ".xls", rows: [["Region ► Traffic Lights Report"], ["Year:", "2026"], ["Month:", month],
    ["Chapter Name", "Chapter Size", "Member Growth (6 Months)", "Retention", "Referrals", "Visitors", "Conversion", "Absenteeism", "Score"],
    ["BNI Kappa", String(size), "1", "70", "1", "1", "10", "5", "60"]] });
  page.set("readExcelRows", async f => f.rows);
  page.clearLog();
  await page.run(`await handleTLRUpload({files:globalThis.__files,value:'x'});`.replace("globalThis.__files", JSON.stringify([file("August", 36), file("July", 35)])));
  assert.equal(page.log.confirms.length, 1);
  assert.match(page.log.confirms[0], /Upload 2 TLR months: July 2026, August 2026\?/);
  assert.doesNotMatch(page.log.confirms[0], /more than once/);
  const posts = page.log.calls.filter(c => c.path === "/tlr-upload").map(c => c.body.monthIso);
  assert.deepEqual(posts, ["2026-07", "2026-08"], "oldest first");
  assert.match(page.el("tlrStatus").textContent, /Saved 2 TLR months to the history/);
  assert.deepEqual(fake.read("meta", "tlrHistory-north-gujarat").months, ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.equal(fake.read("meta", "tlr-north-gujarat").rows.find(r => r.name === "Kappa").monthIso, "2026-11", "the current TLR stays on November");
});

test("Upload: a month picked twice is uploaded once, and the confirmation says whether the copies differ", async () => {
  const file = (month, size) => ({ name: month + size + ".xls", rows: [["Year:", "2026"], ["Month:", month],
    ["Chapter Name", "Chapter Size", "Member Growth (6 Months)", "Retention", "Referrals", "Visitors", "Conversion", "Absenteeism", "Score"],
    ["BNI Kappa", String(size), "1", "70", "1", "1", "10", "5", "60"]] });
  page.set("readExcelRows", async f => f.rows);
  page.clearLog();
  const pick = files => page.run(`await handleTLRUpload({files:${JSON.stringify(files)},value:'x'});`);
  await pick([file("March", 30), file("February", 29), file("March", 30), file("February", 28)]);
  assert.equal(page.log.confirms.length, 1);
  assert.match(page.log.confirms[0], /Upload 2 TLR months: February 2026, March 2026\?/);
  assert.match(page.log.confirms[0], /Picked more than once: February 2026 \(2 files, DIFFERENT figures - the last one picked is used\), March 2026 \(2 files, the same figures\)/);
  assert.deepEqual(page.log.calls.filter(c => c.path === "/tlr-upload").map(c => c.body.monthIso), ["2026-02", "2026-03"], "one upload per month");
  assert.equal(fake.read("meta", "tlrHistory-north-gujarat").rows.find(r => r.name === "Kappa" && r.monthIso === "2026-02").chapterSize, "28", "the file picked last");
  assert.match(page.el("tlrStatus").textContent, /Saved 2 TLR months to the history \(February 2026: 1 · March 2026: 1 chapters\)/);
});
