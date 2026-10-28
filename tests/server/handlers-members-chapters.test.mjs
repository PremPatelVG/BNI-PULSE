import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";

beforeEach(() => seedRegion());
const save = (u, body) => call(u, "POST", "members", body);

test("members: only admins (AD/ED/BNI Office/Sr.DC) can create or edit accounts", async () => {
  for (const u of [users.dcAlpha, users.saAlpha, users.viewer]) {
    assert.equal((await save(u, { name: "X", role: "dc", chapter: "Alpha", chapters: ["Alpha"] })).status, 403);
    assert.equal((await call(u, "DELETE", "members/dc-beta")).status, 403);
  }
});

test("members: a Senior DC manages only DC/SA accounts in their own chapters", async () => {
  assert.equal((await save(users.srdc, { id: "dc-alpha", name: "Dev Alpha", role: "dc", chapter: "Alpha", chapters: ["Alpha"] })).status, 201);
  assert.equal((await save(users.srdc, { id: "dc-beta", name: "Dina Beta", role: "dc", chapter: "Beta", chapters: ["Beta"] })).status, 403, "not their chapter");
  assert.equal((await save(users.srdc, { id: "dc-alpha", name: "Dev Alpha", role: "ad" })).status, 403, "cannot promote to AD");
  assert.equal((await save(users.srdc, { id: "srdc-1", name: "Sameer Senior", role: "ad" })).status, 403, "cannot promote themselves");
  assert.equal((await save(users.srdc, { name: "New AD", role: "ad" })).status, 403);
  assert.equal((await save(users.srdc, { id: "dc-alpha", name: "Dev Alpha", role: "dc", chapter: "Alpha", chapters: ["Alpha", "Beta"] })).status, 403, "cannot move an account into another Sr.DC's chapter");
  assert.equal((await call(users.srdc, "DELETE", "members/dc-beta")).status, 403);
  assert.equal((await call(users.srdc, "DELETE", "members/sa-alpha")).status, 204);
});

test("members: Executive Director accounts - only the ED or BNI Office; ED PIN only by BNI Office", async () => {
  assert.equal((await save(users.ad, { id: "ed-1", name: "Esha Director", role: "ed" })).status, 403);
  assert.equal((await call(users.ad, "DELETE", "members/ed-1")).status, 403);
  assert.equal((await save(users.ed, { id: "ed-1", name: "Esha Director", role: "ed", pin: "777777" })).status, 403, "ED cannot reset own PIN");
  assert.equal((await save(users.office, { id: "ed-1", name: "Esha Director", role: "ed", pin: "777777" })).status, 201);
  assert.equal((await save(users.ad, { id: "dc-alpha", name: "Dev Alpha", role: "ed", pin: "777777" })).status, 403, "no role-swap bypass");
});

test("members: PINs are hashed, never stored or returned in the clear; a PIN change is stamped", async () => {
  const r = await save(users.ad, { name: "New DC", role: "dc", chapter: "Beta", chapters: ["Beta"], pin: "432100" });
  assert.equal(r.status, 201);
  const stored = fake.read("members", r.body.member.id);
  assert.equal(stored.pin, undefined);
  assert.match(stored.pinHash, /^\$2[ab]\$12\$/);
  assert.ok(stored.pinChangedAt);
  assert.equal("pinHash" in r.body.member, false);
  assert.equal((await save(users.ad, { name: "Short", role: "dc", chapter: "Beta", pin: "12" })).status, 400);
  assert.equal((await save(users.ad, { name: "Short", role: "dc", chapter: "Beta", pin: "12345" })).status, 400, "new PINs are 6 digits");
  assert.equal((await save(users.ad, { role: "dc" })).status, 400, "name required");
  assert.equal((await save(users.ad, { id: "dc-beta", name: "Dina Beta", role: "dc", chapter: "Beta", pinHash: "$2a$04$injected" })).status, 201);
  assert.notEqual(fake.read("members", "dc-beta").pinHash, "$2a$04$injected", "a client-sent pinHash is ignored");
});

test("members: SA logins are always named '<Chapter> SA'; 'cd' is stored as 'dc'", async () => {
  await save(users.ad, { id: "sa-alpha", name: "Some Person", role: "sa1", chapter: "Alpha", chapters: ["Alpha"] });
  assert.equal(fake.read("members", "sa-alpha").name, "Alpha SA");
  const r = await save(users.ad, { name: "Whatever", role: "sa2", chapters: ["Gamma"] });
  assert.equal(fake.read("members", r.body.member.id).name, "Gamma SA");
  const c = await save(users.ad, { name: "CD Person", role: "cd", chapter: "Beta", chapters: ["Beta"] });
  assert.equal(fake.read("members", c.body.member.id).role, "dc");
  const log = fake.all("activityLog").find(a => a.action === "member_saved" && a.details.memberId === "sa-alpha");
  assert.equal(log.details.memberName, "Alpha SA");
});

test("members: delete is logged with the name; unknown account is 404", async () => {
  assert.equal((await call(users.ad, "DELETE", "members/dc-beta")).status, 204);
  assert.equal(fake.read("members", "dc-beta"), undefined);
  const log = fake.all("activityLog").find(a => a.action === "member_deleted");
  assert.equal(log.details.memberName, "Dina Beta");
  assert.equal((await call(users.ad, "DELETE", "members/nobody")).status, 404);
});

test("member contacts (phone numbers) are admin-only", async () => {
  assert.equal((await call(users.dcAlpha, "GET", "member-contacts")).status, 403);
  const r = await call(users.ad, "GET", "member-contacts");
  assert.equal(r.body.contacts.find(c => c.id === "dc-alpha").phone, "9000000001");
  const list = await call(users.dcAlpha, "GET", "members");
  assert.ok(list.body.members.every(m => !("phone" in m) && !("pinHash" in m)));
});

test("chapters: add, edit, duplicate name, unknown id, rename", async () => {
  assert.equal((await call(users.ad, "POST", "chapters", { name: "Delta", day: "Monday", order: 4, openingMembers: 20 })).status, 201);
  assert.equal(fake.read("chapters", "Delta").openingMembers, 20);
  assert.equal("id" in fake.read("chapters", "Delta"), false);
  const dup = await call(users.ad, "POST", "chapters", { name: "Alpha", day: "Monday" });
  assert.equal(dup.status, 409);
  assert.equal(fake.read("chapters", "Alpha").seniorDirector, "Sameer Senior", "existing chapter not replaced");
  assert.equal((await call(users.ad, "POST", "chapters", { id: "Nope", name: "Nope" })).status, 404);
  const ren = await call(users.ad, "POST", "chapters", { id: "Alpha", name: "BNI Alpha" });
  assert.equal(ren.status, 400);
  assert.match(ren.error, /Renaming/);
  assert.equal((await call(users.ad, "POST", "chapters", { id: "Alpha", name: "Alpha", target: 55 })).status, 201);
  assert.equal(fake.read("chapters", "Alpha").target, 55);
  assert.equal(fake.read("chapters", "Alpha").openingMembers, 30, "an edit merges, keeping other fields");
  assert.equal((await call(users.ad, "POST", "chapters", { day: "Monday" })).status, 400, "name required");
});

test("chapters: a Senior DC edits only their chapters' basics and can register new ones", async () => {
  assert.equal((await call(users.srdc, "POST", "chapters", { id: "Beta", name: "Beta", day: "Monday" })).status, 403);
  const own = await call(users.srdc, "POST", "chapters", { id: "Gamma", name: "Gamma", seniorDirectorId: "srdc-1" });
  assert.equal(own.status, 403);
  assert.match(own.error, /seniorDirectorId/);
  assert.equal((await call(users.srdc, "POST", "chapters", { id: "Gamma", name: "Gamma", day: "Thursday", target: 30, order: 3, tenure: "apr", openingMembers: 22 })).status, 201);
  assert.equal(fake.read("chapters", "Gamma").seniorDirector, "Sameer Senior", "assignment kept");
  assert.equal((await call(users.srdc, "POST", "chapters", { name: "Epsilon", day: "Monday" })).status, 201);
  for (const u of [users.dcAlpha, users.viewer]) assert.equal((await call(u, "POST", "chapters", { name: "Zeta" })).status, 403);
});

test("chapters / hierarchy reads are scoped", async () => {
  const c = await call(users.saAlpha, "GET", "chapters");
  assert.deepEqual(c.body.chapters.map(x => x.name), ["Alpha"]);
  const h = await call(users.srdc, "GET", "hierarchy");
  assert.deepEqual(h.body.chapters.map(x => x.name).sort(), ["Alpha", "Gamma"]);
  assert.equal(h.body.chapters.find(x => x.name === "Alpha").chapterDirector.id, "dc-alpha");
  assert.ok(h.body.seniorDirectors.every(m => !("pinHash" in m)));
});
