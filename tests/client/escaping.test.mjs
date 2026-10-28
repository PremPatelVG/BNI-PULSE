import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

// Text anyone signed in can type (goals, pipeline stages, names). Rendered unescaped it
// would run as code in the browser of whoever opens the page - typically leadership.
const ATTACK = `"><img src=x onerror="steal()">`;
const RAW = /<img src=x/;

let page;
beforeEach(async () => {
  await seedRegion();
  page = loadPage();
});

async function open(user) {
  await page.signIn(user);
  await page.loadData();
}

test("Goals: typed goals render as text in both the edit boxes and the read-only view", async () => {
  fake.seed("meta", "chapterGoals", { Alpha: { dcGoal: ATTACK, sa1Goal: ATTACK, inductions: ATTACK, targetBand: "<b>Power</b>" } });
  await open(users.ad);
  const edit = await page.run(`renderGoalsTab();return document.getElementById('tab-goals').innerHTML;`);
  assert.doesNotMatch(edit, RAW);
  assert.match(edit, /value="&quot;&gt;&lt;img src=x onerror=&quot;steal\(\)&quot;&gt;"/, "the box still shows the typed text");
  await open(users.viewer);
  const view = await page.run(`renderGoalsTab();return document.getElementById('tab-goals').innerHTML;`);
  assert.doesNotMatch(view, RAW);
  assert.doesNotMatch(view, /<b>Power<\/b>/);
  assert.match(view, /&lt;img src=x/);
});

test("Activity Log: names, roles, chapters and details render as text", async () => {
  await open(users.ad);
  const html = await page.run(`
    S.activityLog=[{action:'pipeline_stage_changed',userName:${JSON.stringify(ATTACK)},userRole:'<i>dc</i>',chapter:'Alpha',
      details:{stage:${JSON.stringify(ATTACK)},memberName:'<svg onload=1>'},timestamp:new Date().toISOString()}];
    renderActivityLogTab();return document.getElementById('tab-activitylog').innerHTML;`);
  assert.doesNotMatch(html, RAW);
  assert.doesNotMatch(html, /<svg|<i>dc/);
  assert.match(html, /&lt;svg onload=1&gt;/);
});

test("Renewals: a member name with quotes reaches the Mark Done button intact and cannot break out of it", async () => {
  const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const name = `O'Brien'-steal()-'`;
  fake.seed("meta", "dues", { members: [{ chapter: "Alpha", firstName: "O'Brien", lastName: "", name, industry: "Steel", dueDate: due }] });
  await open(users.saAlpha);
  const html = await page.run(`S.tab='renewals';renderRenewals();return document.getElementById('tab-renewals').innerHTML;`);
  const handler = (html.match(/onclick="(markRenewalDone\([^"]*\))"/) || [])[1];
  assert.ok(handler, "the Mark Done button is rendered");
  // What the browser runs: the attribute with its HTML entities decoded.
  const code = handler.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  let stolen = false;
  const args = new Function("markRenewalDone", "steal", "return " + code)((...a) => a, () => { stolen = true; });
  assert.equal(stolen, false);
  assert.equal(args[0], "Alpha");
  assert.equal(decodeURIComponent(args[1]), name);
  assert.equal(args[2], due);
});
