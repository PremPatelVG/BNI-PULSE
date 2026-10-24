import { test } from "node:test";
import assert from "node:assert/strict";
import * as scope from "../../src/services/scope.js";

const ad = { role: "ad" }, ed = { role: "ed" }, viewer = { role: "viewer" };
const srdc = { role: "srdc", chapter: "Alpha", chapters: ["Alpha", "Gamma"] };
const dc = { role: "dc", chapter: "Alpha", chapters: ["Alpha"] };
const sa = { role: "sa1", chapter: "Beta" };            // chapters missing: chapter alone counts

test("role predicates", () => {
  assert.equal(scope.isAreaDirector(ad), true);
  assert.equal(scope.isAreaDirector(ed), true, "the ED has Area Director rights");
  assert.equal(scope.isAreaDirector(srdc), false);
  assert.equal(scope.isSeniorDirector(srdc), true);
  assert.equal(scope.isViewer(viewer), true);
  for (const r of ["dc", "cd", "sa1", "sa2"]) assert.equal(scope.isChapterRole({ role: r }), true, r);
  assert.equal(scope.isChapterRole(srdc), false);
  assert.equal(scope.isAdmin(ad) && scope.isAdmin(ed) && scope.isAdmin(srdc), true);
  assert.equal(scope.isAdmin(dc) || scope.isAdmin(viewer), false);
  assert.equal(scope.isAreaDirector(null), false);
});

test("scopedChapterNames: region-wide roles are unrestricted, others get their chapters", () => {
  assert.equal(scope.scopedChapterNames(ad), null);
  assert.equal(scope.scopedChapterNames(ed), null);
  assert.equal(scope.scopedChapterNames(viewer), null, "viewers read the whole region");
  assert.deepEqual(scope.scopedChapterNames(srdc).sort(), ["Alpha", "Gamma"]);
  assert.deepEqual(scope.scopedChapterNames(sa), ["Beta"]);
  assert.deepEqual(scope.scopedChapterNames({ role: "dc", chapter: "A", chapters: ["A", "A", "", "B"] }).sort(), ["A", "B"], "deduplicated, blanks dropped");
});

test("read / write rights per chapter", () => {
  assert.equal(scope.canReadChapter(dc, "Alpha"), true);
  assert.equal(scope.canReadChapter(dc, "Beta"), false);
  assert.equal(scope.canReadChapter(viewer, "Beta"), true);
  assert.equal(scope.canWriteChapter(viewer, "Alpha"), false, "viewers are read-only");
  assert.equal(scope.canWriteChapter(ad, "Anything"), true);
  assert.equal(scope.canWriteChapter(srdc, "Gamma"), true);
  assert.equal(scope.canWriteChapter(srdc, "Beta"), false);
  assert.equal(scope.canWriteChapter(sa, "Beta"), true);
  assert.equal(scope.canWriteChapter(null, "Alpha"), false);
  assert.equal(scope.canWrite(viewer), false);
  assert.equal(scope.canWrite(dc), true);
});

test("filterRowsToScope keeps in-scope and chapter-less rows", () => {
  const rows = [{ chapter: "Alpha" }, { chapter: "Beta" }, { chapter: "Gamma" }, { name: "no chapter" }];
  assert.equal(scope.filterRowsToScope(ad, rows).length, 4);
  assert.deepEqual(scope.filterRowsToScope(dc, rows).map(r => r.chapter || "none"), ["Alpha", "none"]);
  assert.deepEqual(scope.filterRowsToScope(srdc, rows).map(r => r.chapter || "none"), ["Alpha", "Gamma", "none"]);
});

test("assert helpers throw errors carrying an HTTP status", () => {
  assert.throws(() => scope.assertCanWriteChapter(dc, "Beta"), e => e.status === 403 && /Beta/.test(e.message));
  assert.doesNotThrow(() => scope.assertCanWriteChapter(dc, "Alpha"));
  assert.throws(() => scope.assertCanWrite(viewer), e => e.status === 403);
  assert.throws(() => scope.assertAdmin(dc), e => e.status === 403);
  assert.doesNotThrow(() => scope.assertAdmin(srdc));
  assert.equal(scope.badRequest("x").status, 400);
  assert.equal(scope.notFound().status, 404);
  assert.equal(scope.forbidden().message, "Insufficient permissions");
});
