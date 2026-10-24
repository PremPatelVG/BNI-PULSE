import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users } from "../helpers/region.mjs";
import { loadPage } from "../helpers/page.mjs";

let page;
beforeEach(async () => {
  await seedRegion();
  fake.seed("meta", "dues", { members: [
    { chapter: "Alpha", firstName: "Ravi", lastName: "Shah", name: "Ravi Shah", industry: "Steel", dueDate: "2026-11-01" },
    { chapter: "Beta", firstName: "Mira", lastName: "Jain", name: "Mira Jain", industry: "CA", dueDate: "2026-11-15" }
  ] });
  page = loadPage();
  await page.signIn(users.saAlpha);
  await page.loadData();
});

const row = (first, last, due, biz, extra = {}) => ({ chapter: "Alpha", firstName: first, lastName: last, name: (first + " " + last).trim(), industry: biz, dueDate: due, ...extra });

test("renewal keys: chapter + name + due date, safe for a document id; legacy keys still recognised", async () => {
  const r = await page.run(`
    S.renewalsDone={'Alpha_Ravi Shah_2026-11-01':{}};
    return [renewalDoneKey('Alpha','Ravi Shah','2026-11-01'), renewalDoneKey('BNI Hera','A. B/C','2026-01-01'),
      isRenewalDone({chapter:'Alpha',name:'Ravi Shah',dueDate:'2026-11-01'}), isRenewalDone({chapter:'Alpha',name:'Ravi Shah',dueDate:'2026-12-01'}), isRenewalDone(null)];`);
  assert.deepEqual(r, ["Alpha_Ravi_Shah_2026-11-01", "BNI_Hera_A__B_C_2026-01-01", true, false, false]);
});

test("merge: all 4 of first, last, chapter, business must match to count as the same member", async () => {
  page.ctx.__existing = [row("Ravi", "Shah", "2026-11-01", "Steel")];
  page.ctx.__incoming = [row("RAVI", " shah ", "2026-11-01", "steel"), row("Ravi", "Shah", "2026-12-01", "Different Biz"), row("Ravi", "Mehta", "2026-11-01", "Steel"), { ...row("Ravi", "Shah", "2026-11-01", "Steel"), chapter: "Gamma" }];
  const m = await page.run(`S.renewalsDone={};S.renewalsDropped={};const m=mergeDuesUpload(globalThis.__existing,globalThis.__incoming);return {rows:m.map(r=>r.chapter+'|'+r.name+'|'+r.industry+'|'+r.dueDate),stats:m.stats};`);
  assert.equal(m.stats.unchanged, 1, "case and spacing are ignored");
  assert.equal(m.stats.added, 3, "different business, different last name, different chapter are new members");
  assert.equal(m.rows.filter(x => x.startsWith("Alpha|Ravi Shah|Steel")).length, 1);
});

test("merge: a matching member with a new due date is moved, not added; Done/Dropped kept", async () => {
  page.ctx.__existing = [row("Ravi", "Shah", "2026-09-01", "Steel"), row("Done", "Person", "2026-10-01", "X"), row("Left", "Person", "2026-10-05", "Y")];
  page.ctx.__incoming = [row("Ravi", "Shah", "2027-09-01", "Steel"), row("Done", "Person", "2026-10-01", "X")];
  const m = await page.run(`
    S.renewalsDone={};S.renewalsDropped={};S.renewalsDone[renewalDoneKey('Alpha','Done Person','2026-10-01')]={};
    S.renewalsDropped[renewalDoneKey('Alpha','Left Person','2026-10-05')]={};
    const m=mergeDuesUpload(globalThis.__existing,globalThis.__incoming);return {rows:m.map(r=>r.name+'@'+r.dueDate),stats:m.stats};`);
  assert.deepEqual(m.rows.sort(), ["Done Person@2026-10-01", "Left Person@2026-10-05", "Ravi Shah@2027-09-01"]);
  assert.equal(m.stats.updated, 1);
  assert.equal(m.stats.added, 0);
});

test("merge: members BNI no longer lists are removed only within the report's dates (or from a full roster)", async () => {
  page.ctx.__existing = [row("Gone", "One", "2026-11-15", "G"), row("Overdue", "Two", "2026-08-01", "O"), row("Later", "Three", "2027-06-01", "L")];
  page.ctx.__short = [row("New", "Four", "2026-11-01", "N"), row("New", "Five", "2026-12-01", "N")];          // Nov-Dec only
  page.ctx.__roster = [row("New", "Four", "2026-11-01", "N"), row("Long", "Six", "2030-01-01", "L")];         // years apart = full roster
  const r = await page.run(`S.renewalsDone={};S.renewalsDropped={};
    const a=mergeDuesUpload(globalThis.__existing,globalThis.__short).map(x=>x.name);
    const b=mergeDuesUpload(globalThis.__existing,globalThis.__roster).map(x=>x.name);return {a,b};`);
  assert.ok(!r.a.includes("Gone One") && r.a.includes("Overdue Two") && r.a.includes("Later Three"), "short report: only rows inside its dates removed");
  assert.ok(!r.b.includes("Gone One") && !r.b.includes("Overdue Two") && !r.b.includes("Later Three"), "full roster: every absent open row removed");
});

test("merge result is change-detectable and its stats are never saved", async () => {
  const r = await page.run(`S.renewalsDone={};S.renewalsDropped={};const base=S.duesData.slice();
    const same=mergeDuesUpload(base,base.filter(x=>x.chapter==='Alpha'));
    return {sameSig:duesSignature(same)===duesSignature(base), json:JSON.stringify(same).includes('stats'), untouched:JSON.stringify(base)===JSON.stringify(S.duesData)};`);
  assert.deepEqual(r, { sameSig: true, json: false, untouched: true });
});

test("an SA marks a renewal Done, Drops one and Undoes the drop - saved on the server", async () => {
  await page.run(`await markRenewalDone('Alpha',encodeURIComponent('Ravi Shah'),'2026-11-01');`);
  const doneKey = "Alpha_Ravi_Shah_2026-11-01";
  assert.equal(fake.read("renewalsDone", doneKey).markedBy, "Alpha SA");
  assert.ok(await page.run(`return !!S.renewalsDone['${doneKey}'];`), "shown at once");
  fake.seed("meta", "dues", { members: [...fake.read("meta", "dues").members, row("Asha", "Rao", "2026-11-20", "Law")] });
  await page.run(`await markRenewalDropped('Alpha',encodeURIComponent('Asha Rao'),'2026-11-20');`);
  assert.ok(fake.read("renewalsDropped", "Alpha_Asha_Rao_2026-11-20"));
  assert.match(page.log.confirms.at(-1), /DROPPED/);
  await page.run(`await unmarkRenewalDropped('Alpha',encodeURIComponent('Asha Rao'),'2026-11-20');`);
  assert.equal(fake.read("renewalsDropped", "Alpha_Asha_Rao_2026-11-20"), undefined);
  assert.ok(page.log.toasts.some(t => /Drop undone/.test(t)));
});

test("declining the Drop confirmation writes nothing; another chapter's renewal is refused and not shown as done", async () => {
  page.answerConfirm(false);
  await page.run(`await markRenewalDropped('Alpha',encodeURIComponent('Ravi Shah'),'2026-11-01');`);
  assert.equal(fake.all("renewalsDropped").length, 0);
  page.answerConfirm(true);
  await page.run(`await markRenewalDone('Beta',encodeURIComponent('Mira Jain'),'2026-11-15');`);
  assert.equal(fake.all("renewalsDone").length, 0);
  assert.ok(page.log.toasts.some(t => /Could not mark renewal done/.test(t)));
  assert.equal(await page.run(`return !!S.renewalsDone['Beta_Mira_Jain_2026-11-15'];`), false);
});
