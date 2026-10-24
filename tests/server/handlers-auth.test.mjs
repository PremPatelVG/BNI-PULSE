import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call, PIN, OFFICE_PIN } from "../helpers/region.mjs";
import { invalidateSnapshotCache } from "../../src/services/firestore.js";

beforeEach(() => seedRegion());
const login = (memberId, pin, ip = "10.0.0.1") => call(null, "POST", "auth/login", { memberId, pin }, { ip });

test("login: correct PIN returns a session and the public profile only", async () => {
  const r = await login("dc-alpha", PIN);
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.deepEqual(Object.keys(r.body.user).sort(), ["areaDirectorId", "chapter", "chapterReportsTo", "chapters", "id", "name", "reportsTo", "role", "seniorDirectorId"]);
  assert.equal(r.body.user.name, "Dev Alpha");
});

test("login: wrong PIN, unknown account and malformed bodies", async () => {
  assert.equal((await login("dc-alpha", "0000")).status, 401);
  assert.equal((await login("no-such-account", PIN)).status, 401);
  for (const body of [{}, { memberId: "dc-alpha" }, { pin: PIN }, { memberId: { $gt: "" }, pin: PIN }, { memberId: "a/b", pin: PIN }]) {
    assert.equal((await call(null, "POST", "auth/login", body)).status, 400, JSON.stringify(body));
  }
});

test("login: a numeric PIN is accepted", async () => {
  assert.equal((await call(null, "POST", "auth/login", { memberId: "dc-alpha", pin: 1234 })).status, 200);
});

test("login: the BNI Office account signs in with the office PIN as an Area Director", async () => {
  const r = await login("__srdc__", OFFICE_PIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "ad");
  assert.equal((await login("__srdc__", PIN)).status, 401);
});

test("login: 5 wrong PINs lock the account (even for the right PIN), others unaffected", async () => {
  for (let i = 0; i < 5; i++) await login("dc-alpha", "0000");
  const locked = await login("dc-alpha", PIN);
  assert.equal(locked.status, 429);
  assert.match(locked.error, /for this account/);
  assert.doesNotMatch(locked.error, /incorrect pin/i, "the login screen hides messages mentioning 'incorrect PIN'");
  assert.equal((await login("dc-beta", PIN)).status, 200);
  const t = fake.read("loginThrottle", "acct_dc-alpha");
  fake.seed("loginThrottle", "acct_dc-alpha", { ...t, lockedUntil: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await login("dc-alpha", PIN)).status, 200, "works again once the lock expires");
  assert.equal(fake.read("loginThrottle", "acct_dc-alpha"), undefined, "a correct PIN clears the account's count");
});

test("login: the lock grows with repeated failures", async () => {
  for (let i = 0; i < 10; i++) {
    const t = fake.read("loginThrottle", "acct_dc-alpha");
    if (t) fake.seed("loginThrottle", "acct_dc-alpha", { ...t, lockedUntil: null });
    await login("dc-alpha", "0000", "10.0.0." + i);
  }
  const t = fake.read("loginThrottle", "acct_dc-alpha");
  const minutes = Math.round((Date.parse(t.lockedUntil) - Date.now()) / 60000);
  assert.equal(t.failures, 10);
  assert.ok(minutes >= 59 && minutes <= 60, "10 failures lock for an hour, got " + minutes);
});

test("login: 30 wrong PINs from one IP lock that IP; made-up ids create no account records", async () => {
  for (let i = 0; i < 30; i++) await login("made-up-" + i, PIN, "10.9.9.9");
  assert.equal(fake.all("loginThrottle").filter(t => t.id.startsWith("acct_")).length, 0);
  const r = await login("dc-beta", PIN, "10.9.9.9");
  assert.equal(r.status, 429);
  assert.match(r.error, /from this network/);
  assert.equal((await login("dc-beta", PIN, "10.8.8.8")).status, 200);
});

test("login directory is public and carries no credentials", async () => {
  const r = await call(null, "GET", "auth/login-directory");
  assert.equal(r.status, 200);
  assert.equal(r.body.members.length, 9);
  for (const m of r.body.members) {
    assert.equal("pinHash" in m || "pin" in m || "phone" in m || "pinChangedAt" in m, false, m.id);
  }
});

test("branding is public; everything else needs a session", async () => {
  fake.seed("meta", "branding", { argLogo: "x.png" });
  assert.equal((await call(null, "GET", "auth/branding")).body.branding.argLogo, "x.png");
  for (const path of ["snapshot", "auth/me", "meta/dues", "members", "miyagiMembers"]) {
    assert.equal((await call(null, "GET", path)).status, 401, path);
  }
  assert.equal((await call(users.dcAlpha, "GET", "no-such-route")).status, 404);
});

test("BNI Office PIN can be reset only by the Executive Director", async () => {
  for (const u of [users.ad, users.office, users.srdc, users.dcAlpha]) {
    assert.equal((await call(u, "PUT", "auth/sr-pin", { pin: "5555" })).status, 403);
  }
  assert.equal((await call(users.ed, "PUT", "auth/sr-pin", { pin: "12" })).status, 400);
  assert.equal((await call(users.ed, "PUT", "auth/sr-pin", { pin: "5555" })).status, 200);
  assert.equal((await login("__srdc__", "5555")).status, 200);
  assert.equal((await login("__srdc__", OFFICE_PIN)).status, 401);
  assert.ok(fake.read("meta", "config").srPinChangedAt);
});

test("sessions follow the current account record", async () => {
  // role / chapters come from the record, not the token
  fake.seed("members", "dc-alpha", { ...fake.read("members", "dc-alpha"), chapter: "Beta", chapters: ["Beta"] });
  invalidateSnapshotCache("members");
  const me = await call(users.dcAlpha, "GET", "auth/me");
  assert.deepEqual(me.body.user.chapters, ["Beta"]);
  assert.equal((await call(users.dcAlpha, "PUT", "meta/chapterGoals", { Alpha: { dcGoal: "x" } })).status, 403);
  assert.equal((await call(users.dcAlpha, "PUT", "meta/chapterGoals", { Beta: { dcGoal: "x" } })).status, 200);
  // a deleted account's session ends
  fake.remove("members", "dc-beta");
  invalidateSnapshotCache("members");
  const gone = await call(users.dcBeta, "GET", "snapshot");
  assert.equal(gone.status, 401);
  assert.match(gone.error, /no longer exists/);
});

test("a PIN reset ends sessions signed in before it; the BNI Office PIN reset ends office sessions", async () => {
  fake.seed("members", "sa-alpha", { ...fake.read("members", "sa-alpha"), pinChangedAt: new Date(Date.now() + 5000).toISOString() });
  invalidateSnapshotCache("members");
  const r = await call(users.saAlpha, "GET", "auth/me");
  assert.equal(r.status, 401);
  assert.match(r.error, /PIN was changed/);
  fake.seed("meta", "config", { ...fake.read("meta", "config"), srPinChangedAt: new Date(Date.now() + 5000).toISOString() });
  invalidateSnapshotCache("config");
  assert.equal((await call(users.office, "GET", "auth/me")).status, 401);
});
