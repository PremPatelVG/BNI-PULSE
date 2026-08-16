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

// One round trip that backs every live view in the dashboard. Everything is filtered
// to the caller's scope here, on the server, so the browser never receives rows the
// user is not entitled to see.
export async function buildSnapshot(user) {
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
      // `attendance` is keyed by week with member ids as fields, so it carries no
      // chapter of its own and is left intact; every other collection is scoped.
      if (name === "chapters") {
        // Chapter documents name themselves in `name` rather than `chapter`.
        rows = filterRowsToScope(user, rows.map(row => ({ ...row, chapter: row.name })))
          .map(({ chapter: _synthetic, ...row }) => row);
      } else if (name !== "attendance") {
        rows = filterRowsToScope(user, rows);
      }
      return [name, rows];
    })),
    Promise.all(SNAPSHOT_META_DOCS.map(async id => [id, scopeMetaDoc(user, id, await getMetaDoc(id))]))
  ]);

  return {
    collections: Object.fromEntries(collections),
    meta: Object.fromEntries(metaEntries)
  };
}

export async function writeActivity(user, action, details = {}) {
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
