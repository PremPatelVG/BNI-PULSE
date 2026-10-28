// Integration tests: the real server (src/server.js, Express) runs in its own process on
// the in-memory test database (fixture-server.mjs), and is driven over HTTP and - where
// puppeteer is installed - through a real Chrome, signing in with the login form like a
// person. Run with `npm run test:integration`. Never touches the live database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { currentWeek, today } from "./week.mjs";

let puppeteer = null;
try { puppeteer = (await import("puppeteer")).default; } catch { /* browser checks are skipped */ }
const NO_BROWSER = puppeteer ? false : "puppeteer is not installed - browser checks skipped";

const PIN = "1234", OFFICE_PIN = "9999";
const week = currentWeek();
let BASE, server, serverLog = "", browser;
const pageErrors = [];

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 100));
  }
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "./tests/helpers/setup.mjs", "tests/integration/fixture-server.mjs", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => { serverLog += d; });
  server.stderr.on("data", d => { serverLog += d; });
  await until(async () => (await fetch(BASE + "/healthz").catch(() => null))?.ok, "the server to start");
  if (puppeteer) browser = await puppeteer.launch({ headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function api(method, path, { token, body } = {}) {
  const r = await fetch(`${BASE}/api/${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
async function login(memberId, pin = PIN) {
  const r = await api("POST", "auth/login", { body: { memberId, pin } });
  assert.equal(r.status, 200, `${memberId} signs in`);
  return r.body.token;
}
let adToken;
const weeklyEntry = async (chapter, date) => (await api("GET", "weekly-data", { token: adToken })).body.weeklyData.find(e => e.chapter === chapter && e.date === date);
const miyagiMember = async id => (await api("GET", "miyagiMembers", { token: adToken })).body.rows.find(m => m.id === id);

// ── Browser helpers ───────────────────────────────────────────────────────────
// Each account gets its own browser profile and signs in through the login form.
async function signIn(roleKey, memberId, pin = PIN) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("dialog", d => d.accept());               // the page's own confirm() questions
  page.on("pageerror", e => pageErrors.push(`${memberId}: ${e.message}`));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll("#loginRole option").length > 1);
  await page.select("#loginRole", roleKey);
  await page.waitForFunction(id => [...document.querySelectorAll("#loginName option")].some(o => o.value === id), {}, memberId);
  await page.select("#loginName", memberId);
  await page.type("#loginPin", pin);
  await page.click("#loginBtn");
  await page.waitForSelector("#navBar .nt", { visible: true });
  await page.waitForFunction(() => S.chapters.length > 0 && S.weeklyData.length > 0);
  return page;
}
const openTab = async (page, tab, ready) => {
  await page.click(`.nt[data-tab="${tab}"]`);
  if (ready) await page.waitForSelector(ready);
};
const button = (page, text, within = "") => page.waitForSelector(`::-p-xpath(${within}//button[normalize-space()="${text}"])`, { visible: true });
async function setValue(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.type(String(value));
}
const text = (page, selector) => page.$eval(selector, el => el.innerText);
const toast = page => page.$eval("#toast", el => el.innerText);
// Member names in the Miyagi Completed table, in order.
const completedRows = page => page.$$eval("#tab-miyagidone tbody tr td:first-child", tds => tds.map(td => td.textContent));
// The tick / cross / hourglass shown for each chapter on the Overview's weekly card.
const weekCard = page => page.evaluate(() => {
  const out = {};
  document.querySelectorAll("#weekSubmissionCard span[title]").forEach(s => {
    const name = s.parentElement.previousElementSibling;
    if (name && /submitted|pending/i.test(s.title)) out[name.textContent] = s.title;
  });
  return out;
});

// ── HTTP: the real Express server ─────────────────────────────────────────────
test("server: security headers on the page and the API; API answers are never cached", async () => {
  const page = await fetch(BASE + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);
  const unauth = await api("GET", "snapshot");
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("cache-control"), "no-store");
  // Files on disk are never served: anything unknown gets the dashboard page.
  for (const path of ["/.env", "/src/config.js", "/package.json", "/serviceAccount.json"]) {
    const r = await fetch(BASE + path);
    const body = await r.text();
    assert.match(body, /<!DOCTYPE html>/i, path);
    assert.doesNotMatch(body, /APP_JWT_SECRET|private_key|"dependencies"/, path);
  }
});

test("server: sign-in checks the PIN; a session reaches only its own chapters", async () => {
  assert.equal((await api("POST", "auth/login", { body: { memberId: "dc-alpha", pin: "0000" } })).status, 401);
  adToken = await login("ad-1");
  const office = await login("__srdc__", OFFICE_PIN);
  assert.equal((await api("GET", "auth/me", { token: office })).body.user.role, "ad");
  const dcBeta = await login("dc-beta");
  const rows = (await api("GET", "weekly-data", { token: dcBeta })).body.weeklyData;
  assert.ok(rows.length && rows.every(e => e.chapter === "Beta"));
  assert.deepEqual([...new Set((await api("GET", "miyagiMembers", { token: dcBeta })).body.rows.map(m => m.chapter))], ["Beta"]);
  assert.equal((await api("PUT", "weekly-data/Alpha/2026-10-27", { token: dcBeta, body: { visitors: 1 } })).status, 403);
});

test("server: weekly saves are checked and record who saved them, by name and role", async () => {
  const sa = await login("sa-alpha");
  assert.equal((await api("PUT", "weekly-data/Gamma/2026-10-07", { token: sa, body: { visitors: 1 } })).status, 403, "not their chapter");
  const bad = await api("PUT", "weekly-data/Alpha/2026-10-13", { token: sa, body: { visitors: "<b>5</b>" } });
  assert.equal(bad.status, 400);
  const ok = await api("PUT", "weekly-data/Alpha/2026-10-13", { token: sa, body: { visitors: "6", membersStart: 30, updatedByName: "forged" } });
  assert.equal(ok.status, 200);
  const e = await weeklyEntry("Alpha", "2026-10-13");
  assert.deepEqual([e.visitors, e.updatedBy, e.updatedByName, e.updatedByRole], [6, "sa-alpha", "Alpha SA", "sa1"]);
  const srdc = await login("srdc-1");
  await api("PUT", "weekly-data/Alpha/2026-10-13", { token: srdc, body: { references: 4 } });
  const e2 = await weeklyEntry("Alpha", "2026-10-13");
  assert.deepEqual([e2.visitors, e2.references, e2.updatedByName, e2.updatedByRole], [6, 4, "Sameer Senior", "srdc"], "merged; the Senior DC is now the last saver");
  assert.equal((await api("DELETE", "weekly-data/Alpha/2026-10-13", { token: srdc })).status, 204);
});

test("server: 1-YEAR DONE is a Miyagi status change scoped like any other; its log entries are accepted", async () => {
  const dcAlpha = await login("dc-alpha"), dcBeta = await login("dc-beta");
  const body = { status: "graduated", completedDate: today(), completedBy: "Dev Alpha", finalScore: 0, finalBelt: "No Belt" };
  assert.equal((await api("PUT", "miyagiMembers/alpha_api_member", { token: dcBeta, body })).status, 403);
  assert.equal((await api("PUT", "miyagiMembers/alpha_api_member", { token: dcAlpha, body })).status, 200);
  assert.equal((await miyagiMember("alpha_api_member")).status, "graduated");
  for (const action of ["miyagi_member_completed", "miyagi_completion_undone"]) {
    assert.equal((await api("POST", "activity", { token: dcAlpha, body: { action, details: { memberName: "Api Member" } } })).status, 204, action);
  }
  assert.equal((await api("POST", "activity", { token: dcAlpha, body: { action: "made_up_action" } })).status, 400);
  assert.equal((await api("PUT", "miyagiMembers/alpha_api_member", { token: dcAlpha, body: { status: "active" } })).status, 200);
});

// ── Browser: Data Entry and Call Mode - Override / Cancel ─────────────────────
test("browser: the DC sees the SA's data for the week and must choose Override or Cancel", { skip: NO_BROWSER }, async () => {
  // The SA fills Alpha's week from a blank form: no question asked.
  const sa = await signIn("sa", "sa-alpha");
  await openTab(sa, "entry", "#eVis");
  assert.equal(await sa.$eval("#eDate", el => el.value), week.tue);
  assert.equal(await sa.$eval("#entryWeekNote", el => getComputedStyle(el).display), "none");
  await setValue(sa, "#eVis", 5);
  await setValue(sa, "#eRefs", 12);
  await sa.click("#saveBtn");
  const saved = await until(() => weeklyEntry("Alpha", week.tue), "the SA's save");
  assert.deepEqual([saved.visitors, saved.references, saved.updatedByName, saved.updatedByRole], [5, 12, "Alpha SA", "sa1"]);
  assert.equal(await sa.$("#overrideModal"), null, "no Override question for a new week");

  // The DC opens Data Entry: the SA's numbers are in the form, with who saved them.
  const dc = await signIn("dc", "dc-alpha");
  await openTab(dc, "entry", "#eVis");
  await dc.waitForFunction(() => document.getElementById("eVis").value === "5");
  assert.equal(await dc.$eval("#eRefs", el => el.value), "12");
  assert.match(await text(dc, "#entryWeekNote"), /submitted by Alpha SA \(SA\)/);

  // Cancel leaves the SA's data.
  await setValue(dc, "#eVis", 7);
  await dc.click("#saveBtn");
  await dc.waitForSelector("#overrideModal", { visible: true });
  const question = await text(dc, "#overrideModal");
  assert.match(question, /already submitted/i);
  assert.match(question, /Alpha - meeting on .* submitted by Alpha SA \(SA\)/);
  await (await button(dc, "Cancel", '//div[@id="overrideModal"]')).click();
  await dc.waitForSelector("#overrideModal", { hidden: true });
  assert.match(await toast(dc), /Not saved/);
  assert.equal((await weeklyEntry("Alpha", week.tue)).visitors, 5);

  // Override saves the DC's data; the SA's other numbers stay.
  await dc.click("#saveBtn");
  await (await button(dc, "Override", '//div[@id="overrideModal"]')).click();
  const over = await until(async () => { const e = await weeklyEntry("Alpha", week.tue); return e.visitors === 7 && e; }, "the DC's override");
  assert.deepEqual([over.references, over.updatedByName, over.updatedByRole, over.filledBy], [12, "Dev Alpha", "dc", "Dev Alpha"]);

  // Not by rank: the SA can override the DC in turn. The SA's screen still shows their own
  // save, so saving says the DC changed it since; Cancel then shows the DC's data.
  await setValue(sa, "#eVis", 8);
  await sa.click("#saveBtn");
  await sa.waitForSelector("#overrideModal", { visible: true });
  const stale = await text(sa, "#overrideModal");
  assert.match(stale, /saved again after you opened it/);
  assert.match(stale, /Dev Alpha \(DC\)/);
  await (await button(sa, "Cancel", '//div[@id="overrideModal"]')).click();
  await sa.waitForFunction(() => document.getElementById("eVis").value === "7");
  assert.match(await text(sa, "#entryWeekNote"), /Dev Alpha \(DC\)/);
  assert.equal((await weeklyEntry("Alpha", week.tue)).visitors, 7);
  await setValue(sa, "#eVis", 8);
  await sa.click("#saveBtn");
  await sa.waitForSelector("#overrideModal", { visible: true });
  assert.doesNotMatch(await text(sa, "#overrideModal"), /saved again after you opened it/);
  await (await button(sa, "Override", '//div[@id="overrideModal"]')).click();
  await until(async () => (await weeklyEntry("Alpha", week.tue)).visitors === 8, "the SA's override");
  await sa.browserContext().close();
  await dc.browserContext().close();
});

test("browser: Call Mode quick update asks the same way before replacing the DC's data", { skip: NO_BROWSER }, async () => {
  const srdc = await signIn("srdc", "srdc-2");          // Bina Senior oversees Beta
  await openTab(srdc, "call", "#qu_vis");
  assert.equal(await srdc.$eval("#qu_vis", el => el.value), "4", "the DC's latest numbers");
  await setValue(srdc, "#qu_vis", 6);
  await (await button(srdc, "Save Updates")).click();
  await srdc.waitForSelector("#overrideModal", { visible: true });
  assert.match(await text(srdc, "#overrideModal"), /Dina Beta \(DC\)/);
  await (await button(srdc, "Override", '//div[@id="overrideModal"]')).click();
  const e = await until(async () => { const x = await weeklyEntry("Beta", week.fri); return x.visitors === 6 && x; }, "the quick update");
  assert.deepEqual([e.references, e.updatedByName, e.updatedByRole], [9, "Bina Senior", "srdc"]);
  await srdc.browserContext().close();
});

// ── Browser: Miyagi 1-YEAR DONE and Miyagi Completed ──────────────────────────
test("browser: 1-YEAR DONE moves a member to Miyagi Completed, Undo moves them back; typed names never run as code", { skip: NO_BROWSER }, async () => {
  const dc = await signIn("dc", "dc-alpha");
  await openTab(dc, "miyagi");
  await dc.waitForSelector(`[onclick*="toggleMiyagiExpand('alpha_ravi_shah')"]`);
  assert.match(await text(dc, "#tab-miyagi"), /<img src=x onerror="window.__xss=1">/, "the typed name shows as text");
  await dc.click(`[onclick*="toggleMiyagiExpand('alpha_ravi_shah')"]`);
  await (await button(dc, "1-YEAR DONE")).click();       // confirm() is accepted
  const m = await until(async () => { const x = await miyagiMember("alpha_ravi_shah"); return x.status === "graduated" && x; }, "1-YEAR DONE");
  assert.deepEqual([m.completedDate, m.completedBy, m.finalScore, m.finalBelt, m.score], [today(), "Dev Alpha", 45, "Yellow", 45]);
  await dc.waitForFunction(() => !/Ravi Shah/.test(document.getElementById("tab-miyagi").innerText));

  await openTab(dc, "miyagidone", "#tab-miyagidone tbody");
  assert.deepEqual(await completedRows(dc), ["Ravi Shah", "Asha Patel"], "newest first; the DC sees only Alpha");
  assert.equal(await dc.$("#tab-miyagidone select"), null, "no filters for a chapter account");
  await (await button(dc, "Undo", '//div[@id="tab-miyagidone"]')).click();
  await until(async () => (await miyagiMember("alpha_ravi_shah")).status === "active", "Undo");
  await dc.waitForFunction(() => !/Ravi Shah/.test(document.getElementById("tab-miyagidone").innerText));
  assert.equal(await dc.evaluate(() => window.__xss), undefined, "nothing typed ran as code");
  await dc.browserContext().close();
});

test("browser: Miyagi Completed filters by chapter, month and date range for Senior DC, AD, ED and BNI Office", { skip: NO_BROWSER }, async () => {
  const filter = async (page, i, value) => {
    const selects = await page.$$("#tab-miyagidone select");
    await selects[i].select(value);
    await page.waitForFunction((i, v) => document.querySelectorAll("#tab-miyagidone select")[i].value === v, {}, i, value);
  };
  const dates = (page, from, to) => page.evaluate((from, to) => {
    const set = (i, v) => { const el = document.querySelectorAll("#tab-miyagidone input[type=date]")[i]; el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); };
    set(0, from); set(1, to);
  }, from, to);
  const clear = async page => (await button(page, "Clear filters", '//div[@id="tab-miyagidone"]')).click();

  const srdc = await signIn("srdc", "srdc-1");          // Sameer Senior: Alpha and Gamma
  await openTab(srdc, "miyagidone", "#tab-miyagidone tbody");
  assert.deepEqual(await completedRows(srdc), ["Chirag Shah", "Asha Patel"]);
  await filter(srdc, 0, "Gamma");
  assert.deepEqual(await completedRows(srdc), ["Chirag Shah"]);
  await clear(srdc);
  await filter(srdc, 1, "2026-09");
  assert.deepEqual(await completedRows(srdc), ["Asha Patel"]);
  assert.match(await text(srdc, "#tab-miyagidone"), /Showing 1 of 2/);
  await srdc.browserContext().close();

  for (const [role, id, pin] of [["ad", "ad-1"], ["ed", "ed-1"], ["__master__", "__srdc__", OFFICE_PIN]]) {
    const page = await signIn(role, id, pin);
    await openTab(page, "miyagidone", "#tab-miyagidone tbody");
    assert.deepEqual(await completedRows(page), ["Chirag Shah", "Bhavin Desai", "Asha Patel", `<svg onload="window.__xss=2">`], id + ": the whole region");
    await dates(page, "2026-09-10", "2026-09-30");
    await page.waitForFunction(() => document.querySelectorAll("#tab-miyagidone tbody tr").length === 2);
    assert.deepEqual(await completedRows(page), ["Bhavin Desai", "Asha Patel"], id + ": both ends of the range count");
    await clear(page);
    await filter(page, 0, "Beta");
    assert.deepEqual(await completedRows(page), ["Bhavin Desai", `<svg onload="window.__xss=2">`], id);
    assert.equal(await page.evaluate(() => window.__xss), undefined, id + ": typed names never ran as code");
    await page.browserContext().close();
  }
});

// ── Browser: Overview weekly submission card ──────────────────────────────────
test("browser: the Overview's weekly card follows the chosen week - Senior DC, then AD with a Senior DC filter", { skip: NO_BROWSER }, async () => {
  const pickWeek = async (page, label) => {
    await (await page.waitForSelector(`::-p-xpath(//div[contains(@class,"wchip") and normalize-space()="${label}"])`)).click();
    await page.waitForFunction(l => document.querySelector("#weekSubmissionCard .card-t").innerText.includes(l.toUpperCase()), {}, label);
  };
  const srdc = await signIn("srdc", "srdc-1");
  await srdc.waitForSelector("#weekSubmissionCard .card-t");
  assert.match(await text(srdc, "#weekSubmissionCard .card-t"), /^THIS WEEK/);
  await pickWeek(srdc, "20 Oct - 23 Oct");
  assert.deepEqual(await weekCard(srdc), { Alpha: "Data submitted", Gamma: "Meeting passed - data not submitted" });
  assert.match(await text(srdc, "#tab-overview"), /Gamma - meeting passed, no data yet/);
  await srdc.browserContext().close();

  const ad = await signIn("ad", "ad-1");
  await pickWeek(ad, "20 Oct - 23 Oct");
  assert.deepEqual(await weekCard(ad), { Alpha: "Data submitted", Beta: "Data submitted", Gamma: "Meeting passed - data not submitted" });
  await ad.select("#tab-overview .ad-filter-grid select", "Bina Senior");
  await ad.waitForFunction(() => !/Alpha/.test(document.querySelector("#weekSubmissionCard").innerText));
  assert.deepEqual(await weekCard(ad), { Beta: "Data submitted" });
  await ad.browserContext().close();
});

// ── Browser: Weekly Data Missed report and the Export buttons ─────────────────
// The page's own download (dl) is captured instead of saving a file.
const captureDownloads = page => page.evaluate(() => { window.__dl = null; dl = (content, file) => { window.__dl = { content, file }; }; });
const exportAboveTable = (page, exportSel, tableSel) => page.evaluate((a, b) =>
  !!(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING), exportSel, tableSel);

test("browser: Weekly Data Missed - five columns, one row per missed week, Export above the table", { skip: NO_BROWSER }, async () => {
  const run = async (page, from, to) => {
    await openTab(page, "reports", "#reportType");
    await page.select("#reportType", "weekly_missed");
    await page.waitForSelector("#rFrom");
    await page.evaluate((from, to) => { document.getElementById("rFrom").value = from; document.getElementById("rTo").value = to; }, from, to);
    await (await button(page, "Run Report")).click();
    await page.waitForSelector("#reportContent table");
    return page.$$eval("#reportContent tbody tr", trs => trs.map(tr => [...tr.cells].map(td => td.innerText.trim())));
  };
  const srdc = await signIn("srdc", "srdc-1");           // Sameer Senior: Alpha (Tue) and Gamma (Wed)
  const rows = await run(srdc, "2026-09-29", "2026-10-23");
  assert.deepEqual(await srdc.$$eval("#reportContent thead th", ths => ths.map(th => th.innerText.trim())), ["Chapter Name", "Week", "DC Name", "Sr DC Name", "Meeting Day"]);
  assert.deepEqual(rows.map(r => r[0]), ["Alpha", "Alpha", "Alpha", "Gamma", "Gamma", "Gamma"], "one row per missed week");
  assert.deepEqual(rows[0], ["Alpha", "13 Oct - 16 Oct 2026", "Dev Alpha", "Sameer Senior", "Tuesday"]);
  assert.deepEqual(rows[3], ["Gamma", "20 Oct - 23 Oct 2026", "-", "Sameer Senior", "Wednesday"]);
  assert.ok(await srdc.$eval("#reportExportRow", el => el.offsetParent !== null), "Export is shown");
  assert.ok(await exportAboveTable(srdc, "#reportExportRow", "#reportContent table"), "Export sits above the report");
  await captureDownloads(srdc);
  await (await button(srdc, "Export Report CSV")).click();
  const file = await srdc.evaluate(() => window.__dl);
  assert.match(file.file, /^BNI_Weekly_Data_Missed_\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = file.content.split("\n");
  assert.equal(lines[0], '"Chapter Name","Week","DC Name","Sr DC Name","Meeting Day"');
  assert.equal(lines.length, 7);
  assert.equal(lines[1], '"Alpha","13 Oct - 16 Oct 2026","Dev Alpha","Sameer Senior","Tuesday"');
  await srdc.browserContext().close();

  const ad = await signIn("ad", "ad-1");                  // the whole region adds Beta's three missed weeks
  const all = await run(ad, "2026-09-29", "2026-10-23");
  assert.deepEqual(all.map(r => r[0]), ["Alpha", "Alpha", "Alpha", "Beta", "Beta", "Beta", "Gamma", "Gamma", "Gamma"]);
  assert.deepEqual(all[3], ["Beta", "13 Oct - 16 Oct 2026", "Dina Beta", "Bina Senior", "Friday"]);
  await ad.browserContext().close();

  const dc = await signIn("dc", "dc-alpha");
  await openTab(dc, "reports", "#reportType");
  assert.equal(await dc.$('#reportType option[value="weekly_missed"]'), null, "not offered to chapter accounts");
  await dc.browserContext().close();
});

test("browser: Miyagi Completed Export CSV sits above the list and saves the filtered members", { skip: NO_BROWSER }, async () => {
  const ad = await signIn("ad", "ad-1");
  await openTab(ad, "miyagidone", "#tab-miyagidone tbody");
  assert.ok(await exportAboveTable(ad, `#tab-miyagidone button[onclick="exportMiyagiCompleted()"]`, "#tab-miyagidone table"));
  await (await ad.$$("#tab-miyagidone select"))[0].select("Beta");
  await ad.waitForFunction(() => document.querySelectorAll("#tab-miyagidone tbody tr").length === 2);
  await captureDownloads(ad);
  await (await button(ad, "Export CSV", '//div[@id="tab-miyagidone"]')).click();
  const file = await ad.evaluate(() => window.__dl);
  assert.match(file.file, /^BNI_Miyagi_Completed_\d{4}-\d{2}-\d{2}\.csv$/);
  assert.deepEqual(file.content.split("\r\n"), [
    '"Member","Chapter","Joined","1-Year Done On","Final Belt","Final Score","Marked By"',
    '"Bhavin Desai","Beta","2025-10-20","2026-09-20","Blue","60","Sameer Senior"',
    '"<svg onload=""window.__xss=2"">","Beta","2025-10-20","2026-08-15","Blue","60","Sameer Senior"'
  ]);
  await ad.browserContext().close();
});

test("browser: no script errors on any page visited", { skip: NO_BROWSER }, () => {
  assert.deepEqual(pageErrors, []);
});
