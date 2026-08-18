// Parser verification: dates, chapter matching, dues table parsing, TLR text parsing,
// and integrity of the parsed data files. Run via `npm run test:parsers` or `npm run check`.
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("index.html", "utf8");
const script = html.match(/<script>\s*const HIST = ([\s\S]*?)<\/script>/)[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

const make = (id = "") => ({ id, value: "", innerHTML: "", textContent: "", dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; }, remove() {}, focus() {}, select() {}, scrollIntoView() {}, setAttribute(n, v) { this[n] = v; }, getAttribute(n) { return this[n]; }, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; } });
const els = new Map();
const el = id => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
const ctx = {
  console, URLSearchParams, Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  setTimeout: fn => 0, clearTimeout() {}, confirm: () => true, alert() {},
  DOMParser: class { parseFromString() { return { getElementsByTagName: () => [], getElementsByTagNameNS: () => [] }; } },
  localStorage: { store: {}, getItem() { return null; }, setItem() {}, removeItem() {} },
  location: { search: "?preview=login", hostname: "127.0.0.1" },
  MutationObserver: class { observe() {} },
  document: { readyState: "loading", activeElement: null, addEventListener() {}, createElement: make, querySelector: () => null, querySelectorAll: () => [], getElementById: el },
  window: { __BNI_PULSE_CONFIG__: { firebase: { apiKey: "t", authDomain: "t", projectId: "t", storageBucket: "t", messagingSenderId: "t", appId: "t" } }, scrollTo() {} },
  firebase: { apps: [{}], initializeApp() {}, firestore: () => ({ collection: () => ({ doc: () => ({ set: async () => {}, update: async () => {}, delete: async () => {}, onSnapshot: () => () => {} }), orderBy() { return this; }, limit() { return this; }, onSnapshot: () => () => {}, get: async () => ({ forEach() {} }), add: async () => {} }) }) }
};
ctx.window.window = ctx.window; ctx.window.document = ctx.document; ctx.window.location = ctx.location; ctx.window.firebase = ctx.firebase; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx, { filename: "index.html" });

const run = code => vm.runInContext(`(function(){${code}})()`, ctx);

// Load the real chapter set so chapter-matching is realistic.
const tlr = JSON.parse(fs.readFileSync("local-tlr-data.json", "utf8")).rows;
const chapterNames = [...new Set(tlr.map(r => r.name))];
run(`S.user={id:'ad',name:'AD',role:'ad',chapters:[]};S.chapters=${JSON.stringify(chapterNames.map((n, i) => ({ name: n, order: i + 1 })))};`);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK " : "FAIL"} ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log("=== toIsoDate (date parser) ===");
check("ISO passthrough", run(`return toIsoDate('2026-08-15')`), "2026-08-15");
check("dd/mm/yyyy", run(`return toIsoDate('15/08/2026')`), "2026-08-15");
check("dd-mm-yy", run(`return toIsoDate('15-08-26')`), "2026-08-15");
check("15 Aug 2026", run(`return toIsoDate('15 Aug 2026')`), "2026-08-15");
check("Excel serial 46249", run(`return toIsoDate(46249)`), "2026-08-15");
check("Date object (local)", run(`return toIsoDate(new Date(2026,7,15))`), "2026-08-15");
check("empty -> ''", run(`return toIsoDate('')`), "");

console.log("\n=== matchChapterName (chapter matching) ===");
check("exact", run(`return matchChapterName('Lincoln')`), "Lincoln");
check("BNI prefix", run(`return matchChapterName('BNI Lincoln')`), "Lincoln");
check("region > chapter", run(`return matchChapterName('Ahmedabad West > Lincoln')`), "Lincoln");
check("lowercase", run(`return matchChapterName('lincoln')`), "Lincoln");
// collision check: every canonical chapter name must map to itself
const collisions = run(`
  var out=[];
  reportChapterNames().forEach(function(ch){ var m=matchChapterName(ch); if(m!==ch) out.push(ch+' -> '+m); });
  return out;
`);
check("no self-mapping collisions across all chapters", collisions, []);

console.log("\n=== parseDuesRows (dues Excel/table parser) ===");
const duesRows = run(`
  var rows=[
    ['Chapter Name','First Name','Last Name','Industry','Membership Type','Status','Renewal Due'],
    ['BNI Lincoln','Hardik','Khamar','IT','1 Year','Active','15/09/2026'],
    ['BNI Lincoln','Parth','Mandge','Finance','2 Year','Dropped','01/10/2026'],
    ['Ahmedabad > Ares','Alpesh','Shah','Realty','1 Year','Active','2026-11-20']
  ];
  return parseDuesRows(rows);
`);
check("dues: active rows only (drops excluded)", duesRows.length, 2);
check("dues: chapter matched", duesRows[0].chapter, "Lincoln");
check("dues: name joined", duesRows[0].name, "Hardik Khamar");
check("dues: due date normalized", duesRows[0].dueDate, "2026-09-15");
check("dues: ISO due date passthrough", duesRows[1].dueDate, "2026-11-20");

console.log("\n=== parseTLRText (TLR text parser) ===");
const tlrParsed = run(`return parseTLRText('Lincoln 53 2.5 90.0 1.2 1.5 25 8.0 85', 'test.txt')`);
check("tlr: one row parsed", tlrParsed.length, 1);
check("tlr: chapter", tlrParsed[0] && tlrParsed[0].name, "Lincoln");
check("tlr: score is last number", tlrParsed[0] && tlrParsed[0].score, "85");
check("tlr: chapterSize first", tlrParsed[0] && tlrParsed[0].chapterSize, "53");

console.log("\n=== parsed data-file integrity ===");
const dues = JSON.parse(fs.readFileSync("local-dues-data.json", "utf8")).members;
check("dues file: every row has chapter/name/dueDate", dues.every(m => m.chapter && m.name && m.dueDate), true);
check("dues file: every dueDate is ISO", dues.every(m => /^\d{4}-\d{2}-\d{2}$/.test(m.dueDate)), true);
check("tlr file: every row has name+score", tlr.every(r => r.name && r.score !== undefined && r.score !== ""), true);

console.log(`\n${fail ? "PARSER FAILURES: " + fail : "ALL PARSER CHECKS PASSED"} (${pass} passed)`);
process.exit(fail ? 1 : 0);
