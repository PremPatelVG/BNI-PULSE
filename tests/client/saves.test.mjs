import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
beforeEach(async () => {
  await seedRegion();
  page = loadPage();
  await page.signIn(users.saAlpha);
  await page.loadData();
  page.clearLog();
});
const tryCall = (path, method, body) => page.run(`try{await apiFetch('${path}',{method:'${method}',body:${JSON.stringify(body)}});return 'ok';}catch(e){return e.message;}`);

test("a PUT that fails in transit (network / 502-504) is retried and lands", async () => {
  page.failNext(/^PUT \/weekly-data/, "network");
  page.failNext(/^PUT \/weekly-data/, 503);
  assert.equal(await tryCall("/weekly-data/Alpha/2026-10-06", "PUT", { visitors: 3 }), "ok");
  assert.equal(page.log.calls.filter(c => c.method === "PUT").length, 3);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 3);
});

test("after 3 failed attempts the error says to try again; refusals and POSTs are never retried", async () => {
  page.failNext(/^PUT \/weekly-data/, "network", 3);
  assert.match(await tryCall("/weekly-data/Alpha/2026-10-06", "PUT", { visitors: 3 }), /Could not reach the server\. Please try again\./);
  page.clearLog();
  page.failNext(/^PUT \/weekly-data/, 403);
  assert.equal(await tryCall("/weekly-data/Alpha/2026-10-06", "PUT", {}), "Injected 403");
  assert.equal(page.log.calls.length, 1);
  page.clearLog();
  page.failNext(/^POST \/activity/, "network");
  await tryCall("/activity", "POST", { action: "quick_update" });
  assert.equal(page.log.calls.length, 1, "a POST could create a duplicate, so it is not retried");
});

test("a save in flight shows 'Saving...' and counts as unsaved work; the audit log does not", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const real = page.ctx.fetch;
  page.ctx.fetch = async (u, o) => { await gate; return real(u, o); };
  const p = page.run(`return apiFetch('/weekly-data/Alpha/2026-10-06',{method:'PUT',body:{visitors:1}});`);
  await new Promise(r => setImmediate(r));
  const during = await page.run(`return {txt:document.getElementById('syncTxt').textContent,unsaved:hasUnsavedWork()};`);
  release(); await p; page.ctx.fetch = real;
  assert.deepEqual(during, { txt: "Saving...", unsaved: true });
  assert.equal(await page.run(`return hasUnsavedWork();`), false);
  assert.equal(await page.run(`MIYAGI_PENDING={x:{msp:true}};return hasUnsavedWork();`), true, "staged Miyagi ticks are unsaved work");
});

test("a save refused by an expired session is kept and re-offered to the same person only", async () => {
  page.failNext(/^PUT \/weekly-data/, 401);
  assert.match(await tryCall("/weekly-data/Alpha/2026-10-06", "PUT", { visitors: 7 }), /Session expired/);
  const stash = JSON.parse(page.ctx.localStorage.store.bniPulseUnsavedWrites);
  assert.equal(stash.length, 1);
  assert.equal(stash[0].userId, "sa-alpha");
  // Someone else signs in on this browser: not offered, not replayed, left in place.
  await page.signIn(users.saBeta);
  page.clearLog();
  await page.run(`await offerUnsavedWrites();`);
  assert.equal(page.log.confirms.length, 0);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06"), undefined);
  // The same person signs back in: offered and saved.
  await page.signIn(users.saAlpha);
  await page.run(`await offerUnsavedWrites();`);
  assert.match(page.log.confirms.at(-1), /could not be saved because your session had expired/);
  assert.equal(fake.read("weeklyData", "Alpha_2026-10-06").visitors, 7);
  assert.equal(page.ctx.localStorage.store.bniPulseUnsavedWrites, undefined);
});

test("goal cells: a failed save reverts and outlines the cell red; a good save sends one field", async () => {
  const input = page.el("goalCell");
  page.ctx.window.event = { target: input };
  await page.run(`S.chapterGoals={Alpha:{dcGoal:'old',netAdd:3}};`);
  page.failNext(/^PUT \/meta\/chapterGoals/, "network", 3);
  input.value = "new";
  await page.run(`await saveChapterGoal('Alpha','dcGoal','new');`);
  assert.equal(input.value, "old");
  assert.match(input.style.outline, /red/);
  assert.ok(page.log.toasts.some(t => /Goal NOT saved/.test(t)));
  page.clearLog();
  await page.run(`await saveChapterGoal('Alpha','dcGoal','new');`);
  const put = page.log.calls.find(c => c.path === "/meta/chapterGoals");
  assert.deepEqual(put.body, { Alpha: { dcGoal: "new" } });
  assert.equal(fake.read("meta", "chapterGoals").Alpha.dcGoal, "new");
  delete page.ctx.window.event;
});

test("logging out with unsaved work asks first", async () => {
  await page.run(`ENTRY_DIRTY=true;`);
  page.answerConfirm(false);
  await page.run(`logout();`);
  assert.match(page.log.confirms.at(-1), /not saved yet/);
  assert.equal(await page.run(`return !!S.user;`), true, "still signed in");
  page.answerConfirm(true);
  await page.run(`logout();`);
  assert.equal(await page.run(`return S.user;`), null);
});
