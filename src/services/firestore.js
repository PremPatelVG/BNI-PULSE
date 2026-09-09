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
  "growthSummary",
  "lengthOfMembership",
  "monthlyTargets",
  "tlr"
]);

// meta/config holds the Sr. DC master PIN, which must never be serialised to a client.
const META_PRIVATE_FIELDS = { config: ["srPin"] };

// Collections every signed-in client needs on load. Deliberately excludes the two
// largest, `miyagiMembers` (~1.3k docs) and `activityLog` (~900 and unbounded):
// they are only needed by the Miyagi/Call Mode and Activity Log tabs, so they are
// fetched on demand instead. Together they were ~80% of every snapshot's reads.
export const SNAPSHOT_COLLECTIONS = [
  "chapters",
  "members",
  "weeklyData",
  "visitorPipeline",
  "attendance",
  "renewalsDone"
];

// Fetched on demand by the tab that needs them (see COLLECTION_READ_ALLOWLIST).
export const ON_DEMAND_COLLECTIONS = ["miyagiMembers", "activityLog"];

export const SNAPSHOT_META_DOCS = [
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "growthSummary",
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

export async function listCollection(name, orderBy, limit) {
  const db = getDb();
  let query = db.collection(name);
  if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction || "asc");
  // A limit is applied by Firestore, so a capped read costs only the rows it returns
  // rather than the whole collection.
  if (limit) query = query.limit(limit);
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
  // Every meta write funnels through here, so this is the one place that has to drop
  // the cached copy of that document.
  invalidateSnapshotCache(docId);
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
  const filtered = filterRowsToScope(
    user,
    rows.map(row => ({ ...row, chapter: row[spec.chapterField] }))
  );
  // Strip only the *synthetic* `chapter` key we added for scoping. When the row's real
  // chapter field is already named `chapter` (dues), that key IS the real value, so
  // stripping it would leave every renewal with no chapter and drop it from the UI.
  const scoped = spec.chapterField === "chapter"
    ? filtered
    : filtered.map(({ chapter: _synthetic, ...row }) => row);
  return { ...doc, [spec.listField]: scoped };
}

// The whole dashboard reads the same dataset on every poll, which on the Firebase free
// tier (50k reads/day) is easily exhausted. The raw reads are identical for every user
// (scoping happens afterwards in memory), so they are cached and shared across all
// concurrent requests.
//
// The cache is held PER COLLECTION rather than as one blob: a write to weeklyData drops
// only weeklyData, so the next poll re-reads ~230 docs instead of the entire snapshot.
// Previously every write invalidated everything, which - because every write also logs
// activity - meant the full dataset was re-read continuously during normal use.
const RAW_SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_CACHE_MS || 300000);
const colCache = new Map();   // name  -> { rows, expiresAt }
const metaCache = new Map();  // docId -> { doc, expiresAt }
const inFlight = new Map();   // key   -> Promise

// Pass the collection/meta names that actually changed. No argument clears everything
// (used only where the change is genuinely global).
export function invalidateSnapshotCache(names) {
  if (!names) { colCache.clear(); metaCache.clear(); return; }
  for (const name of [].concat(names)) { colCache.delete(name); metaCache.delete(name); }
}

function fresh(entry) { return entry && entry.expiresAt > Date.now(); }

// Coalesces concurrent callers for the same key onto one Firestore read.
function once(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => { try { return await fn(); } finally { inFlight.delete(key); } })();
  inFlight.set(key, p);
  return p;
}

async function cachedCollection(name) {
  const hit = colCache.get(name);
  if (fresh(hit)) return hit.rows;
  return once("c:" + name, async () => {
    const orderBy = name === "chapters" ? { field: "order" }
      : name === "weeklyData" ? { field: "date", direction: "desc" }
        : null;
    let rows = await listCollection(name, orderBy);
    if (name === "members") rows = rows.map(m => ({ id: m.id, ...stripPrivateMember(m) }));
    colCache.set(name, { rows, expiresAt: Date.now() + RAW_SNAPSHOT_TTL_MS });
    return rows;
  });
}

// Shared cache for the on-demand collections (miyagiMembers, activityLog). Without it
// every DC opening the Miyagi tab pays its own ~1.3k reads; with it they share one
// fetch for the TTL. Safe to key by name: these are not in the snapshot, so there is no
// collision with cachedCollection's differently-shaped reads.
export async function cachedListCollection(name, orderBy, limit) {
  const hit = colCache.get(name);
  if (fresh(hit)) return hit.rows;
  return once("c:" + name, async () => {
    const rows = await listCollection(name, orderBy, limit);
    colCache.set(name, { rows, expiresAt: Date.now() + RAW_SNAPSHOT_TTL_MS });
    return rows;
  });
}

async function cachedMeta(id) {
  const hit = metaCache.get(id);
  if (fresh(hit)) return hit.doc;
  return once("m:" + id, async () => {
    const doc = await getMetaDoc(id);
    metaCache.set(id, { doc, expiresAt: Date.now() + RAW_SNAPSHOT_TTL_MS });
    return doc;
  });
}

// Unscoped, credential-free snapshot. Safe to share: members are stripped of pinHash
// and meta of its private fields before caching.
async function fetchRawSnapshot() {
  const [collections, metaEntries] = await Promise.all([
    Promise.all(SNAPSHOT_COLLECTIONS.map(async name => [name, await cachedCollection(name)])),
    Promise.all(SNAPSHOT_META_DOCS.map(async id => [id, await cachedMeta(id)]))
  ]);
  return { collections: Object.fromEntries(collections), meta: Object.fromEntries(metaEntries) };
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

// Region-wide monthly TLR: stores the snapshot (tagged with its month) and refreshes
// the tlr/conversion values on every weekly entry in that month, in one batched write.
export async function applyTlrForMonth(user, { monthIso, monthLabel, rows }) {
  const db = getDb();
  // De-duplicate chapter rows so one chapter can never end up with two TLR rows.
  // The report can be parsed with duplicate rows, or an older client could send
  // some; keep one (richest) row per chapter. This replaces the whole doc, so the
  // stored TLR is always exactly one row per chapter for the uploaded month.
  const _tn = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const _rich = r => Object.values(r).filter(v => v !== "" && v != null).length;
  const _idx = new Map(); const _rows = [];
  (rows || []).forEach(r => { const k = _tn(r.name); if (!k) return; if (_idx.has(k)) { const j = _idx.get(k); if (_rich(r) > _rich(_rows[j])) _rows[j] = r; return; } _idx.set(k, _rows.length); _rows.push(r); });
  rows = _rows;
  await db.collection("meta").doc("tlr").set({
    rows,
    reportMonth: monthIso,
    monthLabel: monthLabel || "",
    uploadedAt: new Date().toISOString().slice(0, 10),
    uploadedBy: user?.name || "system"
  });

  const norm = s => String(s || "").toLowerCase().replace(/^bni\s+/, "").trim();
  const byChapter = new Map();
  rows.forEach(r => { if (r.name) byChapter.set(norm(r.name), r); });
  const lookup = chapter => {
    const key = norm(chapter);
    if (byChapter.has(key)) return byChapter.get(key);
    for (const [k, v] of byChapter) if (k && (k.includes(key) || key.includes(k))) return v;
    return null;
  };

  const snap = await db.collection("weeklyData")
    .where("date", ">=", `${monthIso}-01`).where("date", "<=", `${monthIso}-31`).get();
  let updated = 0, batch = db.batch(), ops = 0;
  for (const doc of snap.docs) {
    const row = lookup(doc.data().chapter);
    if (!row) continue;
    const update = { tlr: Number(row.score) || 0 };
    const conv = parseFloat(String(row.conversion == null ? "" : row.conversion).replace("%", ""));
    if (!Number.isNaN(conv)) update.conversionPct = Math.round(conv);
    batch.set(doc.ref, update, { merge: true });
    updated++; ops++;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops) await batch.commit();

  // The TLR upload rewrites meta/tlr and touches that month's weekly entries.
  invalidateSnapshotCache(["tlr", "weeklyData"]);
  return { chaptersUpdated: rows.length, weeklyEntriesUpdated: updated, month: monthIso };
}

export async function writeActivity(user, action, details = {}) {
  // Logging an action does not change any snapshot collection, so it must NOT drop the
  // shared cache - doing so re-read the entire dataset on every click. Callers that
  // actually change data invalidate their own collection (see routeApi).
  invalidateSnapshotCache("activityLog");
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
