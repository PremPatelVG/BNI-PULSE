import fs from "node:fs";

const failures = [];
const warnings = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return null;
  }
}

function pass(label) {
  console.log(`OK ${label}`);
}

function assert(condition, label) {
  if (condition) pass(label);
  else failures.push(label);
}

function warn(condition, label) {
  if (condition) warnings.push(label);
  else pass(label);
}

function countBy(items, keyFn) {
  return items.reduce((out, item) => {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
}

const html = fs.readFileSync("index.html", "utf8");
const netlifyToml = fs.readFileSync("netlify.toml", "utf8");
const envText = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const tlr = readJson("local-tlr-data.json");
const dues = readJson("local-dues-data.json");

assert(/function markContactStage\(pid,stage\)[\s\S]*Object\.assign\(localContact,updates\)/.test(html), "Pipeline stage changes update local state immediately");
assert(/S\.pipelineFilterStage&&S\.pipelineFilterStage!==stage/.test(html), "Pipeline filter follows newly selected stage");
assert(/stage==='inducted'\?'Inducted'/.test(html), "Pipeline inducted status label is plain and visible");
assert(/function syncPipelineStageToScorecard/.test(html), "Pipeline inducted stage syncs into scorecard");
assert(/pipelineInductedIds/.test(html), "Pipeline scorecard sync prevents duplicate induction counts");
assert(/value:'30d',label:'30 days'/.test(html), "AD Cumulative Net Added has 30 days option");
assert(/value:'6m',label:'6 months'/.test(html), "AD Cumulative Net Added has 6 months option");
assert(/value:'12m',label:'12 months'/.test(html), "AD Cumulative Net Added has 12 months option");
assert(/rangeBtn\(30\)[\s\S]*rangeBtn\(60\)[\s\S]*rangeBtn\(90\)/.test(html), "Renewals has 30/60/90 day filters");
assert(/Complete<\/span>/.test(html), "Renewals marked done renders Complete badge");
assert(/AREA_DIRECTOR_SUPPORT_YEAR_TARGET=696/.test(html), "Support scorecard yearly target is 696");
assert(/AREA_DIRECTOR_SUPPORT_QUARTER_TARGET=174/.test(html), "Support scorecard quarterly target is 174");
assert(/\{id:'planning',label:'Planning'\}/.test(html), "AD dashboard includes Planning tab");
assert(/showMemberPasswordConfirmation\(data,pin,!id\)/.test(html), "Member password changes show detailed confirmation");
assert(/New password\/PIN: '\+pin/.test(html), "Password confirmation includes the new password");
assert(/toast\(msg,10000\)/.test(html), "Password confirmation stays visible for 10 seconds");
assert(/apiFetch\('\/auth\/login'/.test(html), "Login uses API PIN verification");

// Security invariants. These previously regressed silently, so they are asserted.
assert(!/data\.pin=pin;.*FieldValue\.delete/.test(html), "Frontend never writes a plaintext PIN to the database");
assert(!/gstatic\.com\/firebasejs/.test(html), "Frontend ships no Firebase SDK and holds no database credentials");
assert(!/firebase\.initializeApp/.test(html), "Frontend does not initialise a direct database connection");
assert(/function esc\(v\)/.test(html) && /_ESC_MAP/.test(html), "HTML escaping helper is defined");
assert(/function jsArg\(v\)/.test(html), "Inline-handler escaping helper is defined");
assert(/apiFetch\('\/auth\/login-directory'\)/.test(html), "Login list comes from the credential-free directory endpoint");

const serverJs = fs.readFileSync("src/server.js", "utf8");
assert(!/express\.static\(rootDir/.test(serverJs), "Repository root is not served as static files");
assert(/express\.static\(path\.join\(rootDir, "vendor"\)/.test(serverJs), "Only vendor assets are served statically");
assert(fs.existsSync(".dockerignore"), ".dockerignore exists so credentials are not baked into images");
const dockerIgnore = fs.existsSync(".dockerignore") ? fs.readFileSync(".dockerignore", "utf8") : "";
assert(/firebase-service-account-base64\.txt/.test(dockerIgnore) && /^\.env$/m.test(dockerIgnore), "Docker images exclude service-account and .env files");

const handlers = fs.readFileSync("src/api/handlers.js", "utf8");
assert(/assertCanWriteChapter\(user, second\)/.test(handlers), "Weekly data writes are checked against the caller's chapters");
// Credentials live in the credential store (Netlify Blobs), not Firestore.
assert(/getMemberPinHash\(memberId\)/.test(handlers), "Login verifies PINs against the credential store");
assert(/await setMemberPinHash\(docId, await bcrypt\.hash/.test(handlers), "New member PINs are written to the credential store, not Firestore");
assert(!/member\.pinHash = await bcrypt\.hash/.test(handlers), "Member records no longer carry a pinHash into Firestore");
const credStore = fs.readFileSync("src/services/credentialStore.js", "utf8");
assert(/@netlify\/blobs/.test(credStore), "Credential store is backed by Netlify Blobs");
assert(/fileBackend/.test(credStore), "Credential store has a local fallback for development");
const netlifyFn = fs.readFileSync("netlify/functions/api.js", "utf8");
assert(/routeApi/.test(netlifyFn) && /routeApi/.test(fs.readFileSync("src/routes/api.js", "utf8")),
  "Express and Netlify share one route implementation");
assert(/function seniorMappedChapters/.test(html), "Senior DC chapters can be mapped from chapter ownership");
assert(/function ensureUserChapterScope/.test(html), "User chapter scope is refreshed from hierarchy");
assert(/chapters'\)\.orderBy\('order'\)\.onSnapshot[\s\S]*ensureUserChapterScope\(\)[\s\S]*popSelects\(\)/.test(html), "Chapter dropdowns refresh after hierarchy loads");
assert(/db\.collection\('weeklyData'\)\.doc\(ch\+'\_'\+date\)\.set\(entry\)/.test(html), "DC data entry writes to shared weeklyData");
assert(/S\.weeklyData=s\.docs\.map/.test(html), "Dashboards subscribe to shared weeklyData updates");

assert(/from = "\/api\/\*"/.test(netlifyToml), "Netlify redirects /api/* to function");
assert(/from = "\/config\.js"/.test(netlifyToml), "Netlify redirects /config.js to function");
assert(/from = "\/healthz"/.test(netlifyToml), "Netlify redirects /healthz to function");
assert(/publish = "dist"/.test(netlifyToml), "Netlify publish directory is dist");

assert(/FIREBASE_PROJECT_ID=bnipulse/.test(envText), "Local Firebase project id is configured");
assert(/FIREBASE_SERVICE_ACCOUNT_PATH=.+\.json/.test(envText) || /FIREBASE_SERVICE_ACCOUNT_BASE64=.+/.test(envText), "Local Firebase Admin credential is configured");
warn(/FIREBASE_SERVICE_ACCOUNT_PATH=.+\.json/.test(envText) && !/FIREBASE_SERVICE_ACCOUNT_BASE64=.+/.test(envText), "Production Netlify must use FIREBASE_SERVICE_ACCOUNT_BASE64, not local FIREBASE_SERVICE_ACCOUNT_PATH");

// NOTE: local-tlr-data.json and local-dues-data.json are import *sources*, read by
// the browser on localhost only. In production the app reads meta/tlr and meta/dues
// from Firestore. Passing these checks says the source files are well-formed; it
// does NOT say the data has been imported. Run the importers before go-live.
console.log("\nSource-file checks (these files are not read in production):");

if (tlr) {
  const rows = tlr.rows || [];
  assert(rows.length === 58, `Local TLR row count is 58, found ${rows.length}`);
  assert(rows.every((row) => row.name && row.score !== undefined && row.score !== ""), "Every TLR row has chapter name and score");
  assert(rows.every((row) => row.tyfcb !== "" && row.tyfcb !== undefined), "Every TLR row has TYFCB");
}

if (dues) {
  const members = dues.members || [];
  const months = countBy(members, (member) => String(member.dueDate || "").slice(0, 7));
  assert(members.length === 152, `Members Due count is 152, found ${members.length}`);
  assert(months["2026-08"] === 22, `Members Due Aug 2026 count is 22, found ${months["2026-08"] || 0}`);
  assert(months["2026-09"] === 130, `Members Due Sep 2026 count is 130, found ${months["2026-09"] || 0}`);
  assert(members.every((member) => member.chapter && member.name && member.dueDate), "Every dues member has chapter, name, and due date");
  assert(!members.some((member) => ["BNI Aegon", "BNI Antonius", "BNI Demetrius", "BNI Diomedes"].includes(member.chapter)), "Removed Nachiket team chapters are absent from dues data");
}

warnings.push("TLR and dues data must be present in Firestore (meta/tlr, meta/dues) - the local JSON files above are not served in production");

if (warnings.length) {
  console.log("\nWarnings:");
  warnings.forEach((item) => console.log(`WARN ${item}`));
}

if (failures.length) {
  console.error("\nFailures:");
  failures.forEach((item) => console.error(`FAIL ${item}`));
  process.exit(1);
}

console.log("\nGo-live smoke test passed.");
