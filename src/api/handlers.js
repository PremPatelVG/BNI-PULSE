// Single implementation of every API route. The Express server and the Netlify
// function are thin adapters over this module, so the two deployments cannot drift.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { routeBarter } from "./barter.js";
import { config, requireProductionSecrets } from "../config.js";
import { getDb } from "../firebaseAdmin.js";
import { signSession } from "../middleware/auth.js";
import {
  applyTlrForMonth,
  buildSnapshot,
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
  scopeMetaDoc,
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
  forbidden,
  isAreaDirector,
  isSeniorDirector,
  isViewer,
  notFound,
  scopedChapterNames
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
// is region-wide and Area Director only, so a new document is locked down by default.
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
// Meta documents keyed by chapter: each top-level key names the chapter it belongs to,
// and a writer may only set keys for chapters they can write. Goals are edited by each
// chapter's own DC/SA as well as by leadership.
const CHAPTER_KEYED_META_DOCS = {
  chapterGoals: key => key,
  // `<Chapter>_<YYYY-MM>` or `<Chapter>_<YYYY-MM>_<field>`; chapter names may contain "_".
  monthlyTargets: key => (String(key).match(/^(.+)_\d{4}-\d{2}(?:_[A-Za-z]+)?$/) || [])[1] || null
};

const SR_LOGIN_ID = "__srdc__";

// POST /api/activity lets the browser add context to the log (member names, scores...).
// It used to accept any action name and any details, so anyone could write entries that
// looked like real deletions or Miyagi saves. Now only the browser's own action names
// are accepted, their details are kept small and flat, and they are stored with
// source "browser" - the server's own entries (source "server") are the evidence.
const BROWSER_ACTIONS = new Set([
  "attendance_marked", "branding_updated", "dues_report_uploaded", "fee_compliance_toggled",
  "length_of_membership_uploaded", "miyagi_checkin_submitted", "miyagi_checkpoint_toggled",
  "miyagi_checkpoints_saved", "miyagi_member_dropped", "monthly_target_saved",
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

// Accounts a Senior Director may create, edit or delete.
const CHAPTER_ACCOUNT_ROLES = new Set(["dc", "cd", "sa1", "sa2"]);

// The chapter fields a Senior Director may set (what the Settings chapter form sends).
const SRDC_CHAPTER_FIELDS = new Set(["id", "name", "day", "tenure", "target", "order", "openingMembers"]);

function memberChapters(m) {
  if (!m) return [];
  return [...(m.chapters || []), m.chapter].filter(Boolean);
}

// Who may write or delete a member account. `roles` lists every role involved - the
// account's current role and the role being saved - so an account can never be moved
// past what the caller manages (their own account included).
//  - Executive Director accounts: only the ED or the BNI Office account.
//  - Area Director / ED / BNI Office: any other account.
//  - Senior Director: only Chapter Director and SA accounts, in chapters they oversee.
function assertCanManageMember(user, roles, chapters) {
  const involved = roles.filter(Boolean);
  if (involved.includes("ed") && !(user?.role === "ed" || user?.id === SR_LOGIN_ID)) {
    throw forbidden("Only the Executive Director or the BNI Office account can manage Executive Director accounts");
  }
  if (isAreaDirector(user)) return;
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

// PIN sign-in is rate-limited. PINs can be 4 digits and the login directory lists every
// account, so without a limit any account falls to at most 10,000 guesses. Wrong PINs
// are counted per account and per client IP in Firestore (shared by every server
// instance) and checked before the PIN is compared, so a locked-out guess also costs no
// bcrypt work. A correct PIN clears the account's count, never the IP's - otherwise an
// attacker could reset it by signing in to their own account.
const LOGIN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
// [wrong PINs within the window, minutes locked]: the lock grows with repeated failures.
const ACCOUNT_LOCK_STEPS = [[5, 15], [10, 60], [15, 240]];
// One office network can carry many people's honest typos, so the IP limit is looser.
const IP_LOCK_STEPS = [[30, 30], [60, 240]];

function throttleRef(key) {
  return getDb().collection("loginThrottle").doc(key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120));
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

  const accountKey = `acct_${memberId}`;
  const ipKey = ip ? `ip_${ip}` : null;
  const [accountState, ipState] = await Promise.all([readThrottle(accountKey), readThrottle(ipKey)]);
  assertNotLocked(ipState, "from this network");
  assertNotLocked(accountState, "for this account");

  // Wrong PIN: count it against the IP always, and against the account only when the
  // account exists - made-up ids must not each create a throttle record.
  const wrongPin = async accountExists => {
    await Promise.all([
      recordFailure(ipKey, ipState, IP_LOCK_STEPS),
      accountExists ? recordFailure(accountKey, accountState, ACCOUNT_LOCK_STEPS) : null
    ]);
    throw httpError(401, "Incorrect PIN");
  };
  const clearAccount = async () => { if (accountState) await throttleRef(accountKey).delete(); };

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
async function loginDirectory() {
  const members = await cachedSnapshotCollection("members");
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

  const existingDoc = await getMetaDoc(docId);
  const existing = Array.isArray(existingDoc?.[listField]) ? existingDoc[listField] : [];
  const touchedChapters = new Set(incoming.map(row => row?.[chapterField]).filter(Boolean));
  const preserved = existing.filter(row => !touchedChapters.has(row?.[chapterField]));

  const { [listField]: _ignored, ...rest } = body || {};
  const meta = await setMetaDoc(docId, { ...rest, [listField]: [...preserved, ...incoming] }, true);
  await writeActivity(user, "meta_saved", { docId, rowCount: incoming.length });
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
    if (pin.length < 4) throw badRequest("PIN must be at least 4 digits");
    await setMetaDoc("config", { srPinHash: await bcrypt.hash(pin, 12), srPin: null, srPinChangedAt: new Date().toISOString() }, true);
    await writeActivity(user, "sr_pin_changed", {});
    return ok({ ok: true });
  }

  // Region-wide monthly TLR upload. Area Director / BNI Office account only.
  if (first === "tlr-upload" && method === "POST") {
    if (!isAreaDirector(user) && !isSeniorDirector(user)) throw forbidden("Only leadership (Area Director / Senior Director / BNI Office) can upload the TLR");
    const { monthIso, monthLabel, rows } = body || {};
    if (!/^\d{4}-\d{2}$/.test(String(monthIso || ""))) throw badRequest("A valid report month is required");
    if (!Array.isArray(rows) || !rows.length) throw badRequest("No chapter rows in the TLR");
    const result = await applyTlrForMonth(user, { monthIso, monthLabel, rows });
    await writeActivity(user, "tlr_report_uploaded", { month: monthIso, chaptersUpdated: result.chaptersUpdated, weeklyEntriesUpdated: result.weeklyEntriesUpdated });
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
    const members = await listCollection("members");
    return ok({ contacts: members.map(m => ({ id: m.id, name: m.name || "", role: m.role || "", chapter: m.chapter || "", chapters: m.chapters || [], phone: m.phone || m.contact || "" })) });
  }

  if (first === "members" && method === "POST") {
    assertAdmin(user);
    const { id, pin, pinHash: _rejectedHash, ...member } = body || {};
    if (!member.name) throw badRequest("Member name is required");
    if (member.role === "cd") member.role = "dc";
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
      [...memberChapters(prev), ...memberChapters(member)]);
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
      if (String(pin).length < 4) throw badRequest("PIN must be at least 4 digits");
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
    assertCanManageMember(user, [existing.data().role], memberChapters(existing.data()));
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
    const entry = { ...body, chapter: second, date: third, updatedAt: new Date().toISOString(), updatedBy: user.sub };
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
    if (CHAPTER_KEYED_META_DOCS[second]) {
      const chapterOf = CHAPTER_KEYED_META_DOCS[second];
      for (const key of Object.keys(body || {})) {
        const chapterName = chapterOf(key);
        if (!chapterName) throw badRequest(`"${key}" is not a chapter entry of ${second}`);
        assertCanWriteChapter(user, chapterName);
      }
    } else if (ADMIN_META_DOCS.has(second)) {
      assertAdmin(user);
    } else if (!isAreaDirector(user)) {
      throw forbidden("Only the Area Director / BNI Office account can change region-wide data");
    }
    // srPin is only settable through the dedicated hashed endpoint above.
    const { srPin: _blockedPin, srPinHash: _blockedHash, ...safeBody } = body || {};
    const meta = await setMetaDoc(second, safeBody, true);
    await writeActivity(user, "meta_saved", { docId: second });
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
    const rows = first === "activityLog"
      ? await cachedListCollection(first, { field: "timestamp", direction: "desc" }, 500)
      : first === "miyagiMembers"
        ? await cachedListCollection(first)
        : await listCollection(first);
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
