// Where member PIN hashes live. This is deliberately NOT Firestore: credentials are
// held in a small runtime key-value store the backend owns, so they can be changed
// through the app without a deploy and never sit next to the business data.
//
// Production: Netlify Blobs (auto-configured inside Netlify Functions).
// Local dev / CI: a gitignored JSON file, so `npm start` and the tests work without
//                 any Netlify credentials.
//
// One entry per member, keyed by member id; the Sr. DC master hash lives under the
// reserved key "__srdc__". Values are bcrypt hashes - never plaintext.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "member-credentials";
export const SR_PIN_KEY = "__srdc__";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "..", "..", ".credentials-store.json");

let backendPromise = null;
let backendKind = "unknown";

function optionalEnv(name) {
  return globalThis.Netlify?.env?.get?.(name) || process.env[name] || "";
}

function netlifyBackend(store) {
  return {
    kind: "netlify-blobs",
    async get(key) {
      // Strong consistency so a PIN changed a moment ago is honoured immediately.
      return store.get(key, { type: "text", consistency: "strong" });
    },
    async set(key, value) { await store.set(key, value); },
    async remove(key) { await store.delete(key); },
    async list() {
      const { blobs } = await store.list();
      const out = {};
      for (const b of blobs) out[b.key] = await store.get(b.key, { type: "text", consistency: "strong" });
      return out;
    }
  };
}

function fileBackend() {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")); } catch { return {}; }
  };
  const write = obj => fs.writeFileSync(LOCAL_FILE, JSON.stringify(obj, null, 2), "utf8");
  return {
    kind: "local-file",
    async get(key) { return read()[key] ?? null; },
    async set(key, value) { const o = read(); o[key] = value; write(o); },
    async remove(key) { const o = read(); delete o[key]; write(o); },
    async list() { return read(); }
  };
}

function openBlobStore() {
  // siteID + token let the store work from outside Netlify (e.g. a local bulk reset).
  const siteID = optionalEnv("NETLIFY_SITE_ID");
  const token = optionalEnv("NETLIFY_BLOBS_TOKEN") || optionalEnv("NETLIFY_AUTH_TOKEN");
  if (siteID && token) return getStore({ name: STORE_NAME, siteID, token });
  return getStore(STORE_NAME);
}

async function resolveBackend() {
  try {
    const store = openBlobStore();
    // Probe forces a "not configured" environment to fail here, where we can fall back,
    // rather than on the first real login. A missing key returns null, not an error.
    await store.get("__healthcheck__");
    const backend = netlifyBackend(store);
    backendKind = backend.kind;
    return backend;
  } catch {
    const backend = fileBackend();
    backendKind = backend.kind;
    return backend;
  }
}

function backend() {
  if (!backendPromise) backendPromise = resolveBackend();
  return backendPromise;
}

export function credentialBackendKind() {
  return backendKind;
}

export async function getMemberPinHash(memberId) {
  return (await backend()).get(memberId);
}

export async function setMemberPinHash(memberId, hash) {
  await (await backend()).set(memberId, hash);
}

export async function deleteMemberPinHash(memberId) {
  await (await backend()).remove(memberId);
}

export async function getSrPinHash() {
  return (await backend()).get(SR_PIN_KEY);
}

export async function setSrPinHash(hash) {
  await (await backend()).set(SR_PIN_KEY, hash);
}

export async function listCredentials() {
  return (await backend()).list();
}

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// One-time copy of the existing hashes out of Firestore and into this store. Safe to
// run more than once: it overwrites each key with the same value. Returns counts and
// a round-trip verification so the caller can confirm the store is really working
// before Firestore is cleaned up.
export async function migrateFromFirestore() {
  const { getDb } = await import("../firebaseAdmin.js");
  const db = getDb();

  const members = await db.collection("members").get();
  let migrated = 0;
  const skipped = [];
  for (const doc of members.docs) {
    const hash = doc.data().pinHash;
    if (hash && BCRYPT_RE.test(String(hash))) {
      await setMemberPinHash(doc.id, hash);
      migrated++;
    } else {
      skipped.push(doc.id);
    }
  }

  const cfg = await db.collection("meta").doc("config").get();
  const srHash = cfg.exists ? cfg.data().srPinHash : null;
  let srPinMigrated = false;
  if (srHash && BCRYPT_RE.test(String(srHash))) {
    await setSrPinHash(srHash);
    srPinMigrated = true;
  }

  // Read every migrated hash straight back out of the store and confirm it matches.
  const stored = await listCredentials();
  let verified = 0;
  for (const doc of members.docs) {
    const hash = doc.data().pinHash;
    if (hash && BCRYPT_RE.test(String(hash)) && stored[doc.id] === hash) verified++;
  }

  return { backend: credentialBackendKind(), total: members.size, migrated, verified, srPinMigrated, skipped };
}
