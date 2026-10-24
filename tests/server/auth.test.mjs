import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { signSession, requireAuth, requireRole } from "../../src/middleware/auth.js";
import { verifyToken } from "../../src/api/handlers.js";
import { config } from "../../src/config.js";

test("signSession carries id, role and chapters - never a name or PIN - for 12 hours", () => {
  const token = signSession({ id: "dc-1", name: "Some Name", role: "dc", chapter: "Alpha", chapters: ["Alpha"], pin: "1234", pinHash: "x" });
  const p = jwt.verify(token, config.jwtSecret);
  assert.equal(p.sub, "dc-1");
  assert.equal(p.role, "dc");
  assert.equal(p.chapter, "Alpha");
  assert.deepEqual(p.chapters, ["Alpha"]);
  assert.equal(p.name, undefined);
  assert.equal(p.pin, undefined);
  assert.equal(p.pinHash, undefined);
  assert.equal(p.exp - p.iat, 12 * 3600);
  const bare = jwt.verify(signSession({ id: "ad-1", role: "ad" }), config.jwtSecret);
  assert.equal(bare.chapter, null);
  assert.deepEqual(bare.chapters, []);
});

test("verifyToken accepts a valid Bearer token and rejects everything else with 401", () => {
  const p = verifyToken("Bearer " + signSession({ id: "x", role: "dc" }));
  assert.equal(p.sub, "x");
  for (const bad of [undefined, "", "Bearer ", "Token abc", "Bearer not.a.jwt", "Bearer " + jwt.sign({ sub: "x" }, "other-secret")]) {
    assert.throws(() => verifyToken(bad), e => e.status === 401, String(bad));
  }
  const expired = jwt.sign({ sub: "x", role: "dc" }, config.jwtSecret, { expiresIn: -10 });
  assert.throws(() => verifyToken("Bearer " + expired), e => e.status === 401 && /expired/i.test(e.message));
});

function mockRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test("Express requireAuth / requireRole middleware", () => {
  const ok = { get: () => "Bearer " + signSession({ id: "a", role: "srdc" }) };
  let nextCalled = false;
  requireAuth(ok, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(ok.user.role, "srdc");

  const res1 = mockRes();
  requireAuth({ get: () => "" }, res1, () => assert.fail("next must not run"));
  assert.equal(res1.statusCode, 401);
  const res2 = mockRes();
  requireAuth({ get: () => "Bearer junk" }, res2, () => assert.fail("next must not run"));
  assert.equal(res2.statusCode, 401);

  const res3 = mockRes();
  requireRole("ad", "ed")({ user: { role: "srdc" } }, res3, () => assert.fail("next must not run"));
  assert.equal(res3.statusCode, 403);
  let roleOk = false;
  requireRole("ad", "ed")({ user: { role: "ed" } }, mockRes(), () => { roleOk = true; });
  assert.equal(roleOk, true);
});
