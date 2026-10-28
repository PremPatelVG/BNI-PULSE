import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, tokenFor, PIN } from "../helpers/region.mjs";
import netlifyApi, { config as netlifyConfig } from "../../netlify/functions/api.js";
import apiRouter from "../../src/routes/api.js";

beforeEach(() => seedRegion());
const BASE = "https://site.example/api/";

test("Netlify function: routes, CORS preflight, JSON errors", async () => {
  assert.equal(netlifyConfig.path, "/api/*");
  assert.equal((await netlifyApi(new Request(BASE + "snapshot", { method: "OPTIONS" }), {})).status, 204);
  const dir = await netlifyApi(new Request(BASE + "auth/login-directory"), {});
  assert.equal(dir.status, 200);
  assert.equal(dir.headers.get("cache-control"), "no-store", "API answers are never cached");
  assert.equal(dir.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await dir.json()).members.length, 9);
  const unauth = await netlifyApi(new Request(BASE + "snapshot"), {});
  assert.equal(unauth.status, 401);
  assert.match((await unauth.json()).error, /Authentication required/);
  const missing = await netlifyApi(new Request(BASE + "nope", { headers: { authorization: tokenFor(users.ad) } }), {});
  assert.equal(missing.status, 404);
});

test("Netlify function: a malformed JSON body is a 400, not a server error", async () => {
  const r = await netlifyApi(new Request(BASE + "auth/login", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }), {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not valid JSON/);
});

test("Netlify function: client IP reaches the login throttle; 204 has no body; path segments are decoded", async () => {
  await netlifyApi(new Request(BASE + "auth/login", { method: "POST", body: JSON.stringify({ memberId: "dc-alpha", pin: "0000" }) }), { ip: "203.0.113.7" });
  assert.ok(fake.read("loginThrottle", "ip_203_0_113_7"), "throttled per client IP");
  const ok = await netlifyApi(new Request(BASE + "auth/login", { method: "POST", body: JSON.stringify({ memberId: "dc-alpha", pin: PIN }) }), { ip: "203.0.113.8" });
  assert.equal(ok.status, 200);
  const del = await netlifyApi(new Request(BASE + "weekly-data/Alpha/2026-10-06", { method: "DELETE", headers: { authorization: tokenFor(users.dcAlpha) } }), {});
  assert.equal(del.status, 204);
  assert.equal(await del.text(), "");
  fake.seed("chapters", "BNI Hera", { name: "BNI Hera", order: 9 });
  const put = await netlifyApi(new Request(BASE + "weekly-data/BNI%20Hera/2026-10-06", { method: "PUT", body: JSON.stringify({ visitors: 2 }), headers: { authorization: tokenFor(users.ad) } }), {});
  assert.equal(put.status, 200);
  assert.ok(fake.read("weeklyData", "BNI Hera_2026-10-06"));
});

function expressRun(method, url, { body, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: "/api" + url, path: url.split("?")[0], body, query: {}, ip, headers, get: h => headers[h.toLowerCase()] };
    const res = {
      statusCode: 200, sent: undefined, headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.sent = b; resolve(this); return this; },
      end() { resolve(this); return this; }
    };
    apiRouter(req, res, err => (err ? resolve({ statusCode: err.status || 500, sent: { error: err.message } }) : reject(new Error("fell through"))));
  });
}

test("Express router: same router, errors passed to the error handler", async () => {
  const dir = await expressRun("GET", "/auth/login-directory");
  assert.equal(dir.statusCode, 200);
  assert.equal(dir.headers["Cache-Control"], "no-store", "API answers are never cached");
  assert.equal(dir.sent.members.length, 9);
  const snap = await expressRun("GET", "/snapshot", { headers: { authorization: tokenFor(users.saAlpha) } });
  assert.deepEqual(snap.sent.collections.chapters.map(c => c.name), ["Alpha"]);
  const denied = await expressRun("GET", "/snapshot");
  assert.equal(denied.statusCode, 401);
  await expressRun("POST", "/auth/login", { body: { memberId: "dc-alpha", pin: "0000" }, ip: "198.51.100.4" });
  assert.ok(fake.read("loginThrottle", "ip_198_51_100_4"));
});
