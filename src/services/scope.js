// Role-based access control. This is the single source of truth for "who may see or
// change what"; both the Express server and the Netlify function route through it so
// the two deployments cannot drift apart.

export const ROLE_AD = "ad";
export const ROLE_ED = "ed";
export const ROLE_SRDC = "srdc";
export const ROLE_VIEWER = "viewer";
const CHAPTER_ROLES = new Set(["dc", "cd", "sa1", "sa2"]);

// The BNI Office master account signs in under this fixed id and runs as role "ad".
export const SR_LOGIN_ID = "__srdc__";

// The dashboard covers more than one BNI region ("area" here, so it is not confused with
// the older `region` field some chapters carry, e.g. "Ahmedabad West"). Chapters and
// Area Director accounts carry `area`; a missing value means Ahmedabad, the region the
// dashboard started with, so existing data needs no change.
export const AREAS = [
  { id: "ahmedabad", label: "Ahmedabad" },
  { id: "north-gujarat", label: "North Gujarat" }
];
export const DEFAULT_AREA = "ahmedabad";
const AREA_IDS = new Set(AREAS.map(a => a.id));

export function isKnownArea(id) {
  return AREA_IDS.has(id);
}

export function areaOf(record) {
  return (record && AREA_IDS.has(record.area)) ? record.area : DEFAULT_AREA;
}

// The Executive Director and the BNI Office account run every region. An Area Director
// runs only their own region (see scopedChapterNames).
export function isRegionWide(user) {
  return user?.role === ROLE_ED || user?.id === SR_LOGIN_ID;
}

// The Executive Director sits above the Area Director with the same leadership powers,
// so isAreaDirector() also matches ED. What chapters those powers reach is decided by
// scopedChapterNames(): every region for the ED and BNI Office, one region for an AD.
export function isAreaDirector(user) {
  return user?.role === ROLE_AD || user?.role === ROLE_ED;
}

export function isSeniorDirector(user) {
  return user?.role === ROLE_SRDC;
}

export function isViewer(user) {
  return user?.role === ROLE_VIEWER;
}

export function isChapterRole(user) {
  return CHAPTER_ROLES.has(user?.role);
}

// The Executive Director, the BNI Office account and Viewers see every region. An Area
// Director sees the chapters of their own region: `areaChapters`, filled in from the
// chapters collection on every request (handlers.js refreshSessionUser) - an AD without
// it sees nothing, never everything. Everyone else is limited to the chapters stored on
// their member record. Returning null means "unrestricted".
export function scopedChapterNames(user) {
  if (isRegionWide(user) || isViewer(user)) return null;
  if (user?.role === ROLE_AD) return Array.isArray(user.areaChapters) ? [...user.areaChapters] : [];
  const names = new Set();
  (user?.chapters || []).forEach(name => { if (name) names.add(name); });
  if (user?.chapter) names.add(user.chapter);
  return [...names];
}

export function canReadChapter(user, chapterName) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return true;
  return allowed.includes(chapterName);
}

// Viewers are read-only everywhere. Everyone else writes exactly where they can read:
// chapter roles in their own chapters, Senior Directors in the chapters they oversee,
// an Area Director in their region, the ED and BNI Office anywhere.
export function canWriteChapter(user, chapterName) {
  if (!user || isViewer(user)) return false;
  const allowed = scopedChapterNames(user);
  if (allowed === null) return true;
  return allowed.includes(chapterName);
}

export function canWrite(user) {
  return Boolean(user) && !isViewer(user);
}

export function isAdmin(user) {
  return isAreaDirector(user) || isSeniorDirector(user);
}

export function forbidden(message = "Insufficient permissions") {
  const error = new Error(message);
  error.status = 403;
  return error;
}

export function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function notFound(message = "Not found") {
  const error = new Error(message);
  error.status = 404;
  return error;
}

// Rows that carry a `chapter` field get filtered down to the caller's scope.
export function filterRowsToScope(user, rows) {
  const allowed = scopedChapterNames(user);
  if (allowed === null) return rows;
  return rows.filter(row => !row?.chapter || allowed.includes(row.chapter));
}

export function assertCanWriteChapter(user, chapterName) {
  if (!canWriteChapter(user, chapterName)) {
    throw forbidden(`You do not have write access to ${chapterName || "this chapter"}`);
  }
}

export function assertCanWrite(user) {
  if (!canWrite(user)) throw forbidden("This account is read-only");
}

export function assertAdmin(user) {
  if (!isAdmin(user)) throw forbidden();
}
