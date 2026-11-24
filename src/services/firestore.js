import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "../firebaseAdmin.js";
import { AREAS, DEFAULT_AREA, areaOf, canReadChapter, filterRowsToScope, isChapterRole, isKnownArea, scopedChapterNames } from "./scope.js";

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
  // The region an Area Director account runs (see scope.js areaOf).
  "area",
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
  "tlr",
  "tlrHistory"
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
  "tlr",
  "tlrHistory"
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

// The four lists that hold rows for every chapter - renewals, Length of Membership, the
// TLR and its month-wise history - are stored once per region. Ahmedabad, where the
// dashboard started, keeps the original document; every other region has its own
// `<document>-<region>` document (meta/dues-north-gujarat ...). Reads put the regions'
// rows back together, Ahmedabad's first, so the page and the rest of the server still
// see one list; writes go only to the documents of the regions whose chapters they
// change. So one region's uploads can never rewrite another region's record, and each
// region has the whole 1 MB document limit to itself. The region documents are not in
// META_DOCS: they cannot be read or written through /api/meta directly.
export const REGION_SPLIT_META = { dues: "members", lengthOfMembership: "rows", tlr: "rows", tlrHistory: "rows" };

export function regionMetaDocId(docId, area) {
  return !area || area === DEFAULT_AREA ? docId : `${docId}-${area}`;
}

// "BNI Alpha" and "Alpha" are the same chapter.
const chapterKey = s => String(s || "").toLowerCase().replace(/^bni\s+/, "").replace(/[^a-z0-9]+/g, "");

// The region of a chapter named in an uploaded row. A name that is no dashboard chapter
// (a closed chapter still in a report) belongs to `fallback`.
export async function chapterAreaLookup(fallback = DEFAULT_AREA) {
  const byName = new Map(), byKey = new Map();
  for (const c of await cachedCollection("chapters")) {
    if (!c.name) continue;
    byName.set(c.name, areaOf(c));
    if (!byKey.has(chapterKey(c.name))) byKey.set(chapterKey(c.name), areaOf(c));
  }
  return name => byName.get(name) || byKey.get(chapterKey(name)) || fallback;
}

export async function getMetaDoc(docId) {
  if (!META_DOCS.has(docId)) {
    const error = new Error("Unsupported meta document");
    error.status = 404;
    throw error;
  }

  const doc = await getDb().collection("meta").doc(docId).get();
  const data = doc.exists ? { id: doc.id, ...doc.data() } : { id: docId };
  const field = REGION_SPLIT_META[docId];
  if (field) {
    for (const { id: area } of AREAS) {
      if (area === DEFAULT_AREA) continue;
      const extra = await getDb().collection("meta").doc(regionMetaDocId(docId, area)).get();
      if (!extra.exists) continue;
      const more = extra.data() || {};
      data[field] = [...(Array.isArray(data[field]) ? data[field] : []), ...(Array.isArray(more[field]) ? more[field] : [])];
      if (docId === "tlrHistory") data.months = [...new Set([...(data.months || []), ...(more.months || [])])].sort();
    }
  }
  return stripPrivateMeta(docId, data);
}

// Internal reads that need the private fields (e.g. verifying the Sr. DC PIN).
export async function getRawMetaDoc(docId) {
  const doc = await getDb().collection("meta").doc(docId).get();
  return doc.exists ? doc.data() : {};
}

// Replaces the rows of the chapters in `incoming` in a per-region list (REGION_SPLIT_META),
// writing only the documents of the regions those chapters belong to: each region's other
// rows are kept exactly as stored, in their order, and another region's document is not
// written at all. `header` (uploadedAt, uploadedBy...) goes to the written documents only.
export async function mergeRegionRows(docId, { chapterField, incoming, header = {} }) {
  const field = REGION_SPLIT_META[docId];
  if (!field) throw new Error(docId + " is not stored per region");
  const areaOfChapter = await chapterAreaLookup();
  const touched = new Set(incoming.map(row => row?.[chapterField]).filter(Boolean));
  const areas = [...new Set(incoming.map(row => areaOfChapter(row?.[chapterField])))];
  const db = getDb();
  for (const area of areas) {
    const ref = db.collection("meta").doc(regionMetaDocId(docId, area));
    const stored = (await ref.get()).data() || {};
    const kept = (Array.isArray(stored[field]) ? stored[field] : []).filter(row => !touched.has(row?.[chapterField]));
    const added = incoming.filter(row => areaOfChapter(row?.[chapterField]) === area);
    await ref.set({ ...header, [field]: [...kept, ...added] }, { merge: true });
  }
  invalidateSnapshotCache(docId);
  await publishCacheStamps();
  return getMetaDoc(docId);
}

export async function setMetaDoc(docId, data, merge = true) {
  if (!META_DOCS.has(docId)) {
    const error = new Error("Unsupported meta document");
    error.status = 404;
    throw error;
  }
  // Written whole, a per-region list would put every region's rows into Ahmedabad's
  // document. They change only through mergeRegionRows and the TLR upload.
  if (REGION_SPLIT_META[docId]) {
    const error = new Error(docId + " is saved by its upload, which keeps each region's rows in its own record");
    error.status = 403;
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
  // Every TLR month uploaded so far, one row per chapter per month (see applyTlrForMonth).
  tlrHistory: { listField: "rows", chapterField: "name" },
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
function scopeAttendance(user, rows, members, chapterRows = []) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return rows;
  const chapters = new Set(allowed);
  const ids = new Set(members
    .filter(m => [...(m.chapters || []), m.chapter].some(c => chapters.has(c)))
    .map(m => m.id));
  // A week that only another region has marked is not one of this region's weeks: without
  // this, another region's attendance added that week, all "No", to this region's report.
  const regionOf = regionResolver(chapterRows, members);
  const mine = userAreas(user, chapterRows);
  const ofThisRegion = row => {
    const keys = Object.keys(row).filter(key => key !== "id");
    return !keys.length || keys.some(key => mine.includes(regionOf.key(key)));
  };
  return rows.filter(ofThisRegion).map(row => Object.fromEntries(Object.entries(row).filter(([key]) =>
    key === "id" || chapters.has(key) || ids.has(key.replace(/_name$/, "")))));
}

// GET /api/attendance: scoped exactly like the snapshot's copy.
export async function scopeAttendanceRows(user, rows) {
  if (scopedChapterNames(user) === null) return rows;
  return scopeAttendance(user, rows, await cachedCollection("members"), await cachedCollection("chapters"));
}

// The regions of chapters, accounts and attendance keys. Anything that names no known
// chapter or account is Ahmedabad's: everything from before there were regions is.
function regionResolver(chapterRows, members) {
  const chapterArea = new Map(chapterRows.filter(c => c?.name).map(c => [c.name, areaOf(c)]));
  const memberById = new Map(members.map(m => [m.id, m]));
  const ofMember = m => m.role === "ad" ? areaOf(m) : (chapterArea.get([...(m.chapters || []), m.chapter].find(Boolean)) || DEFAULT_AREA);
  return {
    chapter: name => chapterArea.get(name) || null,
    member: id => memberById.has(id) ? ofMember(memberById.get(id)) : null,
    key(key) {
      if (chapterArea.has(key)) return chapterArea.get(key);
      const id = String(key).replace(/_name$/, "");
      return memberById.has(id) ? ofMember(memberById.get(id)) : DEFAULT_AREA;
    }
  };
}

// The regions a signed-in account works in; null for the ED, the BNI Office and Viewers.
function userAreas(user, chapterRows) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return null;
  if (user?.role === "ad") return [areaOf(user)];
  const chapterArea = new Map(chapterRows.filter(c => c?.name).map(c => [c.name, areaOf(c)]));
  const areas = [...new Set(allowed.map(name => chapterArea.get(name) || DEFAULT_AREA))];
  return areas.length ? areas : [DEFAULT_AREA];
}

// The activity log, per region. Each entry belongs to the region it was saved with, else
// its chapter's, else its author's (entries from before there were regions: Ahmedabad's).
// An account sees its own region's entries; the ED / BNI Office get every region and the
// page shows the one on screen. Each region keeps its own newest ACTIVITY_PER_REGION, so
// one region's activity never pushes another region's entries out of view.
export const ACTIVITY_PER_REGION = 500;
export const ACTIVITY_READ = 1000;
export async function scopeActivityRows(user, rows) {
  const chapterRows = await cachedCollection("chapters");
  const regionOf = regionResolver(chapterRows, await cachedCollection("members"));
  const areaOfEntry = e => (isKnownArea(e?.area) ? e.area
    : regionOf.chapter(e?.chapter) || regionOf.chapter(e?.details?.chapter) || regionOf.chapter(e?.details?.chapterName)
      || regionOf.member(e?.userId) || DEFAULT_AREA);
  const mine = userAreas(user, chapterRows);
  const perArea = {};
  const out = [];
  for (const row of rows) {
    const area = areaOfEntry(row);
    if (mine && !mine.includes(area)) continue;
    perArea[area] = (perArea[area] || 0) + 1;
    if (perArea[area] > ACTIVITY_PER_REGION) continue;
    out.push(area === DEFAULT_AREA && !row.area ? row : { ...row, area });
  }
  return filterRowsToScope(user, out);
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

// The names of the chapters in one region, from the shared chapters cache (stamped on
// every chapter change, so a chapter added or moved is seen on the next request).
export async function chapterNamesInArea(area) {
  return (await cachedCollection("chapters")).filter(c => areaOf(c) === area).map(c => c.name).filter(Boolean);
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
    if (name === "attendance") return [name, scopeAttendance(user, rows, raw.collections.members, raw.collections.chapters)];
    // Another region's Area Director is no one this account works with.
    if (name === "members") {
      const areas = userAreas(user, raw.collections.chapters);
      return [name, filterRowsToScope(user, rows).filter(m => m.role !== "ad" || areas === null || areas.includes(areaOf(m)))];
    }
    return [name, filterRowsToScope(user, rows)];
  }));

  const meta = Object.fromEntries(Object.entries(raw.meta).map(([id, doc]) => [id, scopeMetaDoc(user, id, doc)]));

  return { collections, meta };
}

// Region-wide monthly TLR: stores the snapshot (tagged with its month) and refreshes
// the tlr/conversion values on every weekly entry in that month, in one batched write.
export async function applyTlrForMonth(user, { monthIso, monthLabel, rows, area = null }) {
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
    // A row that names another dashboard chapter exactly is never taken just because the
    // name contains (or is part of) one of the uploader's chapters ("Kappa Club" is not "Kappa").
    const others = new Set((await cachedCollection("chapters")).map(c => norm(c.name)).filter(k => k && !scopeSet.has(k)));
    const inScope = name => { const k = norm(name); if (scopeSet.has(k)) return true; if (others.has(k)) return false; for (const s of scopeSet) if (s && (s.includes(k) || k.includes(s))) return true; return false; };
    rows = rows.filter(r => r.name && inScope(r.name));
  }
  // Every row is tagged with its report month. A chapter's current TLR row is replaced
  // only by the same or a later month, so uploading past months (in any order) builds
  // the history without turning the current TLR back to an older month.
  rows = rows.map(r => ({ ...r, monthIso }));

  // Each region's rows are kept in that region's own TLR and history records
  // (REGION_SPLIT_META), so a region's upload writes only its own records. A row for a
  // chapter that is not on the dashboard goes with the report's region: the Area
  // Director's own, a Senior Director's chapters', the "Region:" cell's, or else the one
  // region of the dashboard chapters in the same report.
  const known = await chapterAreaLookup(null);
  // A report that names its region (the "Region:" cell) is that region's: a row naming a
  // chapter of another region is not taken from it - not into the TLR, its history or
  // that chapter's weekly entries.
  if (isKnownArea(area)) rows = rows.filter(r => { const a = known(r.name); return !a || a === area; });
  let fallback = isKnownArea(area) ? area : null;
  if (user?.role === "ad") fallback = areaOf(user);
  else if (Array.isArray(scope) && scope.length) fallback = known(scope[0]) || DEFAULT_AREA;
  if (!fallback) {
    const regions = [...new Set(rows.map(r => known(r.name)).filter(Boolean))];
    fallback = regions.length === 1 ? regions[0] : DEFAULT_AREA;
  }
  const areaOfRow = name => known(name) || fallback;
  const byArea = new Map();
  rows.forEach(r => { const a = areaOfRow(r.name); if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(r); });
  let currentCount = 0;
  for (const [regionArea, regionRows] of byArea) {
    currentCount += await applyTlrRegion(db, regionArea, { monthIso, monthLabel, rows: regionRows, _tn });
  }

  // That month's weekly entries of the chapters in the file get its score. Names must
  // match exactly ("BNI Alpha" = "Alpha"): the page has already matched each row to a
  // dashboard chapter, and a partial match could give one region's score to a similarly
  // named chapter of the other region.
  const byChapter = new Map();
  rows.forEach(r => { if (r.name) byChapter.set(_tn(r.name), r); });
  const lookup = chapter => byChapter.get(_tn(chapter)) || null;

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

  // The TLR upload rewrites meta/tlr and meta/tlrHistory and touches that month's weekly
  // entries.
  invalidateSnapshotCache(["tlr", "tlrHistory", "weeklyData"]);
  await publishCacheStamps();
  return { chaptersUpdated: rows.length, currentUpdated: currentCount, weeklyEntriesUpdated: updated, month: monthIso, areas: [...byArea.keys()] };
}

// One region's part of a TLR upload: its TLR record and its history record. Returns how
// many chapters' current TLR rows were replaced.
async function applyTlrRegion(db, area, { monthIso, monthLabel, rows, _tn }) {
  const tlrRef = db.collection("meta").doc(regionMetaDocId("tlr", area));
  const existing = (await tlrRef.get()).data() || {};
  const monthOfRow = r => (/^\d{4}-\d{2}$/.test(String(r?.monthIso || "")) ? r.monthIso : String(existing.reportMonth || ""));
  const current = rows.filter(nr => {
    const old = (existing.rows || []).find(r => _tn(r.name) === _tn(nr.name));
    return !old || monthOfRow(old) <= monthIso;
  });
  // An upload changes only the rows of the chapters in it: every other chapter's rows,
  // and the record's other fields, stay exactly as they are (who uploaded what is in the
  // activity log). The header (reportMonth) is the month of rows saved before every row
  // carried its own, so it moves only once no such row is left.
  if (current.length) {
    const keep = (existing.rows || []).filter(r => !current.some(nr => _tn(nr.name) === _tn(r.name)));
    const all = [...keep, ...current];
    const update = { rows: all };
    if (keep.every(r => /^\d{4}-\d{2}$/.test(String(r?.monthIso || "")))) {
      const newest = all.map(r => r.monthIso).sort().pop();
      if (newest !== existing.reportMonth) {
        update.reportMonth = newest;
        update.monthLabel = newest === monthIso ? (monthLabel || "") : "";
      }
    }
    await tlrRef.set(update, { merge: true });
  }

  // The month also goes into the history record, which keeps one row per chapter per
  // month for the last TLR_HISTORY_MONTHS months. Re-uploading a month replaces that
  // month's rows for the chapters in the file.
  const historyRef = db.collection("meta").doc(regionMetaDocId("tlrHistory", area));
  const historyDoc = (await historyRef.get()).data() || {};
  const history = (historyDoc.rows || [])
    .filter(r => !(r.monthIso === monthIso && rows.some(nr => _tn(nr.name) === _tn(r.name))))
    .concat(rows);
  const keptMonths = [...new Set(history.map(r => r.monthIso))].sort().slice(-TLR_HISTORY_MONTHS);
  await historyRef.set({
    rows: history.filter(r => keptMonths.includes(r.monthIso))
      .sort((a, b) => a.monthIso.localeCompare(b.monthIso) || String(a.name).localeCompare(String(b.name))),
    months: keptMonths
  }, { merge: true });
  return current.length;
}

// How many months of TLR history are kept (two years: the 12-month views plus a year of
// comparison). At ~50 chapters that is about 1,200 small rows, well inside one document.
export const TLR_HISTORY_MONTHS = 24;

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
export async function writeActivity(user, action, details = {}, { source = "server", area: givenArea = null } = {}) {
  let area = isKnownArea(givenArea) ? givenArea : isKnownArea(details?.area) ? details.area : null;
  if (!area && user?.role === "ad" && isKnownArea(user?.area) && Array.isArray(user?.areaChapters)) area = user.area;
  if (!area) {
    const named = user?.chapter || details?.chapter || details?.chapterName;
    if (named) area = (await chapterAreaLookup(null))(named);
  }
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
      // The region the entry belongs to, when it is not Ahmedabad (see scopeActivityRows).
      ...(area && area !== DEFAULT_AREA ? { area } : {}),
      timestamp: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp()
    })
  ]);
}
