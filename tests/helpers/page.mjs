// Loads the dashboard's script (index.html) into a sandbox with a minimal DOM, and wires
// its network calls straight into the real API router + the in-memory database - so a
// client test exercises the page code and the server code together, with no network.
import fs from "node:fs";
import vm from "node:vm";
import { routeApi } from "../../src/api/handlers.js";
import { signSession } from "../../src/middleware/auth.js";
import * as fake from "./fake-firestore.mjs";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const SCRIPT = html.match(/<script>\s*const HIST = ([\s\S]*?)<\/script>/)[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

function makeElement(id = "") {
  return {
    id, value: "", innerHTML: "", innerText: "", textContent: "", dataset: {}, style: {}, children: [], tagName: "INPUT",
    checked: false, disabled: false, readOnly: false, title: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, select() {}, click() {}, scrollIntoView() {},
    setAttribute(n, v) { this[n] = v; }, getAttribute(n) { return this[n]; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }
  };
}

export function loadPage() {
  const elements = new Map();
  const log = { toasts: [], confirms: [], alerts: [], calls: [] };
  let confirmAnswer = true;
  const failures = []; // { match: RegExp on "METHOD /path", kind: "network" | status }

  async function fetchImpl(url, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    const path = String(url).replace(/^\/api/, "");
    const [pathname, qs] = path.split("?");
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    log.calls.push({ method, path: pathname, body });
    const fi = failures.findIndex(f => f.match.test(method + " " + pathname));
    if (fi >= 0) {
      const f = failures.splice(fi, 1)[0];
      if (f.kind === "network") throw new TypeError("Failed to fetch");
      return { status: f.kind, ok: false, async text() { return JSON.stringify({ error: "Injected " + f.kind }); } };
    }
    let status, payload;
    try {
      const r = await routeApi({
        method, segments: pathname.split("/").filter(Boolean).map(decodeURIComponent), body,
        authorization: opts.headers && opts.headers.Authorization, query: Object.fromEntries(new URLSearchParams(qs || "")), ip: "127.0.0.1"
      });
      status = r.status; payload = r.body;
    } catch (e) {
      status = e.status || 500; payload = { error: e.message };
    }
    return { status, ok: status >= 200 && status < 300, async text() { return payload === null || payload === undefined ? "" : JSON.stringify(payload); } };
  }

  const ctx = {
    console, URLSearchParams, URL, Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise, Error, TypeError, Symbol, Intl,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite, structuredClone,
    // Timers run at once, so retry back-offs don't slow the tests down.
    setTimeout(fn) { if (typeof fn === "function") Promise.resolve().then(fn); return 0; },
    clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    confirm(m) { log.confirms.push(m); return confirmAnswer; },
    alert(m) { log.alerts.push(m); },
    navigator: { onLine: true },
    fetch: fetchImpl,
    localStorage: { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } },
    location: { search: "", hostname: "bni.example", reload() {} },
    MutationObserver: class { observe() {} },
    document: {
      readyState: "loading", hidden: false, activeElement: null,
      addEventListener() {}, removeEventListener() {}, execCommand() { return true; },
      createElement: t => makeElement(t), querySelector() { return null; }, querySelectorAll() { return []; },
      getElementById: id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); }
    },
    window: { __BNI_PULSE_CONFIG__: { firebase: {} }, scrollTo() {} }
  };
  Object.assign(ctx.window, { window: ctx.window, document: ctx.document, localStorage: ctx.localStorage, location: ctx.location });
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx, { filename: "index.html" });
  vm.runInContext("toast=function(m){globalThis.__toast(String(m));};", ctx);
  ctx.__toast = m => log.toasts.push(m);

  const page = {
    ctx, log,
    el: id => ctx.document.getElementById(id),
    // Runs code inside the page (async function body; `return` a value). The result is
    // handed back as a plain copy: values built inside the sandbox carry its own Array /
    // Object types, which strict assertions would otherwise treat as different.
    run: async code => {
      const v = await vm.runInContext(`(async()=>{${code}\n})()`, ctx);
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    set: (name, value) => { ctx["__set_" + name] = value; return vm.runInContext(`${name}=globalThis.__set_${name}`, ctx); },
    answerConfirm(v) { confirmAnswer = v; },
    failNext(match, kind = "network", times = 1) { for (let i = 0; i < times; i++) failures.push({ match, kind }); },
    clearLog() { log.toasts.length = 0; log.confirms.length = 0; log.alerts.length = 0; log.calls.length = 0; },
    // Signs the page in as a seeded account (session token + S.user from the member record).
    async signIn(user) {
      const rec = user.id === "__srdc__" ? { name: "BNI Office Account" } : fake.read("members", user.id) || {};
      ctx.__user = { id: user.id, name: rec.name || user.id, role: user.role, chapter: user.chapter, chapters: user.chapters || [] };
      ctx.__token = signSession(user);
      await page.run(`setAuthToken(globalThis.__token);S.user=globalThis.__user;S.localPreview=false;`);
    },
    // Starts the app's real data listeners (subAll) and waits for the first snapshot, so
    // the page's state is filled - and kept refreshed - exactly as after a real sign-in.
    async loadData() {
      await page.run(`if(!S.unsubs||!S.unsubs.length)subAll();await refreshSnapshot();`);
    }
  };
  return page;
}
