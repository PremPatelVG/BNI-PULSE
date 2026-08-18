import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../firebaseAdmin.js";
import { filterRowsToScope } from "./scope.js";

// Fields that may leave the server on a member record. `pin` and `pinHash` are
// deliberately absent: credentials never travel to the browser.
const PUBLIC_MEMBER_FIELDS = [
  "name",
  "role",
  "chapter",
  "chapters",
  "reportsTo",
  "chapterReportsTo",
  "seniorDirectorId",
  "areaDirectorId"
];

// The subset the pre-login dropdown needs. Narrower than PUBLIC_MEMBER_FIELDS
// because this one is served without authentication.
const LOGIN_DIRECTORY_FIELDS = ["name", "role", "chapter", "chapters", "reportsTo"];

const META_DOCS = new Set([
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "lengthOfMembership",
  "monthlyTargets",
  "tlr"
]);

// meta/config holds the Sr. DC master PIN, which must never be serialised to a client.
const META_PRIVATE_FIELDS = { config: ["srPin"] };

export const SNAPSHOT_COLLECTIONS = [
  "chapters",
  "members",
  "weeklyData",
  "visitorPipeline",
  "miyagiMembers",
  "attendance",
  "renewalsDone",
  "activityLog"
];

export const SNAPSHOT_META_DOCS = [
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "lengthOfMembership",
  "monthlyTargets",
  "tlr"
];

function pick(source, fields) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => fields.includes(key)));
}

export function stripPrivateMember(member) {
  return pick(member, PUBLIC_MEMBER_FIELDS);
}

export function loginDirectoryMember(member) {
  return pick(member, LOGIN_DIRECTORY_FIELDS);
}

export function stripPrivateMeta(docId, data) {
  const privateFields = META_PRIVATE_FIELDS[docId];
  if (!privateFields) return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => !privateFields.includes(key)));
}

export function docToData(doc) {
  return { id: doc.id, ...doc.data() };
}

export async function listCollection(name, orderBy) {
  const db = getDb();
  let query = db.collection(name);
  if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction || "asc");
  const snap = await query.get();
  return snap.docs.map(docToData);
}

export async function getMetaDoc(docId) {
  if (!META_DOCS.has(docId)) {
    const error = new Error("Unsupported meta document");
    error.status = 404;
    throw error;
  }

  const doc = await getDb().collection("meta").doc(docId).get();
  const data = doc.exists ? { id: doc.id, ...doc.data() } : { id: docId };
  return stripPrivateMeta(docId, data);
}

// Internal reads that need the private fields (e.g. verifying the Sr. DC PIN).
export async function getRawMetaDoc(docId) {
  const doc = await getDb().collection("meta").doc(docId).get();
  return doc.exists ? doc.data() : {};
}

export async function setMetaDoc(docId, data, merge = true) {
  if (!META_DOCS.has(docId)) {
    const error = new Error("Unsupported meta document");
    error.status = 404;
    throw error;
  }

  await getDb().collection("meta").doc(docId).set(data, { merge });
  return getMetaDoc(docId);
}

// meta/dues and meta/tlr hold one row per chapter for the whole region. They are
// documents rather than collections, so the collection-level scoping above misses
// them: without this a single-chapter director received every chapter's membership
// dues and traffic-light scores.
const SCOPED_META_ROWS = {
  dues: { listField: "members", chapterField: "chapter" },
  tlr: { listField: "rows", chapterField: "name" }
};

function scopeMetaDoc(user, docId, doc) {
  const spec = SCOPED_META_ROWS[docId];
  if (!spec || !doc) return doc;
  const rows = doc[spec.listField];
  if (!Array.isArray(rows)) return doc;
  const scoped = filterRowsToScope(
    user,
    rows.map(row => ({ ...row, chapter: row[spec.chapterField] }))
  ).map(({ chapter: _synthetic, ...row }) => row);
  return { ...doc, [spec.listField]: scoped };
}

// The whole dashboard reads the entire dataset on every poll, which on the Firebase
// free tier (50k reads/day) is easily exhausted by a few open tabs. The raw reads are
// identical for every user (scoping happens afterwards in memory), so they are cached
// briefly and shared across all concurrent requests. Any write invalidates the cache,
// so an edit is visible on the next poll rather than after the TTL.
const RAW_SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_CACHE_MS || 30000);
let rawSnapshotCache = null; // { data, expiresAt }
let rawSnapshotInFlight = null;

export function invalidateSnapshotCache() {
  rawSnapshotCache = null;
}

// Unscoped, credential-free snapshot of every collection and meta document. Safe to
// share: members are stripped of pinHash and meta of its private fields before caching.
async function fetchRawSnapshot() {
  if (rawSnapshotCache && rawSnapshotCache.expiresAt > Date.now()) return rawSnapshotCache.data;
  if (rawSnapshotInFlight) return rawSnapshotInFlight;

  rawSnapshotInFlight = (async () => {
    try {
      const [collections, metaEntries] = await Promise.all([
        Promise.all(SNAPSHOT_COLLECTIONS.map(async name => {
          const orderBy = name === "chapters" ? { field: "order" }
            : name === "weeklyData" ? { field: "date", direction: "desc" }
              : null;
          let rows = await listCollection(name, orderBy);
          if (name === "members") {
            rows = rows.map(member => ({ id: member.id, ...stripPrivateMember(member) }));
          }
          if (name === "activityLog") {
            rows = rows
              .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
              .slice(0, 500);
          }
          return [name, rows];
        })),
        Promise.all(SNAPSHOT_META_DOCS.map(async id => [id, await getMetaDoc(id)]))
      ]);
      const data = { collections: Object.fromEntries(collections), meta: Object.fromEntries(metaEntries) };
      rawSnapshotCache = { data, expiresAt: Date.now() + RAW_SNAPSHOT_TTL_MS };
      return data;
    } finally {
      rawSnapshotInFlight = null;
    }
  })();
  return rawSnapshotInFlight;
}

// Applies the caller's scope to the shared raw snapshot. Filtering is a cheap in-memory
// pass, so every user can share one set of Firestore reads.
export async function buildSnapshot(user) {
  const raw = await fetchRawSnapshot();

  const collections = Object.fromEntries(Object.entries(raw.collections).map(([name, rows]) => {
    if (name === "chapters") {
      // Chapter documents name themselves in `name` rather than `chapter`.
      const scoped = filterRowsToScope(user, rows.map(row => ({ ...row, chapter: row.name })))
        .map(({ chapter: _synthetic, ...row }) => row);
      return [name, scoped];
    }
    // `attendance` is keyed by week with member ids as fields, so it carries no chapter
    // of its own and is left intact; every other collection is scoped.
    if (name === "attendance") return [name, rows];
    return [name, filterRowsToScope(user, rows)];
  }));

  const meta = Object.fromEntries(Object.entries(raw.meta).map(([id, doc]) => [id, scopeMetaDoc(user, id, doc)]));

  return { collections, meta };
}

export async function writeActivity(user, action, details = {}) {
  // Every write handler routes through here, so this is the single point that drops
  // the shared snapshot cache - the write becomes visible on the next poll.
  invalidateSnapshotCache();
  await getDb().collection("activityLog").add({
    team: "bni_chapter_pulse",
    action,
    details,
    userName: user?.name || user?.sub || "system",
    userRole: user?.role || "system",
    chapter: user?.chapter || null,
    timestamp: new Date().toISOString(),
    createdAt: FieldValue.serverTimestamp()
  });
}
