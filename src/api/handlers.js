// Single implementation of every API route. The Express server and the Netlify
// function are thin adapters over this module, so the two deployments cannot drift.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getDb } from "../firebaseAdmin.js";
import { signSession } from "../middleware/auth.js";
import {
  buildSnapshot,
  docToData,
  getMetaDoc,
  getRawMetaDoc,
  listCollection,
  loginDirectoryMember,
  setMetaDoc,
  stripPrivateMember,
  writeActivity
} from "../services/firestore.js";
import {
  assertAdmin,
  assertCanWrite,
  assertCanWriteChapter,
  badRequest,
  filterRowsToScope,
  isViewer,
  notFound
} from "../services/scope.js";

const COLLECTION_READ_ALLOWLIST = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers", "activityLog"]);
const COLLECTION_WRITE_ALLOWLIST = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers"]);
const COLLECTION_DELETE_ALLOWLIST = new Set(["visitorPipeline", "miyagiMembers"]);

// Meta documents only Area/Senior Directors may change.
const ADMIN_META_DOCS = new Set(["branding", "config"]);
// Meta documents holding per-chapter rows, merged server-side so a writer can only
// ever replace the slice of the document their scope covers.
const SCOPED_META_DOCS = { dues: { listField: "members", chapterField: "chapter" }, tlr: { listField: "rows", chapterField: "name" } };

const SR_LOGIN_ID = "__srdc__";

export function ok(body, status = 200) {
  return { status, body };
}

export function noContent() {
  return { status: 204, body: null };
}

export function verifyToken(authorization) {
  const header = authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const err = new Error("Authentication required");
    err.status = 401;
    throw err;
  }
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    const err = new Error("Invalid or expired session");
    err.status = 401;
    throw err;
  }
}

function publicUser(id, data) {
  return {
    id,
    name: data.name,
    role: data.role,
    chapter: data.chapter || null,
    chapters: data.chapters || [],
    reportsTo: data.reportsTo || "",
    chapterReportsTo: data.chapterReportsTo || {},
    seniorDirectorId: data.seniorDirectorId || "",
    areaDirectorId: data.areaDirectorId || ""
  };
}

// Only bcrypt hashes are accepted. Plaintext `pin` fields left over from older
// records are rejected so a legacy document cannot weaken the check.
async function pinMatches(member, pin) {
  if (!member?.pinHash) return false;
  return bcrypt.compare(pin, member.pinHash);
}

async function srPinMatches(pin) {
  const cfg = await getRawMetaDoc("config");
  if (cfg.srPinHash) return bcrypt.compare(pin, cfg.srPinHash);
  // First-run fallback only, per the deployment docs.
  if (config.srAdminPin) return pin === config.srAdminPin;
  return null;
}

async function login(body) {
  const { memberId, pin } = body || {};
  if (!memberId || !pin) throw badRequest("memberId and pin are required");

  if (memberId === SR_LOGIN_ID) {
    const result = await srPinMatches(pin);
    if (result === null) {
      const err = new Error("Sr. DC login is not configured");
      err.status = 503;
      throw err;
    }
    if (!result) {
      const err = new Error("Incorrect PIN");
      err.status = 401;
      throw err;
    }
    const user = { id: SR_LOGIN_ID, name: "Senior Director (master)", role: "srdc", chapter: null, chapters: [] };
    return ok({ token: signSession(user), user });
  }

  const doc = await getDb().collection("members").doc(memberId).get();
  if (!doc.exists || !(await pinMatches(doc.data(), pin))) {
    const err = new Error("Incorrect PIN");
    err.status = 401;
    throw err;
  }

  const user = publicUser(doc.id, doc.data());
  return ok({ token: signSession(user), user });
}

// Unauthenticated: the login screen needs names to populate its dropdown. Returns
// the narrowest possible projection, never credentials.
async function loginDirectory() {
  const members = await listCollection("members");
  return ok({
    members: members.map(member => ({ id: member.id, ...loginDirectoryMember(member) }))
  });
}

// Unauthenticated: logos are painted on the login screen before any session exists.
async function publicBranding() {
  return ok({ branding: await getMetaDoc("branding") });
}

async function hierarchy(user) {
  const [members, chapters] = await Promise.all([
    listCollection("members"),
    listCollection("chapters", { field: "order" })
  ]);
  const publicMembers = members.map(member => ({ id: member.id, ...stripPrivateMember(member) }));
  const isChapterDirector = role => role === "dc" || role === "cd";

  return ok({
    areaDirectors: publicMembers.filter(member => member.role === "ad"),
    seniorDirectors: publicMembers.filter(member => member.role === "srdc"),
    chapterDirectors: publicMembers.filter(member => isChapterDirector(member.role)),
    chapters: filterRowsToScope(user, chapters.map(chapter => ({ ...chapter, chapter: chapter.name }))).map(chapter => ({
      ...chapter,
      seniorDirector: publicMembers.find(member => member.role === "srdc" && (member.chapters || []).includes(chapter.name)) || null,
      chapterDirector: publicMembers.find(member => isChapterDirector(member.role) && (member.chapters || [member.chapter]).includes(chapter.name)) || null
    }))
  });
}

// Merge a scoped meta document so a writer replaces only their own chapters' rows
// and physically cannot clobber the rest of the region.
async function writeScopedMeta(user, docId, body) {
  const { listField, chapterField } = SCOPED_META_DOCS[docId];
  const incoming = Array.isArray(body?.[listField]) ? body[listField] : [];
  const rejected = incoming.filter(row => {
    const chapterName = row?.[chapterField];
    try {
      assertCanWriteChapter(user, chapterName);
      return false;
    } catch {
      return true;
    }
  });
  if (rejected.length) {
    throw badRequest(`Upload contains ${rejected.length} row(s) outside your chapters`);
  }

  const existingDoc = await getMetaDoc(docId);
  const existing = Array.isArray(existingDoc?.[listField]) ? existingDoc[listField] : [];
  const touchedChapters = new Set(incoming.map(row => row?.[chapterField]).filter(Boolean));
  const preserved = existing.filter(row => !touchedChapters.has(row?.[chapterField]));

  const { [listField]: _ignored, ...rest } = body || {};
  const meta = await setMetaDoc(docId, { ...rest, [listField]: [...preserved, ...incoming] }, true);
  await writeActivity(user, "meta_saved", { docId, rowCount: incoming.length });
  return ok({ meta });
}

// method: "GET" | "POST" | ... ; segments: path below /api, already decoded.
export async function routeApi({ method, segments, body, authorization }) {
  const [first, second, third] = segments;

  if (first === "auth" && second === "login" && method === "POST") return login(body);
  if (first === "auth" && second === "login-directory" && method === "GET") return loginDirectory();
  if (first === "auth" && second === "branding" && method === "GET") return publicBranding();

  const user = verifyToken(authorization);

  if (first === "auth" && second === "me" && method === "GET") return ok({ user });

  if (first === "auth" && second === "sr-pin" && method === "PUT") {
    assertAdmin(user);
    const pin = String(body?.pin || "");
    if (pin.length < 4) throw badRequest("PIN must be at least 4 digits");
    await setMetaDoc("config", { srPinHash: await bcrypt.hash(pin, 12), srPin: null }, true);
    await writeActivity(user, "sr_pin_changed", {});
    return ok({ ok: true });
  }

  if (first === "snapshot" && method === "GET") return ok(await buildSnapshot(user));

  if (first === "bootstrap" && method === "GET") {
    const snapshot = await buildSnapshot(user);
    return ok({ ...snapshot.collections, meta: snapshot.meta });
  }

  if (first === "hierarchy" && method === "GET") return hierarchy(user);

  if (first === "chapters" && method === "GET") {
    const chapters = await listCollection("chapters", { field: "order" });
    return ok({ chapters: filterRowsToScope(user, chapters.map(c => ({ ...c, chapter: c.name }))) });
  }

  if (first === "chapters" && method === "POST") {
    assertAdmin(user);
    if (!body?.name) throw badRequest("Chapter name is required");
    await getDb().collection("chapters").doc(body.id || body.name).set(body, { merge: Boolean(body.id) });
    await writeActivity(user, "chapter_saved", { chapterName: body.name });
    return ok({ chapter: body }, 201);
  }

  if (first === "members" && method === "GET") {
    const members = await listCollection("members");
    return ok({ members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })) });
  }

  if (first === "members" && method === "POST") {
    assertAdmin(user);
    const { id, pin, pinHash: _rejectedHash, ...member } = body || {};
    if (!member.name) throw badRequest("Member name is required");
    if (member.role === "cd") member.role = "dc";
    // Credentials are hashed here and only here; a plaintext `pin` never reaches Firestore.
    if (pin) {
      if (String(pin).length < 4) throw badRequest("PIN must be at least 4 digits");
      member.pinHash = await bcrypt.hash(String(pin), 12);
    }
    const docId = id || `m${Date.now()}`;
    await getDb().collection("members").doc(docId).set(member, { merge: Boolean(id) });
    await writeActivity(user, "member_saved", { memberName: member.name, passwordChanged: Boolean(pin) });
    return ok({ member: { id: docId, ...stripPrivateMember(member) } }, 201);
  }

  if (first === "members" && second && method === "DELETE") {
    assertAdmin(user);
    await getDb().collection("members").doc(second).delete();
    await writeActivity(user, "member_deleted", { memberId: second });
    return noContent();
  }

  if (first === "weekly-data" && method === "GET") {
    const rows = await listCollection("weeklyData", { field: "date", direction: "desc" });
    return ok({ weeklyData: filterRowsToScope(user, rows) });
  }

  if (first === "weekly-data" && second && third && method === "PUT") {
    assertCanWriteChapter(user, second);
    const id = `${second}_${third}`;
    const entry = { ...body, chapter: second, date: third, updatedAt: new Date().toISOString(), updatedBy: user.sub };
    await getDb().collection("weeklyData").doc(id).set(entry, { merge: true });
    await writeActivity(user, "weekly_entry_saved", { chapter: second, date: third });
    return ok({ entry: { id, ...entry } });
  }

  if (first === "weekly-data" && second && third && method === "DELETE") {
    assertCanWriteChapter(user, second);
    await getDb().collection("weeklyData").doc(`${second}_${third}`).delete();
    await writeActivity(user, "weekly_entry_deleted", { chapter: second, date: third });
    return noContent();
  }

  if (first === "meta" && second && method === "GET") return ok({ meta: await getMetaDoc(second) });

  if (first === "meta" && second && method === "PUT") {
    assertCanWrite(user);
    if (ADMIN_META_DOCS.has(second)) assertAdmin(user);
    if (SCOPED_META_DOCS[second]) return writeScopedMeta(user, second, body);
    // srPin is only settable through the dedicated hashed endpoint above.
    const { srPin: _blockedPin, srPinHash: _blockedHash, ...safeBody } = body || {};
    const meta = await setMetaDoc(second, safeBody, true);
    await writeActivity(user, "meta_saved", { docId: second });
    return ok({ meta });
  }

  if (first === "activity" && method === "POST") {
    assertCanWrite(user);
    await writeActivity(user, String(body?.action || "unknown"), body?.details || {});
    return noContent();
  }

  if (COLLECTION_READ_ALLOWLIST.has(first) && !second && method === "GET") {
    const rows = await listCollection(first);
    return ok({ rows: first === "attendance" ? rows : filterRowsToScope(user, rows) });
  }

  if (COLLECTION_WRITE_ALLOWLIST.has(first) && second && method === "PUT") {
    assertCanWrite(user);
    // Chapter-bearing rows are checked against the writer's scope, both for the row
    // being written and for the row already in place.
    if (body?.chapter) assertCanWriteChapter(user, body.chapter);
    const ref = getDb().collection(first).doc(second);
    const before = await ref.get();
    if (before.exists && before.data().chapter) assertCanWriteChapter(user, before.data().chapter);
    await ref.set(body || {}, { merge: true });
    const doc = await ref.get();
    await writeActivity(user, `${first}_saved`, { id: second });
    return ok({ row: docToData(doc) });
  }

  if (COLLECTION_DELETE_ALLOWLIST.has(first) && second && method === "DELETE") {
    assertCanWrite(user);
    const ref = getDb().collection(first).doc(second);
    const before = await ref.get();
    if (before.exists && before.data().chapter) assertCanWriteChapter(user, before.data().chapter);
    await ref.delete();
    await writeActivity(user, `${first}_deleted`, { id: second });
    return noContent();
  }

  throw notFound("Unknown API route");
}

export { isViewer };
