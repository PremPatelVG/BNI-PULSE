// Single implementation of every API route. The Express server and the Netlify
// function are thin adapters over this module, so the two deployments cannot drift.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { routeBarter } from "./barter.js";
import { config, requireProductionSecrets } from "../config.js";
import { getDb } from "../firebaseAdmin.js";
import { signSession } from "../middleware/auth.js";
import {
  actorName,
  applyTlrForMonth,
  buildSnapshot,
  CHAPTER_KEYED_META_DOCS,
  chapterNamesInArea,
  cachedListCollection,
  cachedSnapshotCollection,
  currentConfig,
  currentMember,
  docToData,
  getMetaDoc,
  getRawMetaDoc,
  invalidateSnapshotCache,
  listCollection,
  loginDirectoryMember,
  mergeRegionRows,
  REGION_SPLIT_META,
  ACTIVITY_READ,
  chapterAreaLookup,
  scopeActivityRows,
  scopeAttendanceRows,
  scopeMetaDoc,
  setMetaDoc,
  stripPrivateMember,
  writeActivity
} from "../services/firestore.js";
import {
  AREAS,
  DEFAULT_AREA,
  areaOf,
  assertAdmin,
  assertCanWrite,
  assertCanWriteChapter,
  badRequest,
  filterRowsToScope,
  forbidden,
  isAreaDirector,
  isKnownArea,
  isRegionWide,
  isSeniorDirector,
  isViewer,
  notFound,
  scopedChapterNames,
  SR_LOGIN_ID
} from "../services/scope.js";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const COLLECTION_READ_ALLOWLIST = new Set(["attendance", "renewalsDone", "renewalsDropped", "visitorPipeline", "miyagiMembers", "activityLog"]);
const COLLECTION_WRITE_ALLOWLIST = new Set(["attendance", "renewalsDone", "renewalsDropped", "visitorPipeline", "miyagiMembers"]);
const COLLECTION_DELETE_ALLOWLIST = new Set(["renewalsDropped", "visitorPipeline", "miyagiMembers"]);

// Who may write each meta document through PUT /api/meta/:id. Anything not listed here
// is shared by every region and Executive Director / BNI Office only, so a new document
// is locked down by default.
// Meta documents only Area/Senior Directors may change.
const ADMIN_META_DOCS = new Set(["branding", "config"]);
// Meta documents holding per-chapter rows, merged server-side so a writer can only
// ever replace the slice of the document their scope covers. The Length-of-Membership
// list is one of them: written whole, a Senior Director's upload of their own chapters
// wiped every other chapter's rows.
const SCOPED_META_DOCS = {
  dues: { listField: "members", chapterField: "chapter" },
  lengthOfMembership: { listField: "rows", chapterField: "chapter" }
};
// Meta documents keyed by chapter (CHAPTER_KEYED_META_DOCS, shared with the read-side
// scoping): a writer may only set keys for chapters they can write. Goals are edited by
// each chapter's own DC/SA as well as by leadership.


// POST /api/activity lets the browser add context to the log (member names, scores...).
// It used to accept any action name and any details, so anyone could write entries that
// looked like real deletions or Miyagi saves. Now only the browser's own action names
// are accepted, their details are kept small and flat, and they are stored with
// source "browser" - the server's own entries (source "server") are the evidence.
const BROWSER_ACTIONS = new Set([
  "attendance_marked", "branding_updated", "dues_report_uploaded", "fee_compliance_toggled",
  "length_of_membership_uploaded", "miyagi_checkin_submitted", "miyagi_checkpoint_toggled",
  "miyagi_checkpoints_saved", "miyagi_completion_undone", "miyagi_member_completed", "miyagi_member_dropped", "monthly_target_saved",
  "pipeline_contact_deleted", "pipeline_stage_changed", "quick_update", "renewal_drop_undone",
  "renewal_marked_done", "renewal_marked_dropped", "sr_call_day_changed"
]);
// Recorded by the server route that performs the change; a browser copy would only be a
// duplicate line in the log.
const SERVER_LOGGED_ACTIONS = new Set(["chapter_saved", "member_deleted", "weekly_entry_saved", "weekly_entry_deleted"]);

function cleanActivityDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details).slice(0, 12)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

// Weekly entry fields that hold counts. The dashboard prints them as they are, so a
// non-number sent straight to the API (say a script tag as "visitors") would end up in
// every leader's page. Numeric text is stored as a number; anything else is refused.
const WEEKLY_NUMBER_FIELDS = [
  "membersStart", "inductions", "drops", "membersClose", "membersConnect", "visitors", "posVisitors",
  "tlr", "conversionPct", "onetwentyone", "references", "tyfcb", "eoiYes", "eoiMaybe", "eoiNo",
  "eoiPending", "eoi", "pipeline", "renewals", "training"
];

function cleanWeeklyNumbers(body) {
  const entry = { ...(body || {}) };
  for (const field of WEEKLY_NUMBER_FIELDS) {
    if (!(field in entry)) continue;
    const value = entry[field];
    if (value === null || value === "" || (typeof value === "number" && Number.isFinite(value))) continue;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      entry[field] = Number(value);
      continue;
    }
    throw badRequest(`${field} must be a number`);
  }
  return entry;
}

// New Miyagi members sent by a Length-of-Membership upload (PUT /api/miyagi-new-members).
// Every record is rebuilt here as a member who has just started the program, so the
// request cannot set a score, ticks, check-ins or a status of its own.
const MIYAGI_ADD_LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function newMiyagiMembers(list) {
  if (!Array.isArray(list) || !list.length) throw badRequest("No members to add");
  if (list.length > MIYAGI_ADD_LIMIT) throw badRequest(`At most ${MIYAGI_ADD_LIMIT} members can be added in one request`);
  const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const date = value => (ISO_DATE.test(String(value || "")) ? String(value) : "");
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  return list.map(raw => {
    const id = String(raw?.id || "");
    const name = text(raw?.name, 120);
    const chapter = text(raw?.chapter, 80);
    if (!/^[a-z0-9_]{3,200}$/.test(id) || !name || !chapter) throw badRequest("Each new member needs an id, a name and a chapter");
    if (seen.has(id)) throw badRequest(`"${id}" is listed twice`);
    seen.add(id);
    const added = date(raw.createdAt) || today;
    const data = {
      name, chapter, joinDate: date(raw.joinDate),
      status: "active", score: 0, checkpoints: {}, checkins: {},
      lastActivityDate: added, createdAt: added
    };
    if (raw.firstName !== undefined || raw.lastName !== undefined) {
      data.firstName = text(raw.firstName, 80);
      data.lastName = text(raw.lastName, 80);
    }
    if (date(raw.cumulativeStart)) data.cumulativeStart = raw.cumulativeStart;
    if (text(raw.cumulativeLength, 40)) data.cumulativeLength = text(raw.cumulativeLength, 40);
    return { id, data };
  });
}

// Accounts a Senior Director may create, edit or delete.
const CHAPTER_ACCOUNT_ROLES = new Set(["dc", "cd", "sa1", "sa2"]);

// The chapter fields a Senior Director may set (what the Settings chapter form sends).
const SRDC_CHAPTER_FIELDS = new Set(["id", "name", "day", "tenure", "target", "order", "openingMembers"]);

// The region a Senior Director's (or other non-AD caller's) chapters are in - the region
// of the first chapter on their account. Used when such a caller adds a chapter.
async function callerChapterArea(user) {
  const first = memberChapters(user)[0];
  if (!first) return areaOf(null);
  const doc = await getDb().collection("chapters").doc(first).get();
  return areaOf(doc.exists ? doc.data() : null);
}

function memberChapters(m) {
  if (!m) return [];
  return [...(m.chapters || []), m.chapter].filter(Boolean);
}

// The regions a leader runs: their own region for an Area Director, the regions of their
// chapters for a Senior Director, every region (null) for the ED and BNI Office.
async function callerAreas(user) {
  if (isRegionWide(user)) return null;
  if (isAreaDirector(user)) return [areaOf(user)];
  const areas = new Set();
  for (const name of new Set(memberChapters(user))) {
    const doc = await getDb().collection("chapters").doc(name).get();
    areas.add(areaOf(doc.exists ? doc.data() : null));
  }
  return [...areas];
}

// The weekly team call day is kept per region in meta/config.srCallDays ({ regionId: day }),
// so each region can move its call whenever it likes without changing the other's. The
// older single `srCallDay` is Ahmedabad's, from before there was a second region. A leader
// sets only the regions they run; the ED and BNI Office set any. Those are the only config
// fields the dashboard writes, so an account that runs one region may change nothing else
// there (the PIN fields have their own endpoint).
const CALL_DAYS = new Set(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
async function assertCanSaveConfig(user, body) {
  const changes = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (key === "srPin" || key === "srPinHash" || key === "srPinChangedAt") continue;   // dropped by the caller
    if (key === "srCallDays") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("srCallDays must list a day per region");
      for (const [area, day] of Object.entries(value)) {
        if (!isKnownArea(area)) throw badRequest("Unknown region");
        if (!CALL_DAYS.has(day)) throw badRequest("Not a day of the week");
        changes.push(area);
      }
    } else if (key === "srCallDay") {
      if (!CALL_DAYS.has(value)) throw badRequest("Not a day of the week");
      changes.push(areaOf(null));
    } else if (!isRegionWide(user)) {
      throw forbidden("Only the Executive Director / BNI Office account can change that setting");
    }
  }
  const mine = await callerAreas(user);
  if (mine && changes.some(area => !mine.includes(area))) {
    throw forbidden("You can only change the team call day of your own region");
  }
}

// Who may write or delete a member account. `roles` lists every role involved - the
// account's current role and the role being saved - so an account can never be moved
// past what the caller manages (their own account included).
//  - Executive Director accounts: only the ED or the BNI Office account.
//  - ED / BNI Office: any other account, in every region.
//  - Area Director: Senior Director, Chapter Director and SA accounts in their own
//    region's chapters, and Area Director accounts of their own region (themselves
//    included). Viewer accounts see every region, so only the ED or BNI Office
//    manages those. `areas` holds the region of each Area Director account involved
//    (before and after the save).
//  - Senior Director: only Chapter Director and SA accounts, in chapters they oversee.
function assertCanManageMember(user, roles, chapters, areas = []) {
  const involved = roles.filter(Boolean);
  if (involved.includes("ed") && !(user?.role === "ed" || user?.id === SR_LOGIN_ID)) {
    throw forbidden("Only the Executive Director or the BNI Office account can manage Executive Director accounts");
  }
  if (isRegionWide(user)) return;
  if (isAreaDirector(user)) {
    if (!involved.every(r => r === "srdc" || r === "ad" || CHAPTER_ACCOUNT_ROLES.has(r))) {
      throw forbidden("Viewer accounts are managed by the Executive Director or the BNI Office account");
    }
    if (areas.some(a => a !== user.area)) {
      throw forbidden("That Area Director account belongs to another region");
    }
    const region = new Set(scopedChapterNames(user) || []);
    if (chapters.some(c => !region.has(c))) {
      throw forbidden("That account belongs to a chapter outside your region");
    }
    return;
  }
  if (!involved.every(r => CHAPTER_ACCOUNT_ROLES.has(r))) {
    throw forbidden("A Senior Director can only manage Chapter Director and Support Ambassador accounts");
  }
  const scope = new Set(scopedChapterNames(user) || []);
  if (chapters.some(c => !scope.has(c))) {
    throw forbidden("That account belongs to a chapter you don't oversee");
  }
}

export function ok(body, status = 200) {
  return { status, body };
}

export function noContent() {
  return { status: 204, body: null };
}

// Only the Express entrypoint used to check this, so a Netlify deployment missing
// APP_JWT_SECRET would silently fall back to the hard-coded development secret and
// accept tokens anyone could forge. Checked here instead, so both deployments fail
// loudly rather than running wide open.
let secretsChecked = false;
function assertRuntimeSecrets() {
  if (secretsChecked) return;
  requireProductionSecrets();
  secretsChecked = true;
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
    // Sessions are only ever signed with HS256 (see signSession); nothing else is accepted.
    return jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
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
    areaDirectorId: data.areaDirectorId || "",
    // The page labels an Area Director's screens with their region.
    area: data.role === "ad" ? areaOf(data) : null
  };
}

// Only bcrypt hashes are accepted. Plaintext `pin` fields left over from older
// records are rejected so a legacy document cannot weaken the check.
async function pinMatches(member, pin) {
  if (localPreviewPinMatches(pin)) return true;
  if (!member?.pinHash) return false;
  return bcrypt.compare(pin, member.pinHash);
}

function localPreviewPinMatches(pin) {
  return Boolean(config.localPreviewPin) && String(pin) === String(config.localPreviewPin);
}

async function srPinMatches(pin) {
  if (localPreviewPinMatches(pin)) return true;
  const cfg = await getRawMetaDoc("config");
  if (cfg.srPinHash) return bcrypt.compare(pin, cfg.srPinHash);
  // First-run fallback only, per the deployment docs.
  if (config.srAdminPin) return pin === config.srAdminPin;
  return null;
}

// PIN sign-in is rate-limited. Older PINs can be 4 digits and the login directory lists
// every account, so without a limit any account falls to at most 10,000 guesses. Wrong
// PINs are counted in Firestore (shared by every server instance) and checked before the
// PIN is compared, so a locked-out guess also costs no bcrypt work. They are counted:
//  - per account from each network: the usual lock. Counting per account alone let
//    anyone lock a colleague out (say the Area Director before a meeting) by typing
//    wrong PINs on purpose; now that only locks the network the guesses came from.
//  - per account across all networks, with a much higher bar, so guessing spread over
//    many networks still stops.
//  - per network, across all accounts.
// A correct PIN clears the account's counts, never the network's - otherwise an
// attacker could reset it by signing in to their own account.
const LOGIN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// [wrong PINs within the window, minutes locked]: the lock grows with repeated failures.
const ACCOUNT_LOCK_STEPS = [[5, 15], [10, 60], [15, 240]];
const ACCOUNT_TOTAL_LOCK_STEPS = [[25, 30], [50, 120], [100, 240]];
// One office network can carry many people's honest typos, so the IP limit is looser.
const IP_LOCK_STEPS = [[30, 30], [60, 240]];
// New PINs (the issued ones are 6 random digits); existing shorter PINs still sign in.
const MIN_PIN_LENGTH = 6;

function throttleRef(key) {
  return getDb().collection("loginThrottle").doc(key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120));
}

// Keeps the network part of a throttle key short and fixed-length (an IPv6 address would
// otherwise push the account id past the key length limit).
function networkTag(ip) {
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
}

function lockMinutes(failures, steps) {
  let minutes = 0;
  for (const [count, mins] of steps) if (failures >= count) minutes = mins;
  return minutes;
}

async function readThrottle(key) {
  if (!key) return null;
  const doc = await throttleRef(key).get();
  return doc.exists ? doc.data() : null;
}

function assertNotLocked(state, who) {
  const until = Date.parse(state?.lockedUntil || "");
  if (until > Date.now()) {
    const minutes = Math.ceil((until - Date.now()) / 60000);
    throw httpError(429, `Too many wrong attempts ${who}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}

async function recordFailure(key, state, steps) {
  if (!key) return;
  const now = Date.now();
  const fresh = state && now - Date.parse(state.firstFailureAt || 0) < LOGIN_FAILURE_WINDOW_MS;
  const failures = fresh ? (state.failures || 0) + 1 : 1;
  const minutes = lockMinutes(failures, steps);
  await throttleRef(key).set({
    failures,
    firstFailureAt: fresh ? state.firstFailureAt : new Date(now).toISOString(),
    lastFailureAt: new Date(now).toISOString(),
    lockedUntil: minutes ? new Date(now + minutes * 60000).toISOString() : null
  });
}

async function login(body, ip) {
  const memberId = body?.memberId;
  const pin = body?.pin == null ? "" : String(body.pin);
  if (typeof memberId !== "string" || !/^[^/]{1,200}$/.test(memberId) || !pin) throw badRequest("memberId and pin are required");

  // Without a client address (local development) the account count is the only one.
  const ipKey = ip ? `ip_${ip}` : null;
  const accountKey = ip ? `acctip_${networkTag(ip)}_${memberId}` : `acct_${memberId}`;
  const totalKey = ip ? `acct_${memberId}` : null;
  const [accountState, totalState, ipState] = await Promise.all([readThrottle(accountKey), readThrottle(totalKey), readThrottle(ipKey)]);
  assertNotLocked(ipState, "from this network");
  assertNotLocked(accountState, "for this account");
  assertNotLocked(totalState, "for this account");

  // Wrong PIN: count it against the IP always, and against the account only when the
  // account exists - made-up ids must not each create a throttle record.
  const wrongPin = async accountExists => {
    await Promise.all([
      recordFailure(ipKey, ipState, IP_LOCK_STEPS),
      accountExists ? recordFailure(accountKey, accountState, ACCOUNT_LOCK_STEPS) : null,
      accountExists ? recordFailure(totalKey, totalState, ACCOUNT_TOTAL_LOCK_STEPS) : null
    ]);
    throw httpError(401, "Incorrect PIN");
  };
  const clearAccount = async () => {
    await Promise.all([
      accountState ? throttleRef(accountKey).delete() : null,
      totalState ? throttleRef(totalKey).delete() : null
    ]);
  };

  if (memberId === SR_LOGIN_ID) {
    const result = await srPinMatches(pin);
    if (result === null) {
      const err = new Error("Sr. DC login is not configured");
      err.status = 503;
      throw err;
    }
    if (!result) await wrongPin(true);
    await clearAccount();
    // BNI Office master account: full region-wide access (Area Director role) - the
    // top of the system, can do anything an Area Director can across every chapter.
    const user = { id: SR_LOGIN_ID, name: "BNI Office Account", role: "ad", chapter: null, chapters: [] };
    return ok({ token: signSession(user), user });
  }

  const doc = await getDb().collection("members").doc(memberId).get();
  if (!doc.exists || !(await pinMatches(doc.data(), pin))) await wrongPin(doc.exists);
  await clearAccount();

  const user = publicUser(doc.id, doc.data());
  return ok({ token: signSession(user), user });
}

// Unauthenticated: the login screen needs names to populate its dropdown. Returns
// the narrowest possible projection, never credentials.
// Unauthenticated, so it must stay cheap: served from the shared snapshot cache rather
// than re-reading every member document on each visit to the login page.
// The login page asks for the region first, so each person carries the regions they work
// in (`areas`; empty for the Executive Director and Viewers, who work in every region),
// and the regions in use come with their number of chapters.
async function loginDirectory() {
  const [members, chapters] = await Promise.all([cachedSnapshotCollection("members"), cachedSnapshotCollection("chapters")]);
  const chapterArea = new Map(chapters.filter(c => c.name).map(c => [c.name, areaOf(c)]));
  const areasOf = member => {
    if (member.role === "ad") return [areaOf(member)];
    if (member.role === "ed" || member.role === "viewer") return [];
    const names = [...(member.chapters || []), member.chapter].filter(Boolean);
    if (!names.length) return [];
    const areas = [...new Set(names.map(name => chapterArea.get(name)).filter(Boolean))];
    return areas.length ? areas : [DEFAULT_AREA];
  };
  const chapterCount = {};
  chapters.forEach(c => { if (c.name) chapterCount[areaOf(c)] = (chapterCount[areaOf(c)] || 0) + 1; });
  return ok({
    members: members.map(member => ({ id: member.id, ...loginDirectoryMember(member), areas: areasOf(member) })),
    regions: AREAS.filter(a => chapterCount[a.id]).map(a => ({ id: a.id, label: a.label, chapters: chapterCount[a.id] }))
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
    areaDirectors: publicMembers.filter(member => member.role === "ad" || member.role === "ed"),
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

  // Each region's rows are in that region's own record: only the records of the regions
  // whose chapters are in the upload are written (see mergeRegionRows).
  const { [listField]: _ignored, ...rest } = body || {};
  const meta = await mergeRegionRows(docId, { chapterField, incoming, header: rest });
  const areaOfChapter = await chapterAreaLookup();
  const areas = [...new Set(incoming.map(row => areaOfChapter(row?.[chapterField])))];
  await writeActivity(user, "meta_saved", { docId, rowCount: incoming.length }, { area: areas.length === 1 ? areas[0] : null });
  // The stored document is region-wide; the writer gets back only their own chapters.
  return ok({ meta: scopeMetaDoc(user, docId, meta) });
}

// method: "GET" | "POST" | ... ; segments: path below /api, already decoded.
// A session token is valid for 12 hours, but in that time its account can be deleted,
// moved to other chapters or have its PIN reset. So every request is checked against the
// current account: a deleted account or a PIN changed after sign-in ends the session, and
// the role and chapters always come from the record, not the token.
async function refreshSessionUser(user) {
  const changedAfterSignIn = changedAt => Math.floor((Date.parse(changedAt || "") || 0) / 1000) > (user.iat || 0);
  if (user.id === SR_LOGIN_ID) {
    if (changedAfterSignIn((await currentConfig()).srPinChangedAt)) throw httpError(401, "The BNI Office PIN was changed - please sign in again");
    return;
  }
  const member = await currentMember(user.id);
  if (!member) throw httpError(401, "This account no longer exists");
  if (changedAfterSignIn(member.pinChangedAt)) throw httpError(401, "Your PIN was changed - please sign in again");
  user.role = member.role;
  user.chapter = member.chapter || null;
  user.chapters = member.chapters || [];
  // An Area Director runs one region: their chapters are that region's chapters, read
  // fresh here so a chapter added to (or moved into) the region is theirs at once.
  user.area = areaOf(member);
  if (member.role === "ad") user.areaChapters = await chapterNamesInArea(user.area);
}

// `ip` is the client's address as seen by the hosting adapter (used only to rate-limit
// PIN sign-in); it may be missing, e.g. in local development.
export async function routeApi({ method, segments, body, authorization, query, ip }) {
  assertRuntimeSecrets();
  const [first, second, third] = segments;

  if (first === "auth" && second === "login" && method === "POST") return login(body, ip);
  if (first === "auth" && second === "login-directory" && method === "GET") return loginDirectory();
  if (first === "auth" && second === "branding" && method === "GET") return publicBranding();

  const user = verifyToken(authorization);
  // Tokens carry the account id as `sub` (the JWT convention). Expose it as `id` too, so
  // identity checks written against the member shape - "is this the BNI Office account?"
  // - see the real id. Without it user.id was always undefined on signed-in requests.
  if (user && user.id == null) user.id = user.sub;
  await refreshSessionUser(user);

  if (first === "auth" && second === "me" && method === "GET") return ok({ user });

  if (first === "auth" && second === "sr-pin" && method === "PUT") {
    // The BNI Office login PIN (the master account credential) may be reset ONLY by the
    // Executive Director - not by an Area Director, Senior Director, or DC. In turn the
    // ED's own PIN can only be reset by the BNI Office account (see the members route),
    // so the two top-level accounts hold each other's reset and neither resets itself.
    if (user?.role !== "ed") throw forbidden("Only the Executive Director can reset the BNI Office PIN");
    const pin = String(body?.pin || "");
    if (pin.length < MIN_PIN_LENGTH) throw badRequest(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
    await setMetaDoc("config", { srPinHash: await bcrypt.hash(pin, 12), srPin: null, srPinChangedAt: new Date().toISOString() }, true);
    await writeActivity(user, "sr_pin_changed", {});
    return ok({ ok: true });
  }

  // Region-wide monthly TLR upload. Area Director / BNI Office account only.
  if (first === "tlr-upload" && method === "POST") {
    if (!isAreaDirector(user) && !isSeniorDirector(user)) throw forbidden("Only leadership (Area Director / Senior Director / BNI Office) can upload the TLR");
    const { monthIso, monthLabel, rows, area } = body || {};
    if (!/^\d{4}-\d{2}$/.test(String(monthIso || ""))) throw badRequest("A valid report month is required");
    if (!Array.isArray(rows) || !rows.length) throw badRequest("No chapter rows in the TLR");
    if (area != null && area !== "" && !isKnownArea(area)) throw badRequest("Unknown region");
    // `area` is the region named in the report's "Region:" cell; it decides only where a
    // row for a chapter that is not on the dashboard (a closed chapter) is kept.
    const result = await applyTlrForMonth(user, { monthIso, monthLabel, rows, area: area || null });
    await writeActivity(user, "tlr_report_uploaded", { month: monthIso, chaptersUpdated: result.chaptersUpdated, weeklyEntriesUpdated: result.weeklyEntriesUpdated },
      { area: result.areas && result.areas.length === 1 ? result.areas[0] : null });
    return ok(result);
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
    const name = String(body?.name || "").trim();
    if (!name) throw badRequest("Chapter name is required");
    const ref = getDb().collection("chapters").doc(body.id || name);
    const before = await ref.get();
    const prev = before.exists ? before.data() : null;
    // "Add Chapter" with the name of an existing chapter used to replace that chapter's
    // document outright, losing its assignments and opening count.
    if (!body.id && prev) throw httpError(409, `A chapter named "${name}" already exists - use Edit to change it`);
    if (body.id && !prev) throw notFound("Chapter not found");
    // Weekly entries, accounts, Miyagi, renewals, dues and the TLR all refer to a chapter
    // by its name, so renaming it here would cut it off from all of its data.
    if (prev && prev.name && prev.name !== name) {
      throw badRequest(`Renaming a chapter is not supported here: all of ${prev.name}'s data is stored under that name`);
    }
    if (!isAreaDirector(user)) {
      // A Senior Director edits only the chapters they oversee, and only its basic
      // details - who runs a chapter is assigned by the Area Director.
      if (prev) assertCanWriteChapter(user, prev.name);
      const notAllowed = Object.keys(body).filter(key => !SRDC_CHAPTER_FIELDS.has(key));
      if (notAllowed.length) throw forbidden(`Only the Area Director can change: ${notAllowed.join(", ")}`);
    }
    const { id: _id, ...chapter } = { ...body, name };
    // The region the chapter belongs to. The ED and BNI Office choose it; an Area Director
    // (or Senior Director) adds chapters to their own region and cannot move one out.
    if (chapter.area !== undefined && !isKnownArea(chapter.area)) throw badRequest("Unknown region");
    if (!isRegionWide(user)) {
      if (prev) assertCanWriteChapter(user, prev.name);
      const own = isAreaDirector(user) ? user.area : await callerChapterArea(user);
      if (chapter.area !== undefined && chapter.area !== areaOf(prev || { area: own })) {
        throw forbidden("Only the Executive Director or the BNI Office account can move a chapter to another region");
      }
      if (!prev) chapter.area = own;
    }
    await ref.set(chapter, { merge: Boolean(prev) });
    invalidateSnapshotCache("chapters");
    await writeActivity(user, "chapter_saved", { chapterName: name, created: !prev });
    return ok({ chapter: { id: ref.id, ...chapter } }, 201);
  }

  if (first === "members" && method === "GET") {
    const members = await listCollection("members");
    return ok({ members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })) });
  }

  // Admin-only: contact numbers for every member. Kept OUT of the shared snapshot and
  // stripPrivateMember allowlist so a DC's browser never receives the whole phone book;
  // only leadership (Settings) reads this, and the barter reveal exposes a single number
  // to a single DC after a match.
  if (first === "member-contacts" && method === "GET") {
    assertAdmin(user);
    let members = await listCollection("members");
    // An Area Director gets the numbers of their own region's accounts only.
    if (isAreaDirector(user) && !isRegionWide(user)) {
      const region = new Set(scopedChapterNames(user) || []);
      members = members.filter(m => m.id === user.id || memberChapters(m).some(c => region.has(c)));
    }
    return ok({ contacts: members.map(m => ({ id: m.id, name: m.name || "", role: m.role || "", chapter: m.chapter || "", chapters: m.chapters || [], phone: m.phone || m.contact || "" })) });
  }

  if (first === "members" && method === "POST") {
    assertAdmin(user);
    const { id, pin, pinHash: _rejectedHash, ...member } = body || {};
    if (!member.name) throw badRequest("Member name is required");
    if (member.role === "cd") member.role = "dc";
    // Only an Area Director account belongs to a region of its own; everyone else's
    // region follows their chapters.
    if (member.role !== "ad") delete member.area;
    else if (member.area !== undefined && !isKnownArea(member.area)) throw badRequest("Unknown region");
    // Support Ambassador logins are one shared account per chapter and are always named
    // "<Chapter> SA" - the name is derived from the chapter, never typed in.
    if (member.role === "sa1" || member.role === "sa2") {
      const saChapter = member.chapter || (Array.isArray(member.chapters) ? member.chapters[0] : "");
      if (saChapter) member.name = `${saChapter} SA`;
    }
    // Who may write this account is decided by BOTH its current role and the role being
    // saved, so nobody can promote an account (their own included) past what they manage.
    const existing = id ? await getDb().collection("members").doc(id).get() : null;
    const prev = existing && existing.exists ? existing.data() : null;
    assertCanManageMember(user,
      [prev && prev.role, member.role],
      [...memberChapters(prev), ...memberChapters(member)],
      [prev && prev.role === "ad" ? areaOf(prev) : null,
        member.role === "ad" ? areaOf({ area: member.area !== undefined ? member.area : prev?.area }) : null].filter(Boolean));
    // The Executive Director's PIN may be set or reset ONLY by the BNI Office master
    // account - not by an Area Director, Senior Director, or another ED. This covers
    // creating an ED account, changing an existing ED's PIN, and the role-swap bypass
    // (editing a record that is currently ED while flipping its role in the same save).
    if (pin) {
      const targetIsEd = member.role === "ed" || (prev && prev.role === "ed");
      if (targetIsEd && user?.id !== SR_LOGIN_ID) {
        throw forbidden("Only the BNI Office account can set or reset the Executive Director PIN");
      }
    }
    // Credentials are hashed here and only here; a plaintext `pin` never reaches Firestore.
    if (pin) {
      if (String(pin).length < MIN_PIN_LENGTH) throw badRequest(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
      member.pinHash = await bcrypt.hash(String(pin), 12);
      member.pinChangedAt = new Date().toISOString();
    }
    const docId = id || `m${Date.now()}`;
    await getDb().collection("members").doc(docId).set(member, { merge: Boolean(id) });
    invalidateSnapshotCache("members");
    // Record the account and, when it changed, the previous name - so a name being
    // reverted (e.g. an SA login going back to "<Chapter> SA") can be traced.
    const details = { memberName: member.name, memberId: docId, passwordChanged: Boolean(pin) };
    if (prev && prev.name && prev.name !== member.name) details.previousName = prev.name;
    await writeActivity(user, "member_saved", details);
    return ok({ member: { id: docId, ...stripPrivateMember(member) } }, 201);
  }

  if (first === "members" && second && method === "DELETE") {
    assertAdmin(user);
    const existing = await getDb().collection("members").doc(second).get();
    if (!existing.exists) throw notFound("Member not found");
    assertCanManageMember(user, [existing.data().role], memberChapters(existing.data()),
      existing.data().role === "ad" ? [areaOf(existing.data())] : []);
    await getDb().collection("members").doc(second).delete();
    invalidateSnapshotCache("members");
    await writeActivity(user, "member_deleted", { memberId: second, memberName: existing.data().name || "" });
    return noContent();
  }

  if (first === "weekly-data" && method === "GET") {
    const rows = await listCollection("weeklyData", { field: "date", direction: "desc" });
    return ok({ weeklyData: filterRowsToScope(user, rows) });
  }

  if (first === "weekly-data" && second && third && method === "PUT") {
    assertCanWriteChapter(user, second);
    const id = `${second}_${third}`;
    // Who saved it last - the account, plus its name and role so every chapter account
    // (SA, DC or Senior DC) can be told whose data they are about to replace.
    const entry = {
      ...cleanWeeklyNumbers(body), chapter: second, date: third,
      updatedAt: new Date().toISOString(), updatedBy: user.sub, updatedByName: await actorName(user), updatedByRole: user.role
    };
    await getDb().collection("weeklyData").doc(id).set(entry, { merge: true });
    invalidateSnapshotCache("weeklyData");
    await writeActivity(user, "weekly_entry_saved", { chapter: second, date: third });
    return ok({ entry: { id, ...entry } });
  }

  if (first === "weekly-data" && second && third && method === "DELETE") {
    assertCanWriteChapter(user, second);
    await getDb().collection("weeklyData").doc(`${second}_${third}`).delete();
    invalidateSnapshotCache("weeklyData");
    await writeActivity(user, "weekly_entry_deleted", { chapter: second, date: third });
    return noContent();
  }

  // Scoped exactly like the snapshot: without this, a chapter account could fetch every
  // chapter's dues rows (names, phone numbers) directly from here.
  if (first === "meta" && second && method === "GET") return ok({ meta: scopeMetaDoc(user, second, await getMetaDoc(second)) });

  if (first === "meta" && second && method === "PUT") {
    assertCanWrite(user);
    if (SCOPED_META_DOCS[second]) return writeScopedMeta(user, second, body);
    // The TLR and its history are kept one record per region and change only through the
    // TLR upload (POST /api/tlr-upload), which merges by chapter into each region's record.
    if (REGION_SPLIT_META[second]) throw forbidden("The TLR is changed by uploading the TLR report");
    if (CHAPTER_KEYED_META_DOCS[second]) {
      const chapterOf = CHAPTER_KEYED_META_DOCS[second];
      for (const key of Object.keys(body || {})) {
        const chapterName = chapterOf(key);
        if (!chapterName) throw badRequest(`"${key}" is not a chapter entry of ${second}`);
        assertCanWriteChapter(user, chapterName);
      }
    } else if (ADMIN_META_DOCS.has(second)) {
      assertAdmin(user);
      if (second === "config") await assertCanSaveConfig(user, body);
    } else if (!isRegionWide(user)) {
      // Shared by every region (the TLR, its history, the 12-month imports): an Area
      // Director runs one region, so only the Executive Director / BNI Office may change
      // these directly. The dashboard itself never does - the TLR upload merges by chapter.
      throw forbidden("Only the Executive Director / BNI Office account can change data shared by every region");
    }
    // The PIN fields are only settable through the dedicated hashed endpoint above. That
    // includes srPinChangedAt: a date in the future would sign the BNI Office out for good.
    const { srPin: _blockedPin, srPinHash: _blockedHash, srPinChangedAt: _blockedChangedAt, ...safeBody } = body || {};
    const meta = await setMetaDoc(second, safeBody, true);
    // A change of one region's team call day belongs to that region's activity.
    const dayAreas = second === "config" && safeBody.srCallDays && typeof safeBody.srCallDays === "object" ? Object.keys(safeBody.srCallDays) : [];
    await writeActivity(user, "meta_saved", { docId: second }, { area: dayAreas.length === 1 ? dayAreas[0] : null });
    return ok({ meta: scopeMetaDoc(user, second, meta) });
  }

  if (first === "activity" && method === "POST") {
    assertCanWrite(user);
    const action = String(body?.action || "");
    // The server already records these itself, with authoritative details.
    if (SERVER_LOGGED_ACTIONS.has(action)) return noContent();
    if (!BROWSER_ACTIONS.has(action)) throw badRequest("Unknown activity");
    await writeActivity(user, action, cleanActivityDetails(body?.details), { source: "browser" });
    return noContent();
  }

  if (COLLECTION_READ_ALLOWLIST.has(first) && !second && method === "GET") {
    // The on-demand collections are shared across users, so they go through the same
    // cache as the snapshot. The activity log is unbounded, so it is read newest-first
    // with a hard cap rather than pulling the whole collection and slicing afterwards.
    // Each region's newest entries are kept separately (scopeActivityRows), so twice the
    // per-region number is read.
    if (first === "activityLog") {
      const rows = await cachedListCollection(first, { field: "timestamp", direction: "desc" }, ACTIVITY_READ);
      return ok({ rows: await scopeActivityRows(user, rows) });
    }
    const rows = first === "miyagiMembers"
      ? await cachedListCollection(first)
      : await listCollection(first);
    return ok({ rows: first === "attendance" ? await scopeAttendanceRows(user, rows) : filterRowsToScope(user, rows) });
  }

  // New Miyagi members from a Length-of-Membership upload, added together. The browser
  // used to save them one at a time: an upload that stopped part-way (page closed, laptop
  // asleep, connection lost) left every later chapter without its members, and nothing
  // said so. ADD-ONLY - an id that already exists is left exactly as it is, so nothing
  // sent here can touch the progress of a member already in the program.
  if (first === "miyagi-new-members" && !second && method === "PUT") {
    assertCanWrite(user);
    const members = newMiyagiMembers(body?.members);
    members.forEach(m => assertCanWriteChapter(user, m.data.chapter));
    const db = getDb();
    const refs = members.map(m => db.collection("miyagiMembers").doc(m.id));
    const current = await db.getAll(...refs);
    const batch = db.batch();
    const added = [], existing = [], perChapter = {};
    members.forEach((m, i) => {
      if (current[i].exists) { existing.push(m.id); return; }
      batch.set(refs[i], m.data);
      added.push(m.id);
      perChapter[m.data.chapter] = (perChapter[m.data.chapter] || 0) + 1;
    });
    if (added.length) {
      await batch.commit();
      invalidateSnapshotCache("miyagiMembers");
      const chapters = Object.keys(perChapter).sort().map(c => `${c} ${perChapter[c]}`).join(", ");
      await writeActivity(user, "miyagi_members_added", { memberCount: added.length, chapters: chapters.slice(0, 200) });
    }
    return ok({ added, existing });
  }

  if (COLLECTION_WRITE_ALLOWLIST.has(first) && second && method === "PUT") {
    assertCanWrite(user);
    // Chapter-bearing rows are checked against the writer's scope, both for the row
    // being written and for the row already in place.
    if (body?.chapter) assertCanWriteChapter(user, body.chapter);
    const ref = getDb().collection(first).doc(second);
    const before = await ref.get();
    if (before.exists && before.data().chapter) assertCanWriteChapter(user, before.data().chapter);
    let payload = body || {};
    // A Miyagi "new member" record (empty checkpoints) must never overwrite an existing
    // member - that wiped progress whenever a Length-of-Membership upload ran without the
    // Miyagi list loaded. Against an existing record it may only fill fields that are
    // missing; existing ticks, score, status, check-ins and dates are kept.
    if (first === "miyagiMembers" && before.exists) {
      const cp = payload.checkpoints;
      if (cp && typeof cp === "object" && !Object.keys(cp).length) {
        const prevData = before.data();
        payload = Object.fromEntries(Object.entries(payload).filter(([k]) => prevData[k] === undefined));
        if (!Object.keys(payload).length) return ok({ row: docToData(before) });
      }
    }
    await ref.set(payload, { merge: true });
    invalidateSnapshotCache(first);
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
    invalidateSnapshotCache(first);
    await writeActivity(user, `${first}_deleted`, { id: second });
    return noContent();
  }

  // Check Barter: anonymous cross-chapter category exchange. Its own module keeps this
  // logic (and the anonymity rules) out of the shared snapshot path.
  if (first === "barter") return routeBarter({ method, segments, body, user, query: query || {} });

  throw notFound("Unknown API route");
}

export { isViewer };
