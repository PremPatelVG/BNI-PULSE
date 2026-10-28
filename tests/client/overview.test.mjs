import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
beforeEach(async () => {
  await seedRegion();
  page = loadPage();
});

// The Senior DC Overview with a week picked in its week chips.
const overviewFor = week => page.run(`S.tab='overview';S.ovWeek='${week}';renderOverview();return document.getElementById('tab-overview').innerHTML;`);
const status = (html, chapter) => (html.match(new RegExp(`${chapter}</span><span><span title="([^"]+)"`)) || [])[1];

test("Senior DC overview: the submitted / not-submitted card follows the week picked in the chips", async () => {
  // Sameer Senior oversees Alpha (Tuesdays) and Gamma (Wednesdays).
  fake.seed("weeklyData", "Alpha_2026-10-20", { chapter: "Alpha", date: "2026-10-20", membersStart: 30 });
  fake.seed("weeklyData", "Gamma_2026-10-14", { chapter: "Gamma", date: "2026-10-14", membersStart: 20 });
  await page.signIn(users.srdc);
  await page.loadData();

  let html = await overviewFor("2026-10-20");
  assert.match(html, /<div class="card-t">WEEK - 20 Oct - 23 Oct<\/div>/);
  assert.equal(status(html, "Alpha"), "Data submitted");
  assert.equal(status(html, "Gamma"), "Meeting passed - data not submitted");
  assert.match(html, /Warning: Gamma - meeting passed, no data yet/);

  html = await overviewFor("2026-10-13");
  assert.match(html, /WEEK - 13 Oct - 16 Oct/);
  assert.equal(status(html, "Alpha"), "Meeting passed - data not submitted");
  assert.equal(status(html, "Gamma"), "Data submitted");

  // The current week is still the default, titled THIS WEEK.
  const current = await page.run(`return getCurrentWeekKey();`);
  html = await overviewFor(current);
  assert.match(html, /<div class="card-t">THIS WEEK - /);
  assert.equal(await page.run(`S.ovWeek=null;renderOverview();return S.ovWeek;`), current);
});

test("Area Director, ED and BNI Office get the card for the whole region, narrowed by their Overview filters", async () => {
  fake.seed("weeklyData", "Alpha_2026-10-20", { chapter: "Alpha", date: "2026-10-20", membersStart: 30 });
  fake.seed("weeklyData", "Beta_2026-10-23", { chapter: "Beta", date: "2026-10-23", membersStart: 25 });
  for (const u of [users.ad, users.ed, users.office]) {
    await page.signIn(u);
    await page.loadData();
    await page.run(`S.adOverviewChapterFilter='';S.adOverviewSeniorFilter='';`);
    const html = await overviewFor("2026-10-20");
    assert.match(html, /<div class="card-t">WEEK - 20 Oct - 23 Oct<\/div>/, u.id);
    assert.deepEqual(["Alpha", "Beta", "Gamma"].map(c => status(html, c)),
      ["Data submitted", "Data submitted", "Meeting passed - data not submitted"], u.id);
  }
  // Filtered to one Senior DC's chapters, the card shows only those.
  await page.run(`S.adOverviewSeniorFilter='Bina Senior';`);
  const html = await overviewFor("2026-10-20");
  assert.equal(status(html, "Beta"), "Data submitted");
  assert.equal(status(html, "Alpha"), undefined);
  assert.equal(status(html, "Gamma"), undefined);
});
