// The page's report parsers, fed rows shaped exactly like BNI Connect exports (made-up
// names). Rows are what the page's spreadsheet reader hands the parsers: arrays of cells.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "../helpers/page.mjs";

let page;
const CHAPTERS = [{ name: "Alpha" }, { name: "BNI Beta" }, { name: "Gamma" }, { name: "BNI Hera" }];
before(async () => {
  page = loadPage();
  page.set("__chapters", CHAPTERS);
  await page.run(`S.chapters=globalThis.__set___chapters;S.user={role:'ad',chapters:[]};`);
});
const parse = (fn, rows) => { page.ctx.__rows = rows; return page.run(`return ${fn}(globalThis.__rows);`); };

test("toIsoDate: the date shapes found in BNI exports", async () => {
  const r = await page.run(`return [
    toIsoDate('2026-11-01T00:00:00.000'), toIsoDate('2026-11-01'), toIsoDate('15/08/2026'), toIsoDate('15-08-26'),
    toIsoDate('15 Aug 2026'), toIsoDate(46249), toIsoDate(''), toIsoDate(null)
  ];`);
  assert.deepEqual(r, ["2026-11-01", "2026-11-01", "2026-08-15", "2026-08-15", "2026-08-15", "2026-08-15", "", ""]);
});

test("matchChapterName: region prefix, 'BNI', case and partial names", async () => {
  const r = await page.run(`return ['Ahmedabad East > Alpha','BNI Alpha','alpha','Beta','BNI BETA','Hera','Ahmedabad West > BNI Hera','Omega'].map(matchChapterName);`);
  assert.deepEqual(r, ["Alpha", "Alpha", "Alpha", "BNI Beta", "BNI Beta", "BNI Hera", "BNI Hera", "Omega"]);
});

test("dues: BNI Membership Dues report - both name columns headed 'Sort First'", async () => {
  const rows = [
    ["Region ► Membership Dues Report"], ["Running User", "Run At"], [],
    ["Chapter Name", "Sort First", "Sort First", "Industry", "Type", "Membership Status", "Due Date", "AutoRenewal Enabled"],
    ["Ahmedabad East > Alpha", "Ravi B", "Desai", "Printing Products", "Member", "Active", "2026-11-01T00:00:00.000", "N"],
    ["Ahmedabad West > BNI Beta", "Mira", "Shah", "Chartered Accountant", "President, Member", "Active", "2027-03-01T00:00:00.000", "Y"],
    ["Ahmedabad East > Gamma", "Old", "Member", "Retail", "Member", "Expired", "2026-08-01T00:00:00.000", "N"]
  ];
  const out = await parse("parseDuesRows", rows);
  assert.equal(out.length, 2, "only Active members");
  assert.deepEqual(out[0], { chapter: "Alpha", name: "Ravi B Desai", firstName: "Ravi B", lastName: "Desai", industry: "Printing Products", type: "Member", status: "Active", dueDate: "2026-11-01", phone: "" });
  assert.equal(out[1].chapter, "BNI Beta");
  assert.equal(out[1].lastName, "Shah", "last name read from the second 'Sort First' column");
});

test("dues: BNI Upcoming Renewals report - First/Last Name, Company, phone", async () => {
  const rows = [
    ["Chapter", "First Name", "Last Name", "Company", "Renewal Date", "Email Address", "Address", "Phone Number"],
    ["BNI Hera", "Jay", "Bhatt", "Jay Traders", "2026-11-01T00:00:00.000", "jay@example.com", "Somewhere", "9800000000"]
  ];
  const [r] = await parse("parseDuesRows", rows);
  assert.equal(r.chapter, "BNI Hera");
  assert.equal(r.name, "Jay Bhatt");
  assert.equal(r.industry, "Jay Traders", "Company is the business field here");
  assert.equal(r.phone, "9800000000");
  assert.equal(r.dueDate, "2026-11-01");
});

test("dues: a single full-name column is split into first / last", async () => {
  const [r] = await parse("parseDuesRows", [["Chapter", "Member Name", "Industry", "Due Date"], ["Alpha", "Dr Asha  K  Patel", "Dentist", "2026-12-01"]]);
  assert.equal(r.firstName, "Dr");
  assert.equal(r.lastName, "Asha K Patel");
  assert.equal(r.name, "Dr Asha K Patel");
});

const tlrHeader = ["Chapter Name", "Chapter Size", "Member Growth (6 Months)", "Retention", "Referrals", "Visitors", "Conversion", "Absenteeism", "Score"];

test("TLR: West layout (value next to the label)", async () => {
  const rows = [["Region ► Traffic Lights Report"], ["Parameters"], ["Region:", "Ahmedabad West"], ["Year:", "2026"], ["Month:", "October"], tlrHeader,
    ["Alpha", "99", "11", "68", "1.21", "2.6", "27.69", "3.9", "95"], ["Gamma", "40", "2", "70", "1", "1.5", "20", "5", "70"], ["Total", "139"]];
  const p = await parse("parseTLRExcelRows", rows);
  assert.equal(p.monthIso, "2026-10");
  assert.equal(p.monthLabel, "October 2026");
  assert.deepEqual(p.rows.map(r => r.name), ["Alpha", "Gamma"], "total row ignored");
  assert.equal(p.rows[0].score, "95");
  assert.equal(p.rows[0].conversion, "27.69");
});

test("TLR: East layout (value several columns after the label, gaps between columns)", async () => {
  const gap = h => h.flatMap((x, i) => (i === 1 || i === 3 ? [x, ""] : [x]));
  const rows = [["Region ► Traffic Lights Report", "", "", ""], ["Parameters"], ["Region:", "", "", "", "", "", "", "Ahmedabad East"],
    ["Year:", "", "", "", "", "", "", "2026"], ["Month:", "", "", "", "", "", "", "October"],
    gap(tlrHeader), gap(["BNI Beta", "83.00", "27.00", "88.00", "1.54", "3.29", "37.97", "3.38", "100"])];
  const p = await parse("parseTLRExcelRows", rows);
  assert.equal(p.monthIso, "2026-10");
  assert.equal(p.rows.length, 1);
  assert.deepEqual([p.rows[0].name, p.rows[0].chapterSize, p.rows[0].memberGrowth, p.rows[0].score], ["BNI Beta", "83.00", "27.00", "100"]);
});

test("TLR: clear errors for the wrong file", async () => {
  await assert.rejects(parse("parseTLRExcelRows", [["Year:", "2026"], ["Month:", "October"], ["Name", "Value"]]), /Chapter Name \.\.\. Score/);
  await assert.rejects(parse("parseTLRExcelRows", [["Year:", ""], ["Month:", "Octember"], tlrHeader, ["Alpha", "1", "1", "1", "1", "1", "1", "1", "1"]]), /Month\/Year/);
  await assert.rejects(parse("parseTLRExcelRows", [["Year:", "2026"], ["Month:", "October"], tlrHeader, ["Total", "1"]]), /No chapter rows/);
});

test("TLR: duplicate chapter rows collapse to the fullest one", async () => {
  const r = await page.run(`return dedupeTlrRows([{name:'Alpha',score:'80'},{name:'Alpha',score:'80',conversion:'20'},{name:'Gamma'}]);`);
  assert.equal(r.length, 2);
  assert.equal(r[0].conversion, "20");
});

test("Length of Membership: columns, lengths, rejoined members", async () => {
  const rows = [["Region ► Length of Membership Report"], [],
    ["Chapter Name", "First Name", "Last Name", "Cumulative Length", "Cumulative Start Date", "Recent Length", "Recent Start Date"],
    ["Alpha", "Asha", "Patel", "0 years (3 months)", "2026-07-01T00:00:00.000", "0 years (3 months)", "2026-07-01T00:00:00.000"],
    ["Ahmedabad West > Gamma", "Ravi", "Shah", "5 years (1 month)", "2021-07-01T00:00:00.000", "2 years (1 month)", "2024-08-01T00:00:00.000"]];
  const out = await parse("parseLOMRows", rows);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].chapter, out[0].firstName, out[0].lastName, out[0].name, out[0].recentMonths, out[0].cumulativeStart, out[0].recentStart],
    ["Alpha", "Asha", "Patel", "Asha Patel", 3, "2026-07-01", "2026-07-01"]);
  assert.deepEqual([out[1].chapter, out[1].recentMonths, out[1].cumulativeLength, out[1].cumulativeStart], ["Gamma", 25, "5 years (1 month)", "2021-07-01"]);
});

test("parseLengthMonths and cleanMemberNameForChapter", async () => {
  const r = await page.run(`return [parseLengthMonths('0 years (11 months)'),parseLengthMonths('3 years (5 months)'),parseLengthMonths('2 years and 4 months'),
    parseLengthMonths('7 months'),parseLengthMonths(14),parseLengthMonths(''),
    cleanMemberNameForChapter('Ravi Shah - Alpha','Alpha'),cleanMemberNameForChapter('Ravi Shah BNI Alpha','Alpha'),cleanMemberNameForChapter('  Ravi   Shah ','Alpha')];`);
  assert.deepEqual(r, [11, 41, 28, 7, 14, null, "Ravi Shah", "Ravi Shah", "Ravi Shah"]);
});
