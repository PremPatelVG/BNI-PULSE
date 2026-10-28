import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../firebaseAdmin.js";
import { canReadChapter, filterRowsToScope, isChapterRole, scopedChapterNames } from "./scope.js";

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
  "areaDirectorId",
  // When the PIN was last set: sessions signed before it are ended (see routeApi).
  "pinChangedAt"
];

// The subset the pre-login dropdown needs (it groups by role and labels by chapter).
// Narrower than PUBLIC_MEMBER_FIELDS because this one is served without authentication.
const LOGIN_DIRECTORY_FIELDS = ["name", "role", "chapter", "chapters"];

const META_DOCS = new Set([
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "growthSummary",
  "preCoreGrowth",
  "monthlyMembers",
  "lengthOfMembership",
  "monthlyTargets",
  "tlr"
]);

// meta/config holds the BNI Office master PIN, which must never be serialised to a
// client - neither the legacy plaintext `srPin` nor its bcrypt `srPinHash` (a hash can
// be brute-forced offline in minutes when the PIN is a few digits).
const META_PRIVATE_FIELDS = { config: ["srPin", "srPinHash"] };

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
  "renewalsDone",
  "renewalsDropped"
];

// Fetched on demand by the tab that needs them (see COLLECTION_READ_ALLOWLIST).
export const ON_DEMAND_COLLECTIONS = ["miyagiMembers", "activityLog"];

export const SNAPSHOT_META_DOCS = [
  "branding",
  "chapterGoals",
  "config",
  "dues",
  "growthSummary",
  "preCoreGrowth",
  "monthlyMembers",
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
  await publishCacheStamps();
  return getMetaDoc(docId);
}

// meta/dues and meta/tlr hold one row per chapter for the whole region. They are
// documents rather than collections, so the collection-level scoping above misses
// them: without this a single-chapter director received every chapter's membership
// dues and traffic-light scores.
const SCOPED_META_ROWS = {
  dues: { listField: "members", chapterField: "chapter" },
  tlr: { listField: "rows", chapterField: "name" },
  // Member names and join dates for every chapter; only the Miyagi sync reads it, and
  // that only for the user's own chapters.
  lengthOfMembership: { listField: "rows", chapterField: "chapter" }
};

// Meta documents keyed by chapter: each top-level key names the chapter it belongs to.
// Also the write rule for PUT /api/meta/:id (a writer may only set their own chapters).
export const CHAPTER_KEYED_META_DOCS = {
  chapterGoals: key => key,
  // `<Chapter>_<YYYY-MM>` or `<Chapter>_<YYYY-MM>_<field>`; chapter names may contain "_".
  monthlyTargets: key => (String(key).match(/^(.+)_\d{4}-\d{2}(?:_[A-Za-z]+)?$/) || [])[1] || null
};

// Region-wide history built for leadership views (TLR month-wise members, the 12-month
// growth summary, Pre-Core growth). Every chapter's rows were sent to every account; a
// scoped account now keeps only its own chapters' rows, and chapter accounts (DC / SA),
// whose screens show no region totals, lose those too. Senior Directors keep the totals
// their region card shows. Chapter names in these imports are matched loosely, the way
// the dashboard matches them ("BNI Faustus" = "Faustus").
const REGION_META_DOCS = {
  monthlyMembers: { lists: ["perChapter", "scorecard.rows"], keyed: ["launches"], totals: ["region", "baseline"] },
  growthSummary: {
    keyed: ["chapters"],
    totals: ["regionCumNet", "regionCurrent", "regionInductions", "regionDrops", "regionRenewals", "regionRetention", "chaptersCount"]
  },
  preCoreGrowth: {
    lists: ["perChapter"],
    totals: ["region", "baseline", "endTotal", "netOverWindow", "cumulativeNetAdded", "currentMembers"]
  }
};

const looseChapter = name => String(name || "").toLowerCase().replace(/^bni\s+/, "").replace(/\s+/g, " ").trim();

function scopeChapterKeyedDoc(user, docId, doc) {
  const chapterOf = CHAPTER_KEYED_META_DOCS[docId];
  return Object.fromEntries(Object.entries(doc).filter(([key]) => {
    if (key === "id") return true;
    const chapterName = chapterOf(key);
    return !chapterName || canReadChapter(user, chapterName);
  }));
}

function scopeRegionDoc(user, docId, doc) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return doc;
  const spec = REGION_META_DOCS[docId];
  const mine = new Set(allowed.map(looseChapter));
  const out = { ...doc };
  for (const path of spec.lists || []) {
    const [field, sub] = path.split(".");
    if (sub) {
      if (out[field] && Array.isArray(out[field][sub])) {
        out[field] = { ...out[field], [sub]: out[field][sub].filter(row => mine.has(looseChapter(row?.chapter))) };
      }
    } else if (Array.isArray(out[field])) {
      out[field] = out[field].filter(row => mine.has(looseChapter(row?.chapter)));
    }
  }
  for (const field of spec.keyed || []) {
    if (out[field] && typeof out[field] === "object") {
      out[field] = Object.fromEntries(Object.entries(out[field]).filter(([name]) => mine.has(looseChapter(name))));
    }
  }
  if (isChapterRole(user)) for (const field of spec.totals || []) delete out[field];
  return out;
}

// `attendance` is keyed by week, with one field per account (`m11: true`, `m11_name`)
// and per chapter. Scoped accounts keep only the fields of their own chapters and of the
// accounts that belong to them - the attendance screens only ever show those.
function scopeAttendance(user, rows, members) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return rows;
  const chapters = new Set(allowed);
  const ids = new Set(members
    .filter(m => [...(m.chapters || []), m.chapter].some(c => chapters.has(c)))
    .map(m => m.id));
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) =>
    key === "id" || chapters.has(key) || ids.has(key.replace(/_name$/, "")))));
}

// GET /api/attendance: scoped exactly like the snapshot's copy.
export async function scopeAttendanceRows(user, rows) {
  if (scopedChapterNames(user) === null) return rows;
  return scopeAttendance(user, rows, await cachedCollection("members"));
}

// Also used by GET /api/meta/:id, which must return exactly what the snapshot would.
export function scopeMetaDoc(user, docId, doc) {
  if (!doc) return doc;
  if (CHAPTER_KEYED_META_DOCS[docId]) return scopeChapterKeyedDoc(user, docId, doc);
  if (REGION_META_DOCS[docId]) return scopeRegionDoc(user, docId, doc);
  const spec = SCOPED_META_ROWS[docId];
  if (!spec) return doc;
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
//
// The cache lives in each server instance's memory, and Netlify runs several instances
// side by side. Dropping an entry after a write only reached the instance that took the
// write; the others kept serving their old copy for up to the full TTL, so a save could
// look lost - and be written back over - when the next request landed elsewhere. Every
// write therefore also records a new "stamp" for the names it changed in one shared
// document (_system/cacheStamps). Each request re-reads that one document and drops any
// cached copy whose stamp has moved, so a change shows everywhere on the next request
// at the cost of one read, instead of re-reading the data itself.
const RAW_SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_CACHE_MS || 300000);
const colCache = new Map();   // name  -> { value, stamp, expiresAt }
const metaCache = new Map();  // docId -> { value, stamp, expiresAt }
const inFlight = new Map();   // key   -> Promise

// The activity log changes on every click and is only an audit view, so its changes are
// kept to the local instance: sharing them would make every instance re-read 500
// entries after each action anywhere in the region.
const LOCAL_ONLY_STAMPS = new Set(["activityLog"]);
const knownStamps = new Map();    // name -> latest stamp this instance knows of
const pendingStamps = new Map();  // name -> stamp not yet written to the shared document

function stampsRef() {
  return getDb().collection("_system").doc("cacheStamps");
}

function newStamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Pass the collection/meta names that actually changed. No argument clears everything
// (used only where the change is genuinely global). The new stamps are queued here and
// written by publishCacheStamps(), which writeActivity() awaits - every write path ends
// by logging its activity, so the stamps land before the response is sent.
export function invalidateSnapshotCache(names) {
  const changed = names
    ? [].concat(names)
    : [...SNAPSHOT_COLLECTIONS, ...ON_DEMAND_COLLECTIONS, ...SNAPSHOT_META_DOCS];
  for (const name of changed) {
    colCache.delete(name);
    metaCache.delete(name);
    const stamp = newStamp();
    knownStamps.set(name, stamp);
    if (!LOCAL_ONLY_STAMPS.has(name)) pendingStamps.set(name, stamp);
  }
}

// A serverless instance can be frozen as soon as its response is sent, so this has to
// be awaited rather than left running in the background.
export async function publishCacheStamps() {
  if (!pendingStamps.size) return;
  const update = Object.fromEntries(pendingStamps);
  pendingStamps.clear();
  try {
    await stampsRef().set(update, { merge: true });
  } catch (err) {
    // Not fatal: the data itself is saved; other instances fall back to the TTL.
    console.error("Could not publish cache stamps", err);
  }
}

// Picks up writes made on other instances. Concurrent callers share one read.
function syncCacheStamps() {
  return once("stamps", async () => {
    try {
      const doc = await stampsRef().get();
      for (const [name, stamp] of Object.entries(doc.exists ? doc.data() : {})) {
        // A stamp of our own still waiting to be written is newer than what was read.
        if (!pendingStamps.has(name)) knownStamps.set(name, stamp);
      }
    } catch (err) {
      console.error("Could not read cache stamps", err);
    }
  });
}

function fresh(name, entry) {
  return Boolean(entry) && entry.expiresAt > Date.now() && entry.stamp === knownStamps.get(name);
}

// Coalesces concurrent callers for the same key onto one Firestore read.
function once(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => { try { return await fn(); } finally { inFlight.delete(key); } })();
  inFlight.set(key, p);
  return p;
}

// Serves `name` from `cache`, loading it when missing, expired, or stamped by a newer
// write. The stamp is taken before the read, so a write that lands mid-read leaves the
// result marked stale; and it is part of the in-flight key, so a request made after a
// write never joins a read that started before it.
async function cached(cache, prefix, name, load, { checkStamps = true } = {}) {
  if (checkStamps) await syncCacheStamps();
  const hit = cache.get(name);
  if (fresh(name, hit)) return hit.value;
  const stamp = knownStamps.get(name);
  return once(`${prefix}:${name}:${stamp}`, async () => {
    const value = await load();
    if (knownStamps.get(name) === stamp) {
      cache.set(name, { value, stamp, expiresAt: Date.now() + RAW_SNAPSHOT_TTL_MS });
    }
    return value;
  });
}

function cachedCollection(name, options) {
  return cached(colCache, "c", name, async () => {
    const orderBy = name === "chapters" ? { field: "order" }
      : name === "weeklyData" ? { field: "date", direction: "desc" }
        : null;
    const rows = await listCollection(name, orderBy);
    return name === "members" ? rows.map(m => ({ id: m.id, ...stripPrivateMember(m) })) : rows;
  }, options);
}

// The shared, credential-free copy of a snapshot collection (members have pinHash
// stripped). Lets other readers of the same data - the login directory - reuse the
// snapshot's cached read instead of paying for their own. The login directory is
// unauthenticated and only lists names, so it skips the stamp check: a public page must
// not be able to spend a Firestore read per hit, and a name changed seconds ago can wait.
export function cachedSnapshotCollection(name) {
  return cachedCollection(name, { checkStamps: false });
}

// Shared cache for the on-demand collections (miyagiMembers, activityLog). Without it
// every DC opening the Miyagi tab pays its own ~1.3k reads; with it they share one
// fetch for the TTL. Safe to key by name: these are not in the snapshot, so there is no
// collision with cachedCollection's differently-shaped reads.
export function cachedListCollection(name, orderBy, limit) {
  return cached(colCache, "c", name, () => listCollection(name, orderBy, limit));
}

function cachedMeta(id) {
  return cached(metaCache, "m", id, () => getMetaDoc(id));
}

// The current account record behind a session, checked on every signed-in request. It
// comes from the shared members cache, which every account change stamps, so a deleted,
// reassigned or re-PINned account is seen by every server instance on its next request.
export async function currentMember(id) {
  return (await cachedCollection("members")).find(m => m.id === id) || null;
}

// meta/config without its private fields; holds when the BNI Office PIN last changed.
export function currentConfig() {
  return cachedMeta("config");
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
    // of its own; it is scoped field by field instead.
    if (name === "attendance") return [name, scopeAttendance(user, rows, raw.collections.members)];
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
  // some; keep one (richest) row per chapter.
  // "BNI Vitus" and "Vitus" are the same chapter (as in `norm` below).
  const _tn = s => String(s || "").toLowerCase().replace(/^bni\s+/, "").replace(/[^a-z0-9]+/g, "").trim();
  const _rich = r => Object.values(r).filter(v => v !== "" && v != null).length;
  const _idx = new Map(); const _rows = [];
  // The rows come from an uploaded spreadsheet and many of their cells are printed on the
  // dashboard as they are. No real TLR cell holds angle brackets, so they are dropped
  // rather than stored as page markup.
  const _plain = r => (r && typeof r === "object")
    ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.replace(/[<>]/g, "") : v]))
    : r;
  (rows || []).map(_plain).forEach(r => { const k = _tn(r.name); if (!k) return; if (_idx.has(k)) { const j = _idx.get(k); if (_rich(r) > _rich(_rows[j])) _rows[j] = r; return; } _idx.set(k, _rows.length); _rows.push(r); });
  rows = _rows;

  const norm = s => String(s || "").toLowerCase().replace(/^bni\s+/, "").trim();

  // scopedChapterNames() is null for the Area Director / BNI Office (unrestricted) and
  // the assigned-chapter list for a Senior Director. A Senior Director's upload is first
  // narrowed to their own chapters. In EVERY case the upload is then MERGED into the
  // existing region-wide TLR by chapter name - the uploaded chapters are updated and any
  // chapter not in the file is left untouched. So uploading a part-region export (e.g.
  // one region's traffic-lights report) never wipes the chapters it does not include,
  // and no Senior Director can wipe another's chapters.
  const scope = scopedChapterNames(user);
  if (Array.isArray(scope)) {
    const scopeSet = new Set(scope.map(norm));
    const inScope = name => { const k = norm(name); if (scopeSet.has(k)) return true; for (const s of scopeSet) if (s && (s.includes(k) || k.includes(s))) return true; return false; };
    rows = rows.filter(r => r.name && inScope(r.name));
  }
  const existing = (await db.collection("meta").doc("tlr").get()).data() || {};
  const keep = (existing.rows || []).filter(r => !rows.some(nr => _tn(nr.name) === _tn(r.name)));
  const storedRows = [...keep, ...rows];

  await db.collection("meta").doc("tlr").set({
    rows: storedRows,
    reportMonth: monthIso,
    monthLabel: monthLabel || "",
    uploadedAt: new Date().toISOString().slice(0, 10),
    uploadedBy: await actorName(user)
  });

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
  await publishCacheStamps();
  return { chaptersUpdated: rows.length, weeklyEntriesUpdated: updated, month: monthIso };
}

// Must match SR_LOGIN_ID and the name given at login in src/api/handlers.js.
const BNI_OFFICE_ID = "__srdc__";
const BNI_OFFICE_NAME = "BNI Office Account";

// The display name of whoever made a request. Session tokens carry only the account id
// (`sub`), so without this lookup every server-written record was attributed to a raw
// id such as "sa-bni-calibos", or to "system".
export async function actorName(user) {
  if (!user) return "system";
  if (user.name) return user.name;
  const id = user.sub || user.id;
  if (!id) return "system";
  if (id === BNI_OFFICE_ID) return BNI_OFFICE_NAME;
  const hit = colCache.get("members");
  let member = fresh("members", hit) ? hit.value.find(m => m.id === id) : null;
  if (!member) {
    try {
      const doc = await getDb().collection("members").doc(id).get();
      member = doc.exists ? doc.data() : null;
    } catch {
      member = null;
    }
  }
  return member?.name || id;
}

// `source` tells apart what the server itself recorded ("server") from entries a browser
// reported through POST /api/activity ("browser"), which can't be taken as evidence.
export async function writeActivity(user, action, details = {}, { source = "server" } = {}) {
  // Logging an action does not change any snapshot collection, so it must NOT drop the
  // shared cache - doing so re-read the entire dataset on every click. Callers that
  // actually change data invalidate their own collection (see routeApi).
  invalidateSnapshotCache("activityLog");
  const userName = await actorName(user);
  await Promise.all([
    // Every write path ends here, so this is where the stamps of what it changed are
    // shared with the other server instances (see invalidateSnapshotCache).
    publishCacheStamps(),
    getDb().collection("activityLog").add({
      team: "bni_chapter_pulse",
      action,
      details,
      userName,
      userId: user?.sub || user?.id || null,
      userRole: user?.role || "system",
      source,
      chapter: user?.chapter || null,
      timestamp: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp()
    })
  ]);
}
