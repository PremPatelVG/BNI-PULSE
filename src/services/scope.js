// Role-based access control. This is the single source of truth for "who may see or
// change what"; both the Express server and the Netlify function route through it so
// the two deployments cannot drift apart.

export const ROLE_AD = "ad";
export const ROLE_SRDC = "srdc";
export const ROLE_VIEWER = "viewer";
const CHAPTER_ROLES = new Set(["dc", "cd", "sa1", "sa2"]);

export function isAreaDirector(user) {
  return user?.role === ROLE_AD;
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

// Area Directors and Viewers see the whole region. Everyone else is limited to the
// chapters stored on their member record. Returning null means "unrestricted".
export function scopedChapterNames(user) {
  if (isAreaDirector(user) || isViewer(user)) return null;
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

// Viewers are read-only everywhere. Chapter roles may only write inside their own
// chapters. Area Directors and Senior Directors write anywhere they can read.
export function canWriteChapter(user, chapterName) {
  if (!user || isViewer(user)) return false;
  if (isAreaDirector(user)) return true;
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
