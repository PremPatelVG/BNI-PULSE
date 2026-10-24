import { test } from "node:test";
import assert from "node:assert/strict";

// config.js reads the environment when it is first imported, so each scenario imports
// a fresh copy (a distinct ?query makes a separate module instance).
async function loadConfig(env, tag) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await import("../../src/config.js?" + tag);
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("development / test: no production checks, preview PIN allowed", async () => {
  const m = await loadConfig({ NODE_ENV: "development", LOCAL_PREVIEW_PIN: "4242" }, "dev");
  assert.doesNotThrow(() => m.requireProductionSecrets());
  assert.equal(m.config.localPreviewPin, "4242");
});

test("production refuses a known/default JWT secret and a missing service account", async () => {
  const m = await loadConfig({ NODE_ENV: "production", APP_JWT_SECRET: "dev-only-change-me", FIREBASE_SERVICE_ACCOUNT_BASE64: "", FIREBASE_SERVICE_ACCOUNT_PATH: "" }, "prod-bad");
  // requireProductionSecrets reads the live environment, so keep it set while calling.
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "production", APP_JWT_SECRET: "dev-only-change-me", FIREBASE_SERVICE_ACCOUNT_BASE64: "", FIREBASE_SERVICE_ACCOUNT_PATH: "" });
  try {
    assert.throws(() => m.requireProductionSecrets(), e => /APP_JWT_SECRET/.test(e.message) && /FIREBASE_SERVICE_ACCOUNT/.test(e.message));
  } finally { process.env = saved; }
});

test("production never enables the local preview PIN", async () => {
  const m = await loadConfig({ NODE_ENV: "production", LOCAL_PREVIEW_PIN: "4242", APP_JWT_SECRET: "a-long-real-secret", FIREBASE_SERVICE_ACCOUNT_BASE64: "e30=" }, "prod-ok");
  assert.equal(m.config.localPreviewPin, "");
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "production", APP_JWT_SECRET: "a-long-real-secret", FIREBASE_SERVICE_ACCOUNT_BASE64: "e30=" });
  try { assert.doesNotThrow(() => m.requireProductionSecrets()); } finally { process.env = saved; }
});
