// Every region TLR uploaded is kept in meta/tlrHistory, one row per chapter per month.
// Past months can be uploaded in any order: a chapter's current TLR (meta/tlr) only ever
// moves to the same or a later month. Made-up chapters and figures (tests/helpers/region).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "../helpers/fake-firestore.mjs";
import { seedRegion, users, call } from "../helpers/region.mjs";
import { TLR_HISTORY_MONTHS } from "../../src/services/firestore.js";

beforeEach(seedRegion);

const upload = (user, monthIso, rows) => call(user, "POST", "tlr-upload", { monthIso, monthLabel: monthIso, rows });
const row = (name, size, score, retention) => ({ name, chapterSize: String(size), score: String(score), retention: String(retention) });
const history = () => fake.read("meta", "tlrHistory");
const current = () => fake.read("meta", "tlr");

test("another region's TLR upload changes nothing of this region's: rows, header or weekly entries", async () => {
  // Ahmedabad's TLR as it is live today: rows saved before they carried their month.
  const ahmedabadTlr = { reportMonth: "2026-11", monthLabel: "November 2026", uploadedAt: "2026-11-05", uploadedBy: "Arun Area",
    rows: [row("Alpha", 30, 80, 75), row("Beta", 20, 60, 65), row("Gamma", 25, 70, 72)] };
  fake.seed("meta", "tlr", ahmedabadTlr);
  // A made-up closed chapter's name ("Alphas") partly matches Ahmedabad's Alpha.
  fake.seed("weeklyData", "Alpha_2026-04-07", { chapter: "Alpha", date: "2026-04-07", tlr: 65, conversionPct: 12 });
  fake.seed("weeklyData", "Gamma_2026-11-04", { chapter: "Gamma", date: "2026-11-04", tlr: 70, conversionPct: 20 });
  fake.seed("chapters", "Kappa", { name: "Kappa", day: "Tuesday", order: 10, area: "north-gujarat" });
  const before = { tlr: structuredClone(fake.read("meta", "tlr")), alpha: fake.read("weeklyData", "Alpha_2026-04-07"), gamma: fake.read("weeklyData", "Gamma_2026-11-04") };

  assert.equal((await upload(users.ed, "2026-04", [row("Kappa", 40, 45, 0), row("Alphas", 16, 15, 48)])).status, 200);
  assert.equal((await upload(users.ed, "2026-11", [row("Kappa", 43, 80, 78)])).status, 200);

  assert.deepEqual(current(), before.tlr, "Ahmedabad's TLR record exactly as it was - rows and header");
  assert.equal(history(), undefined, "no Ahmedabad history record created");
  // North Gujarat's rows go to its own records; the closed chapter's row goes with the
  // report's region (the one region of the dashboard chapters in it).
  const north = fake.read("meta", "tlr-north-gujarat");
  assert.deepEqual(north.rows.map(r => [r.name, r.monthIso]).sort(), [["Alphas", "2026-04"], ["Kappa", "2026-11"]]);
  assert.deepEqual(fake.read("meta", "tlrHistory-north-gujarat").rows.map(r => r.name).sort(), ["Alphas", "Kappa", "Kappa"]);
  assert.deepEqual(fake.read("weeklyData", "Alpha_2026-04-07"), before.alpha, "no partial-name match into another chapter's weekly entries");
  assert.deepEqual(fake.read("weeklyData", "Gamma_2026-11-04"), before.gamma);
  // The page still reads one TLR list: Ahmedabad's rows first, then North Gujarat's.
  const merged = (await call(users.ed, "GET", "meta/tlr")).body.meta.rows.map(r => r.name);
  assert.deepEqual(merged.slice(0, 3), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(merged.slice(3).sort(), ["Alphas", "Kappa"]);
});

test("every TLR month is kept; an older month never replaces a newer current TLR", async () => {
  await upload(users.ad, "2026-11", [row("Alpha", 30, 80, 75), row("Beta", 20, 60, 65)]);
  const sep = await upload(users.ad, "2026-09", [row("Alpha", 28, 50, 70), row("Beta", 18, 40, 55)]);
  assert.equal(sep.status, 200);
  assert.equal(sep.body.chaptersUpdated, 2);
  assert.equal(sep.body.currentUpdated, 0, "September is older than what is loaded");
  assert.equal(current().reportMonth, "2026-11");
  assert.deepEqual(current().rows.map(r => [r.name, r.score, r.monthIso]).sort(), [["Alpha", "80", "2026-11"], ["Beta", "60", "2026-11"]]);
  assert.deepEqual(history().months, ["2026-09", "2026-11"]);
  assert.equal(history().rows.length, 4);

  // A later month for one chapter moves only that chapter on.
  const dec = await upload(users.ad, "2026-12", [row("Alpha", 31, 85, 76)]);
  assert.equal(dec.body.currentUpdated, 1);
  assert.equal(current().reportMonth, "2026-12");
  assert.deepEqual(current().rows.map(r => [r.name, r.monthIso]).sort(), [["Alpha", "2026-12"], ["Beta", "2026-11"]]);

  // Uploading a month again replaces that month's rows for the chapters in the file.
  await upload(users.ad, "2026-11", [row("Alpha", 29, 82, 74)]);
  const nov = history().rows.filter(r => r.monthIso === "2026-11");
  assert.deepEqual(nov.map(r => [r.name, r.score]).sort(), [["Alpha", "82"], ["Beta", "60"]]);
  assert.equal(current().rows.find(r => r.name === "Alpha").monthIso, "2026-12", "the current TLR stays on December");
});

test("a TLR loaded before rows carried their month counts as the document's month", async () => {
  fake.seed("meta", "tlr", { rows: [{ name: "Alpha", score: "70" }], reportMonth: "2026-10" });
  await upload(users.ad, "2026-09", [row("Alpha", 28, 50, 70)]);
  assert.equal(current().rows[0].score, "70", "October stays");
  await upload(users.ad, "2026-10", [row("Alpha", 29, 72, 71)]);
  assert.equal(current().rows[0].score, "72", "the same month replaces it");
});

test(`the history keeps the last ${TLR_HISTORY_MONTHS} months`, async () => {
  const months = [];
  for (let i = 0; i < TLR_HISTORY_MONTHS + 2; i++) {
    const d = new Date(Date.UTC(2024, i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  for (const m of months) await upload(users.ad, m, [row("Alpha", 30, 70, 70)]);
  assert.equal(history().months.length, TLR_HISTORY_MONTHS);
  assert.equal(history().months[0], months[2], "the two oldest months are dropped");
  assert.equal(history().rows.length, TLR_HISTORY_MONTHS);
});

test("the history is scoped like the TLR: a Senior Director adds and sees only their chapters", async () => {
  await upload(users.srdc, "2026-10", [row("Alpha", 30, 80, 75), row("Beta", 20, 60, 65)]);
  assert.deepEqual(history().rows.map(r => r.name), ["Alpha"], "Beta is not a chapter of this Senior Director");
  await upload(users.ad, "2026-10", [row("Beta", 20, 60, 65), row("Gamma", 25, 55, 60)]);
  const seen = async u => (await call(u, "GET", "snapshot")).body.meta.tlrHistory.rows.map(r => r.name).sort();
  assert.deepEqual(await seen(users.ed), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(await seen(users.srdc), ["Alpha", "Gamma"]);
  assert.deepEqual(await seen(users.dcAlpha), ["Alpha"]);
  assert.equal((await call(users.dcAlpha, "GET", "meta/tlrHistory")).body.meta.rows.length, 1);
  assert.equal((await call(users.ad, "PUT", "meta/tlrHistory", { rows: [] })).status, 403, "an Area Director cannot replace the history shared by every region");
});
