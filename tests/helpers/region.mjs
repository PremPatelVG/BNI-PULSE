// A small made-up region (no real people) seeded into the fake database, plus a helper
// that calls the real API router as any of its accounts.
import bcrypt from "bcryptjs";
import * as fake from "./fake-firestore.mjs";
import { routeApi } from "../../src/api/handlers.js";
import { signSession } from "../../src/middleware/auth.js";
import { invalidateSnapshotCache, publishCacheStamps } from "../../src/services/firestore.js";

export const PIN = "1234";
export const OFFICE_PIN = "9999";
const pinHash = bcrypt.hashSync(PIN, 4);
const officePinHash = bcrypt.hashSync(OFFICE_PIN, 4);

// Session payloads for each kind of account (what a signed-in browser carries).
export const users = {
  office: { id: "__srdc__", role: "ad", chapter: null, chapters: [] },
  ed: { id: "ed-1", role: "ed", chapter: null, chapters: [] },
  ad: { id: "ad-1", role: "ad", chapter: null, chapters: [] },
  srdc: { id: "srdc-1", role: "srdc", chapter: "Alpha", chapters: ["Alpha", "Gamma"] },
  srdcBeta: { id: "srdc-2", role: "srdc", chapter: "Beta", chapters: ["Beta"] },
  dcAlpha: { id: "dc-alpha", role: "dc", chapter: "Alpha", chapters: ["Alpha"] },
  saAlpha: { id: "sa-alpha", role: "sa1", chapter: "Alpha", chapters: ["Alpha"] },
  dcBeta: { id: "dc-beta", role: "dc", chapter: "Beta", chapters: ["Beta"] },
  saBeta: { id: "sa-beta", role: "sa1", chapter: "Beta", chapters: ["Beta"] },
  viewer: { id: "viewer-1", role: "viewer", chapter: null, chapters: [] }
};

const accounts = {
  "ed-1": { name: "Esha Director", role: "ed" },
  "ad-1": { name: "Arun Area", role: "ad" },
  "srdc-1": { name: "Sameer Senior", role: "srdc", chapter: "Alpha", chapters: ["Alpha", "Gamma"] },
  "srdc-2": { name: "Bina Senior", role: "srdc", chapter: "Beta", chapters: ["Beta"] },
  "dc-alpha": { name: "Dev Alpha", role: "dc", chapter: "Alpha", chapters: ["Alpha"], phone: "9000000001" },
  "sa-alpha": { name: "Alpha SA", role: "sa1", chapter: "Alpha", chapters: ["Alpha"] },
  "dc-beta": { name: "Dina Beta", role: "dc", chapter: "Beta", chapters: ["Beta"], phone: "9000000002" },
  "sa-beta": { name: "Beta SA", role: "sa1", chapter: "Beta", chapters: ["Beta"] },
  "viewer-1": { name: "Vik Viewer", role: "viewer" }
};

export async function seedRegion() {
  fake.reset();
  for (const [id, a] of Object.entries(accounts)) fake.seed("members", id, { ...a, pinHash });
  fake.seed("chapters", "Alpha", { name: "Alpha", day: "Tuesday", order: 1, target: 40, openingMembers: 30, seniorDirector: "Sameer Senior", seniorDirectorId: "srdc-1" });
  fake.seed("chapters", "Beta", { name: "Beta", day: "Friday", order: 2, target: 30, seniorDirector: "Bina Senior", seniorDirectorId: "srdc-2" });
  fake.seed("chapters", "Gamma", { name: "Gamma", day: "Wednesday", order: 3, target: 25, seniorDirector: "Sameer Senior", seniorDirectorId: "srdc-1" });
  fake.seed("meta", "config", { srPinHash: officePinHash, srCallDay: "Friday" });
  // Drop every server-side cached copy so each test sees exactly what it seeded, and
  // publish that change the way a real save does (writeActivity always publishes).
  invalidateSnapshotCache();
  await publishCacheStamps();
}

export const tokenFor = user => "Bearer " + signSession(user);

// Calls the API as `user` (null = signed out). Returns { status, body } or { status, error }.
export async function call(user, method, path, body, { ip, query } = {}) {
  try {
    const r = await routeApi({
      method, segments: path.split("/").filter(Boolean).map(decodeURIComponent), body,
      authorization: user ? tokenFor(user) : undefined, query: query || {}, ip
    });
    return { status: r.status, body: r.body };
  } catch (e) {
    return { status: e.status || 500, error: e.message };
  }
}
