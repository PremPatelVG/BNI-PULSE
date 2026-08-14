import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("index.html", "utf8");
const scriptMatch = html.match(/<script>\s*const HIST = ([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("Could not locate dashboard inline script");

const elements = new Map();

function makeElement(id = "") {
  return {
    id,
    value: "",
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: {},
    children: [],
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    focus() {},
    select() {},
    scrollIntoView() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    contains() {
      return false;
    }
  };
}

function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

const writes = [];
const context = {
  console,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Set,
  Map,
  Promise,
  encodeURIComponent,
  decodeURIComponent,
  parseInt,
  parseFloat,
  isNaN,
  setTimeout(fn) {
    return typeof fn === "function" ? 0 : 0;
  },
  clearTimeout() {},
  confirm() {
    return true;
  },
  alert() {},
  localStorage: {
    store: {},
    getItem(key) {
      return this.store[key] || null;
    },
    setItem(key, value) {
      this.store[key] = String(value);
    },
    removeItem(key) {
      delete this.store[key];
    }
  },
  location: {
    search: "?preview=login",
    hostname: "127.0.0.1"
  },
  MutationObserver: class {
    observe() {}
  },
  document: {
    readyState: "loading",
    activeElement: null,
    addEventListener() {},
    execCommand() {
      return true;
    },
    createElement(tag) {
      return makeElement(tag);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById: el
  },
  window: {
    __BNI_PULSE_CONFIG__: {
      firebase: {
        apiKey: "test",
        authDomain: "test",
        projectId: "test",
        storageBucket: "test",
        messagingSenderId: "test",
        appId: "test"
      }
    },
    scrollTo() {}
  },
  firebase: {
    apps: [{}],
    initializeApp() {},
    firestore() {
      return {
        collection(collectionName) {
          return {
            doc(docId) {
              return {
                async set(data, options) {
                  writes.push({ collectionName, docId, data, options });
                },
                async update(data) {
                  writes.push({ collectionName, docId, data, update: true });
                },
                async delete() {
                  writes.push({ collectionName, docId, delete: true });
                },
                onSnapshot() {
                  return () => {};
                }
              };
            },
            orderBy() {
              return this;
            },
            limit() {
              return this;
            },
            onSnapshot() {
              return () => {};
            },
            async get() {
              return { forEach() {} };
            },
            async add(data) {
              writes.push({ collectionName, add: true, data });
            }
          };
        }
      };
    }
  }
};
context.window.window = context.window;
context.window.document = context.document;
context.window.localStorage = context.localStorage;
context.window.location = context.location;
context.window.firebase = context.firebase;
context.globalThis = context;

vm.createContext(context);
vm.runInContext(scriptMatch[0].replace(/^<script>/, "").replace(/<\/script>$/, ""), context, {
  filename: "index.html"
});

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
  else console.log(`OK ${message}`);
}

async function runInApp(code) {
  return vm.runInContext(`(async()=>{${code}\n})()`, context);
}

await runInApp(`
  S.localPreview=true;
  S.user={id:'ad-yash',name:'Yash Vasant',role:'ad',chapters:[],chapter:''};
  S.tab='pipeline';
  S.chapters=[
    {name:'Alpha',day:'Tuesday',seniorDirector:'Senior One',chapterDirector:'Director One'},
    {name:'Beta',day:'Wednesday',seniorDirector:'Senior Two',chapterDirector:'Director Two'}
  ];
  S.members=[
    {id:'ad-yash',name:'Yash Vasant',role:'ad',chapters:[]},
    {id:'srdc-one',name:'Senior One',role:'srdc',chapters:['Alpha']},
    {id:'dc-one',name:'Director One',role:'dc',chapter:'Alpha',chapters:['Alpha']}
  ];
  S.weeklyData=[{
    chapter:'Alpha',date:'2026-08-11',filledBy:'Director One',filledByRole:'dc',
    visitors_list:[],membersStart:10,inductions:0,drops:0,membersClose:10,membersConnect:10,
    visitors:2,posVisitors:2,concall:'Yes',tlr:75,conversionPct:40,onetwentyone:5,
    references:10,tyfcb:100000,eoiYes:2,eoiMaybe:0,eoiNo:0,eoiPending:0,eoi:2,pipeline:0,
    renewals:0,training:0,successStory:''
  }];
  S.visitorPipeline=[
    {id:'p1',chapter:'Alpha',name:'Visitor One',category:'IT',addedDate:'2026-08-11',stage:'pipeline',stageChangedDate:'2026-08-11'},
    {id:'p2',chapter:'Alpha',name:'Visitor Two',category:'Finance',addedDate:'2026-08-11',stage:'pipeline',stageChangedDate:'2026-08-11'}
  ];
  S.duesData=[
    {chapter:'Alpha',name:'Due One',industry:'IT',dueDate:'2026-08-01'},
    {chapter:'Alpha',name:'Due Two',industry:'Finance',dueDate:'2026-09-01'}
  ];
  S.renewalsDone={};
  S.tlrData=[{name:'Alpha',score:75,chapterSize:10,tyfcb:'100000'}];
  S.monthlyTargets={};
  S.pipelineFilterStage='pipeline';
`);

await runInApp(`await markContactStage('p1','inducted');`);
let state = await runInApp(`
  const entry=S.weeklyData.find(e=>e.chapter==='Alpha'&&e.date==='2026-08-11');
  return {stage:S.visitorPipeline.find(p=>p.id==='p1').stage,filter:S.pipelineFilterStage,inductions:entry.inductions,close:entry.membersClose,ids:entry.pipelineInductedIds||[]};
`);
assert(state.stage === "inducted", "Pipeline p1 moves to inducted");
assert(state.filter === "inducted", "Pipeline filter follows inducted contact");
assert(state.inductions === 1 && state.close === 11, "Pipeline p1 increments weekly scorecard induction and close count");
assert(state.ids.includes("p1"), "Pipeline p1 counted ID stored on weekly scorecard");

await runInApp(`await markContactStage('p1','inducted');`);
state = await runInApp(`
  const entry=S.weeklyData.find(e=>e.chapter==='Alpha'&&e.date==='2026-08-11');
  return {inductions:entry.inductions,close:entry.membersClose,ids:entry.pipelineInductedIds||[]};
`);
assert(state.inductions === 1 && state.ids.filter((id) => id === "p1").length === 1, "Repeated inducted action does not double count");

await runInApp(`S.pipelineFilterStage='pipeline'; await markContactStage('p2','inducted');`);
state = await runInApp(`
  const entry=S.weeklyData.find(e=>e.chapter==='Alpha'&&e.date==='2026-08-11');
  return {inductions:entry.inductions,close:entry.membersClose,ids:entry.pipelineInductedIds||[]};
`);
assert(state.inductions === 2 && state.close === 12, "Two inducted pipeline contacts count as two scorecard inductions");

await runInApp(`await markContactStage('p1','pipeline');`);
state = await runInApp(`
  const entry=S.weeklyData.find(e=>e.chapter==='Alpha'&&e.date==='2026-08-11');
  return {stage:S.visitorPipeline.find(p=>p.id==='p1').stage,inductions:entry.inductions,close:entry.membersClose,ids:entry.pipelineInductedIds||[]};
`);
assert(state.stage === "pipeline", "Reopen returns p1 to pipeline");
assert(state.inductions === 1 && state.close === 11 && !state.ids.includes("p1"), "Reopen removes p1 from weekly scorecard induction count");

await runInApp(`await markContactStage('p1','dropped');`);
state = await runInApp(`
  const entry=S.weeklyData.find(e=>e.chapter==='Alpha'&&e.date==='2026-08-11');
  return {stage:S.visitorPipeline.find(p=>p.id==='p1').stage,inductions:entry.inductions,close:entry.membersClose};
`);
assert(state.stage === "dropped" && state.inductions === 1 && state.close === 11, "Dropped non-inducted contact does not change scorecard count");

const scorecard = await runInApp(`
  document.getElementById('rFrom').value='2026-08-01';
  document.getElementById('rTo').value='2026-08-31';
  document.getElementById('rChap').value='';
  runScorecard();
  return document.getElementById('reportContent').innerHTML;
`);
assert(/Alpha/.test(scorecard) && /<strong>\+1<\/strong>/.test(scorecard), "Chapter Scorecard report reflects pipeline-synced net add");

const adTargets = await runInApp(`return renderAreaDirectorTargets(11,S.chapters);`);
assert(/Cumulative Net Added/.test(adTargets), "AD target card renders cumulative net section");
assert(/active member movement/.test(adTargets), "AD cumulative net card renders movement label");

await runInApp(`S.tab='renewals'; renderRenewals();`);
let renewalsHtml = await runInApp(`return document.getElementById('tab-renewals').innerHTML;`);
assert(/Total Due/.test(renewalsHtml) && /Due One/.test(renewalsHtml), "Renewals list renders due members in current range");
await runInApp(`await markRenewalDone('Alpha',encodeURIComponent('Due One'),'2026-08-01');`);
renewalsHtml = await runInApp(`return document.getElementById('tab-renewals').innerHTML;`);
assert(/Complete/.test(renewalsHtml), "Renewal marked done renders Complete badge");

const retentionHtml = await runInApp(`return renderAreaDirectorRetention(S.chapters);`);
assert(/Retention Tracker/.test(retentionHtml) && /Renewals Done/.test(retentionHtml), "Retention module renders from dues and renewalsDone data");

const retro = await runInApp(`return getChapterMonthRetro(S.chapters[0],'2026-08');`);
assert(retro.inductions === 1 && retro.netAdd === 1 && retro.closeMembers === 11, "Monthly retrospective uses synced induction and cascaded close count");

const cascaded = await runInApp(`return getCascadedEntries('Alpha')[0];`);
assert(cascaded.inductions === 1 && cascaded.membersClose === 11, "Cascaded entries use synced induction count");

if (failures.length) {
  console.error("\\nDeep logic regression failures:");
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}

console.log("\nDeep dashboard logic regression passed.");
