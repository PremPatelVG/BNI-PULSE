// In-memory stand-in for Firestore, used in place of src/firebaseAdmin.js by every test
// (see tests/helpers/setup.mjs). It implements the part of the Admin SDK the server
// uses: documents (get / set with merge / update / delete), add, queries (where,
// orderBy, limit), batches, transactions, getAll and FieldValue.serverTimestamp.
// Tests seed and inspect it through the helpers exported at the bottom.

const store = new Map();          // collection -> Map(id -> data)
export const stats = { reads: 0, writes: 0, byCollection: {} };
const failures = [];              // [{ match(op, path), error }]
let autoId = 0;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
const isFieldValue = v => v && typeof v === "object" && typeof v.methodName === "string" && v.methodName.startsWith("FieldValue.");
const clone = v => (v === undefined ? undefined : structuredClone(v));

function resolveValue(v) {
  if (isFieldValue(v)) {
    if (v.methodName === "FieldValue.serverTimestamp") return new Date().toISOString();
    if (v.methodName === "FieldValue.delete") return undefined;
    throw new Error("Fake Firestore does not support " + v.methodName);
  }
  if (Array.isArray(v)) return v.map(resolveValue);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(x)]));
  return v;
}

function deepMerge(target, patch) {
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (isFieldValue(v) && v.methodName === "FieldValue.delete") { delete out[k]; continue; }
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : resolveValue(v);
  }
  return out;
}

function col(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}
function count(kind, collection, n = 1) {
  stats[kind] += n;
  const c = (stats.byCollection[collection] = stats.byCollection[collection] || { reads: 0, writes: 0 });
  c[kind] += n;
}
function maybeFail(op, path) {
  const i = failures.findIndex(f => f.match(op, path));
  if (i < 0) return;
  const { error, once } = failures[i];
  if (once) failures.splice(i, 1);
  throw error;
}

function snapshotOf(ref) {
  const data = col(ref._col).get(ref.id);
  return {
    id: ref.id, ref, exists: data !== undefined,
    data: () => clone(data),
    get: field => field.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data)
  };
}

class DocumentReference {
  constructor(collection, id) { this._col = collection; this.id = id; this.path = collection + "/" + id; }
  collection() { throw new Error("Sub-collections are not supported by the fake"); }
  async get() { maybeFail("get", this.path); count("reads", this._col); return snapshotOf(this); }
  async set(data, options) { maybeFail("set", this.path); applySet(this, data, options); }
  async update(data) { maybeFail("update", this.path); applyUpdate(this, data); }
  async delete() { maybeFail("delete", this.path); applyDelete(this); }
}

function applySet(ref, data, options) {
  count("writes", ref._col);
  const current = col(ref._col).get(ref.id);
  col(ref._col).set(ref.id, options && options.merge ? deepMerge(current, data) : resolveValue(data));
}
function applyUpdate(ref, data) {
  const current = col(ref._col).get(ref.id);
  if (current === undefined) { const e = new Error("5 NOT_FOUND: No document to update: " + ref.path); e.code = 5; throw e; }
  count("writes", ref._col);
  const next = clone(current);
  for (const [path, v] of Object.entries(data)) {
    const keys = path.split(".");
    let o = next;
    keys.slice(0, -1).forEach(k => { if (!isPlainObject(o[k])) o[k] = {}; o = o[k]; });
    const last = keys[keys.length - 1];
    if (isFieldValue(v) && v.methodName === "FieldValue.delete") delete o[last];
    else o[last] = resolveValue(v);
  }
  col(ref._col).set(ref.id, next);
}
function applyDelete(ref) { count("writes", ref._col); col(ref._col).delete(ref.id); }

const ops = {
  "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b,
  "array-contains": (a, b) => Array.isArray(a) && a.includes(b),
  "in": (a, b) => Array.isArray(b) && b.includes(a)
};

class Query {
  constructor(collection, spec = {}) { this._col = collection; this._spec = spec; }
  where(field, op, value) {
    if (!ops[op]) throw new Error("Fake Firestore does not support where op " + op);
    return new Query(this._col, { ...this._spec, where: [...(this._spec.where || []), [field, op, value]] });
  }
  orderBy(field, direction = "asc") { return new Query(this._col, { ...this._spec, orderBy: [...(this._spec.orderBy || []), [field, direction]] }); }
  limit(n) { return new Query(this._col, { ...this._spec, limit: n }); }
  async get() {
    maybeFail("query", this._col);
    let docs = [...col(this._col).keys()].map(id => snapshotOf(new DocumentReference(this._col, id)));
    for (const [field, op, value] of this._spec.where || []) docs = docs.filter(d => d.exists && ops[op](d.get(field), value));
    for (const [field, dir] of [...(this._spec.orderBy || [])].reverse()) {
      docs.sort((a, b) => { const x = a.get(field), y = b.get(field); return (x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1) * (dir === "desc" ? -1 : 1); });
    }
    if (this._spec.limit) docs = docs.slice(0, this._spec.limit);
    count("reads", this._col, Math.max(docs.length, 1));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: fn => docs.forEach(fn) };
  }
}

class CollectionReference extends Query {
  constructor(name) { super(name); this.id = name; }
  doc(id) { return new DocumentReference(this._col, id || "auto" + (++autoId).toString().padStart(6, "0")); }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
}

class WriteBatch {
  constructor() { this._ops = []; }
  set(ref, data, options) { this._ops.push(() => applySet(ref, data, options)); return this; }
  update(ref, data) { this._ops.push(() => applyUpdate(ref, data)); return this; }
  delete(ref) { this._ops.push(() => applyDelete(ref)); return this; }
  async commit() { maybeFail("commit", "batch"); this._ops.forEach(op => op()); }
}

const db = {
  collection: name => new CollectionReference(name),
  batch: () => new WriteBatch(),
  async getAll(...refs) { return Promise.all(refs.map(r => r.get())); },
  async listCollections() { return [...store.keys()].map(name => new CollectionReference(name)); },
  // Runs the function once; its writes are applied only if it finishes without throwing.
  async runTransaction(fn) {
    const writes = [];
    const t = {
      get: refOrQuery => refOrQuery.get(),
      set(ref, data, options) { writes.push(() => applySet(ref, data, options)); return t; },
      update(ref, data) { writes.push(() => applyUpdate(ref, data)); return t; },
      delete(ref) { writes.push(() => applyDelete(ref)); return t; }
    };
    const result = await fn(t);
    writes.forEach(w => w());
    return result;
  }
};

// --- the module interface the server imports (src/firebaseAdmin.js) ---
export function getDb() { return db; }
export function getFirebaseAdmin() { return {}; }

// --- helpers for tests ---
export function reset() {
  store.clear(); failures.length = 0; autoId = 0;
  stats.reads = 0; stats.writes = 0; stats.byCollection = {};
}
export function resetStats() { stats.reads = 0; stats.writes = 0; stats.byCollection = {}; }
export function seed(collection, id, data) { col(collection).set(id, resolveValue(clone(data))); }
export function read(collection, id) { return clone(col(collection).get(id)); }
export function all(collection) { return [...col(collection).entries()].map(([id, data]) => ({ id, ...clone(data) })); }
export function remove(collection, id) { col(collection).delete(id); }
// Makes matching operations throw, e.g. failWhen((op, path) => path.startsWith("_system"), err).
export function failWhen(match, error = Object.assign(new Error("14 UNAVAILABLE: injected"), { code: 14 }), { once = false } = {}) {
  failures.push({ match, error, once });
}
export function clearFailures() { failures.length = 0; }
