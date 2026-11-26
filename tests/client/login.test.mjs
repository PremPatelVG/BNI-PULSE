// The login page: shortcut tiles for the Executive Director and the BNI Office, then
// region -> role -> name -> password for everyone else. Made-up chapters and people:
// Alpha / Beta / Gamma (Ahmedabad) and Kappa / Lambda (North Gujarat).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, PIN, OFFICE_PIN } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

const NG = "north-gujarat";
let page;

beforeEach(async () => {
  await seedRegion();
  const pinHash = bcrypt.hashSync(PIN, 4);
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: NG });
  fake.seed("chapters", "Lambda", { name: "Lambda", day: "Thursday", order: 11, area: NG });
  fake.seed("members", "ad-ng", { name: "Nisha North", role: "ad", area: NG, pinHash });
  fake.seed("members", "dc-kappa", { name: "Kavi Kappa", role: "dc", chapter: "Kappa", chapters: ["Kappa"], pinHash });
  invalidateSnapshotCache();
  await publishCacheStamps();
  page = loadPage();
  page.set("startApp", () => { page.ctx.__started = (page.ctx.__started || 0) + 1; });
  await page.run(`await buildLoginDD();`);
});

// Options appended to a select in the test page (its innerHTML is not parsed).
const options = id => page.el(id).children.map(o => o.value + "|" + o.textContent);
const choose = async (fn, arg) => { page.el("loginRole").children.length = 0; page.el("loginName").children.length = 0; await page.run(`${fn}(${JSON.stringify(arg)});`); };

test("two regions: choose one, then only that region's roles and names are listed", async () => {
  assert.match(page.el("loginRegion").innerHTML, /data-region="ahmedabad" aria-pressed="false"[^>]*>Ahmedabad</);
  assert.match(page.el("loginRegion").innerHTML, /data-region="north-gujarat" aria-pressed="false"[^>]*>North Gujarat</);
  assert.equal(page.el("loginRole").disabled, true, "no role before a region is chosen");
  assert.match(page.el("loginRole").innerHTML, /Select a region first/);

  await choose("setLoginRegion", NG);
  assert.match(page.el("loginRegion").innerHTML, /data-region="north-gujarat" aria-pressed="true"/);
  assert.deepEqual(options("loginRole"), ["ad|Area Director (1)", "dc|Chapter Director (1)", "viewer|Viewer (1)"],
    "North Gujarat's roles; the Executive Director has a shortcut instead");
  await choose("populateLoginNames", "dc");
  assert.deepEqual(options("loginName"), ["dc-kappa|Kavi Kappa"]);

  await choose("setLoginRegion", "ahmedabad");
  assert.deepEqual(options("loginRole").map(o => o.split("|")[0]), ["ad", "srdc", "dc", "sa", "viewer"]);
  await choose("populateLoginNames", "ad");
  assert.deepEqual(options("loginName"), ["ad-1|Arun Area"], "not North Gujarat's Area Director");
  assert.equal(page.ctx.localStorage.getItem("loginRegion"), "ahmedabad", "the region is remembered");
  assert.match(page.el("loginTagline").textContent, /BNI Ahmedabad and BNI North Gujarat/);
  assert.match(page.el("loginNet").innerHTML, />North Gujarat<\/text>/);
  assert.doesNotMatch(page.el("loginNet").innerHTML, /chapters?</, "no chapter counts on the map");
});

test("the Executive Director and BNI Office tiles open a password box; a wrong password says so, the right one signs in", async () => {
  const tiles = page.el("loginQuick").innerHTML;
  assert.match(tiles, /data-q="ed".*Executive Director.*Esha Director - both regions/s);
  assert.match(tiles, /data-q="office".*BNI Office.*Full access - both regions/s);

  await page.run(`openQuickLogin('office');`);
  assert.match(page.el("loginQuick").innerHTML, /data-q="office" aria-pressed="true"/);
  assert.equal(page.el("quickLabel").textContent, "BNI Office password");
  page.el("quickPin").value = "000000";
  await page.run(`await quickLogin();`);
  assert.equal(page.el("quickErr").textContent, "Invalid password. Try again.");
  assert.equal(page.el("quickPin").value, "", "cleared for another try");
  assert.equal(page.ctx.__started, undefined, "not signed in");

  page.el("quickPin").value = OFFICE_PIN;
  await page.run(`await quickLogin();`);
  assert.equal(page.ctx.__started, 1);
  assert.equal(await page.run(`return S.user.id;`), "__srdc__");

  const ed = loadPage();
  ed.set("startApp", () => { ed.ctx.__started = 1; });
  await ed.run(`await buildLoginDD();openQuickLogin('ed');`);
  assert.equal(ed.el("quickLabel").textContent, "Password - Esha Director");
  ed.el("quickPin").value = PIN;
  await ed.run(`await quickLogin();`);
  assert.equal(await ed.run(`return S.user.id + ' ' + S.user.role;`), "ed-1 ed");
});

test("an empty password is not sent; the region sign-in says 'Invalid password' too", async () => {
  await page.run(`openQuickLogin('office');`);
  page.clearLog();
  await page.run(`await quickLogin();`);
  assert.equal(page.el("quickErr").textContent, "Enter your password.");
  assert.equal(page.log.calls.filter(c => c.path === "/auth/login").length, 0);

  await choose("setLoginRegion", NG);
  page.el("loginName").value = "dc-kappa";
  page.el("loginPin").value = "999999";
  await page.run(`await doLogin();`);
  assert.equal(page.el("loginErr").textContent, "Invalid password. Try again.", "not 'Session expired'");
  page.el("loginPin").value = PIN;
  await page.run(`await doLogin();`);
  assert.equal(await page.run(`return S.user.id;`), "dc-kappa");
});
