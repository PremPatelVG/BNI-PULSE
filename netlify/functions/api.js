import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config as appConfig } from "../../src/config.js";
import { getDb } from "../../src/firebaseAdmin.js";
import { signSession } from "../../src/middleware/auth.js";
import {
  docToData,
  getMetaDoc,
  listCollection,
  setMetaDoc,
  stripPrivateMember,
  writeActivity
} from "../../src/services/firestore.js";

const COLLECTION_READ_ALLOWLIST = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers", "activityLog"]);
const COLLECTION_WRITE_ALLOWLIST = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers"]);
const COLLECTION_DELETE_ALLOWLIST = new Set(["visitorPipeline", "miyagiMembers"]);

function json(data, status = 200) {
  return Response.json(data, { status });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function error(message, status = 500) {
  return json({ error: message }, status);
}

async function readJson(req) {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

function publicUser(id, data) {
  return {
    id,
    name: data.name,
    role: data.role,
    chapter: data.chapter || null,
    chapters: data.chapters || [],
    reportsTo: data.reportsTo || "",
    seniorDirectorId: data.seniorDirectorId || "",
    areaDirectorId: data.areaDirectorId || ""
  };
}

async function pinMatches(member, pin) {
  if (member.pinHash) return bcrypt.compare(pin, member.pinHash);
  return member.pin && member.pin === pin;
}

function authUser(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const err = new Error("Authentication required");
    err.status = 401;
    throw err;
  }

  try {
    return jwt.verify(token, appConfig.jwtSecret);
  } catch {
    const err = new Error("Invalid or expired session");
    err.status = 401;
    throw err;
  }
}

function requireRole(user, ...roles) {
  if (!user || !roles.includes(user.role)) {
    const err = new Error("Insufficient permissions");
    err.status = 403;
    throw err;
  }
}

function pathParts(req) {
  const pathname = new URL(req.url).pathname.replace(/^\/(?:api|\.netlify\/functions\/api)\/?/, "");
  return pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
}

async function login(req) {
  const { memberId, pin } = await readJson(req);
  if (!memberId || !pin) return error("memberId and pin are required", 400);

  const db = getDb();

  if (memberId === "__srdc__") {
    const cfg = await db.collection("meta").doc("config").get();
    const srPin = cfg.exists ? cfg.data().srPin : "";
    const fallback = appConfig.srAdminPin;
    if (!srPin && !fallback) return error("Sr. DC login is not configured", 503);
    if (pin !== srPin && pin !== fallback) return error("Incorrect PIN", 401);

    const user = { id: "__srdc__", name: "Dinesh Sitlani", role: "srdc", chapter: null, chapters: [] };
    return json({ token: signSession(user), user });
  }

  const doc = await db.collection("members").doc(memberId).get();
  if (!doc.exists || !(await pinMatches(doc.data(), pin))) return error("Incorrect PIN", 401);

  const user = publicUser(doc.id, doc.data());
  return json({ token: signSession(user), user });
}

async function bootstrap() {
  const [chapters, members, weeklyData, visitorPipeline, miyagiMembers] = await Promise.all([
    listCollection("chapters", { field: "order" }),
    listCollection("members"),
    listCollection("weeklyData", { field: "date", direction: "desc" }),
    listCollection("visitorPipeline"),
    listCollection("miyagiMembers")
  ]);

  const metaIds = ["branding", "chapterGoals", "config", "dues", "lengthOfMembership", "monthlyTargets", "tlr"];
  const metaEntries = await Promise.all(metaIds.map(async id => [id, await getMetaDoc(id)]));

  return json({
    chapters,
    members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })),
    weeklyData,
    visitorPipeline,
    miyagiMembers,
    meta: Object.fromEntries(metaEntries)
  });
}

async function hierarchy() {
  const [members, chapters] = await Promise.all([
    listCollection("members"),
    listCollection("chapters", { field: "order" })
  ]);
  const publicMembers = members.map(member => ({ id: member.id, ...stripPrivateMember(member) }));
  const isChapterDirector = role => role === "dc" || role === "cd";

  return json({
    areaDirectors: publicMembers.filter(member => member.role === "ad"),
    seniorDirectors: publicMembers.filter(member => member.role === "srdc"),
    chapterDirectors: publicMembers.filter(member => isChapterDirector(member.role)),
    chapters: chapters.map(chapter => ({
      ...chapter,
      seniorDirector: publicMembers.find(member => member.role === "srdc" && (member.chapters || []).includes(chapter.name)) || null,
      chapterDirector: publicMembers.find(member => isChapterDirector(member.role) && (member.chapters || [member.chapter]).includes(chapter.name)) || null
    }))
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return empty(204);

  try {
    const parts = pathParts(req);
    const [first, second, third] = parts;

    if (first === "auth" && second === "login" && req.method === "POST") return login(req);

    const user = authUser(req);

    if (first === "auth" && second === "me" && req.method === "GET") return json({ user });
    if (first === "bootstrap" && req.method === "GET") return bootstrap();
    if (first === "hierarchy" && req.method === "GET") return hierarchy();

    if (first === "chapters" && req.method === "GET") {
      return json({ chapters: await listCollection("chapters", { field: "order" }) });
    }

    if (first === "chapters" && req.method === "POST") {
      requireRole(user, "ad", "srdc");
      const data = await readJson(req);
      if (!data.name) return error("Chapter name is required", 400);
      await getDb().collection("chapters").doc(data.id || data.name).set(data, { merge: Boolean(data.id) });
      await writeActivity(user, "chapter_saved", { chapterName: data.name });
      return json({ chapter: data }, 201);
    }

    if (first === "members" && req.method === "GET") {
      const members = await listCollection("members");
      return json({ members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })) });
    }

    if (first === "members" && req.method === "POST") {
      requireRole(user, "ad", "srdc");
      const { id, pin, ...member } = await readJson(req);
      if (!member.name) return error("Member name is required", 400);
      if (member.role === "cd") member.role = "dc";
      if (pin) member.pinHash = await bcrypt.hash(pin, 12);
      const docId = id || `m${Date.now()}`;
      await getDb().collection("members").doc(docId).set(member, { merge: Boolean(id) });
      await writeActivity(user, "member_saved", { memberName: member.name });
      return json({ member: { id: docId, ...stripPrivateMember(member) } }, 201);
    }

    if (first === "members" && second && req.method === "DELETE") {
      requireRole(user, "ad", "srdc");
      await getDb().collection("members").doc(second).delete();
      await writeActivity(user, "member_deleted", { memberId: second });
      return empty();
    }

    if (first === "weekly-data" && req.method === "GET") {
      return json({ weeklyData: await listCollection("weeklyData", { field: "date", direction: "desc" }) });
    }

    if (first === "weekly-data" && second && third && req.method === "PUT") {
      const body = await readJson(req);
      const id = `${second}_${third}`;
      const entry = { ...body, chapter: second, date: third, updatedAt: new Date().toISOString(), updatedBy: user.sub };
      await getDb().collection("weeklyData").doc(id).set(entry, { merge: true });
      await writeActivity(user, "weekly_entry_saved", { chapter: second, date: third });
      return json({ entry: { id, ...entry } });
    }

    if (first === "weekly-data" && second && third && req.method === "DELETE") {
      await getDb().collection("weeklyData").doc(`${second}_${third}`).delete();
      await writeActivity(user, "weekly_entry_deleted", { chapter: second, date: third });
      return empty();
    }

    if (first === "meta" && second && req.method === "GET") {
      return json({ meta: await getMetaDoc(second) });
    }

    if (first === "meta" && second && req.method === "PUT") {
      requireRole(user, "ad", "srdc");
      const meta = await setMetaDoc(second, await readJson(req), true);
      await writeActivity(user, "meta_saved", { docId: second });
      return json({ meta });
    }

    if (COLLECTION_READ_ALLOWLIST.has(first) && req.method === "GET") {
      return json({ rows: await listCollection(first) });
    }

    if (COLLECTION_WRITE_ALLOWLIST.has(first) && second && req.method === "PUT") {
      await getDb().collection(first).doc(second).set(await readJson(req), { merge: true });
      const doc = await getDb().collection(first).doc(second).get();
      await writeActivity(user, `${first}_saved`, { id: second });
      return json({ row: docToData(doc) });
    }

    if (COLLECTION_DELETE_ALLOWLIST.has(first) && second && req.method === "DELETE") {
      await getDb().collection(first).doc(second).delete();
      await writeActivity(user, `${first}_deleted`, { id: second });
      return empty();
    }

    return error("Unknown API route", 404);
  } catch (err) {
    if ((err.status || 500) >= 500) console.error(err);
    return error(err.message || "Internal server error", err.status || 500);
  }
};

export const config = {
  path: "/api/*"
};
