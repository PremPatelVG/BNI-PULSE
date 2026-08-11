import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../firebaseAdmin.js";

const PUBLIC_MEMBER_FIELDS = [
  "name",
  "role",
  "chapter",
  "chapters",
  "reportsTo",
  "seniorDirectorId",
  "areaDirectorId"
];
const META_DOCS = new Set([
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "lengthOfMembership",
  "monthlyTargets",
  "tlr"
]);

export function stripPrivateMember(member) {
  return Object.fromEntries(
    Object.entries(member).filter(([key]) => PUBLIC_MEMBER_FIELDS.includes(key))
  );
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
  return doc.exists ? { id: doc.id, ...doc.data() } : { id: docId };
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

export async function writeActivity(user, action, details = {}) {
  await getDb().collection("activityLog").add({
    team: "argonauts",
    action,
    details,
    userName: user?.name || user?.sub || "system",
    userRole: user?.role || "system",
    chapter: user?.chapter || null,
    timestamp: new Date().toISOString(),
    createdAt: FieldValue.serverTimestamp()
  });
}
