import bcrypt from "bcryptjs";
import express from "express";
import { getDb } from "../firebaseAdmin.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  docToData,
  getMetaDoc,
  listCollection,
  setMetaDoc,
  stripPrivateMember,
  writeActivity
} from "../services/firestore.js";

const router = express.Router();

router.use(requireAuth);

router.get("/bootstrap", async (req, res, next) => {
  try {
    const [chapters, members, weeklyData, visitorPipeline, miyagiMembers] = await Promise.all([
      listCollection("chapters", { field: "order" }),
      listCollection("members"),
      listCollection("weeklyData", { field: "date", direction: "desc" }),
      listCollection("visitorPipeline"),
      listCollection("miyagiMembers")
    ]);

    const metaIds = ["branding", "chapterGoals", "config", "dues", "lengthOfMembership", "monthlyTargets", "tlr"];
    const metaEntries = await Promise.all(metaIds.map(async id => [id, await getMetaDoc(id)]));

    res.json({
      chapters,
      members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })),
      weeklyData,
      visitorPipeline,
      miyagiMembers,
      meta: Object.fromEntries(metaEntries)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/chapters", async (req, res, next) => {
  try {
    res.json({ chapters: await listCollection("chapters", { field: "order" }) });
  } catch (error) {
    next(error);
  }
});

router.post("/chapters", requireRole("srdc"), async (req, res, next) => {
  try {
    const data = req.body || {};
    if (!data.name) return res.status(400).json({ error: "Chapter name is required" });
    await getDb().collection("chapters").doc(data.id || data.name).set(data, { merge: Boolean(data.id) });
    await writeActivity(req.user, "chapter_saved", { chapterName: data.name });
    res.status(201).json({ chapter: data });
  } catch (error) {
    next(error);
  }
});

router.get("/members", async (req, res, next) => {
  try {
    const members = await listCollection("members");
    res.json({ members: members.map(member => ({ id: member.id, ...stripPrivateMember(member) })) });
  } catch (error) {
    next(error);
  }
});

router.post("/members", requireRole("srdc"), async (req, res, next) => {
  try {
    const { id, pin, ...member } = req.body || {};
    if (!member.name) return res.status(400).json({ error: "Member name is required" });
    if (pin) member.pinHash = await bcrypt.hash(pin, 12);
    const docId = id || `m${Date.now()}`;
    await getDb().collection("members").doc(docId).set(member, { merge: Boolean(id) });
    await writeActivity(req.user, "member_saved", { memberName: member.name });
    res.status(201).json({ member: { id: docId, ...stripPrivateMember(member) } });
  } catch (error) {
    next(error);
  }
});

router.delete("/members/:id", requireRole("srdc"), async (req, res, next) => {
  try {
    await getDb().collection("members").doc(req.params.id).delete();
    await writeActivity(req.user, "member_deleted", { memberId: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/weekly-data", async (req, res, next) => {
  try {
    res.json({ weeklyData: await listCollection("weeklyData", { field: "date", direction: "desc" }) });
  } catch (error) {
    next(error);
  }
});

router.put("/weekly-data/:chapter/:date", async (req, res, next) => {
  try {
    const id = `${req.params.chapter}_${req.params.date}`;
    const entry = {
      ...req.body,
      chapter: req.params.chapter,
      date: req.params.date,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.sub
    };
    await getDb().collection("weeklyData").doc(id).set(entry, { merge: true });
    await writeActivity(req.user, "weekly_entry_saved", { chapter: req.params.chapter, date: req.params.date });
    res.json({ entry: { id, ...entry } });
  } catch (error) {
    next(error);
  }
});

router.delete("/weekly-data/:chapter/:date", async (req, res, next) => {
  try {
    await getDb().collection("weeklyData").doc(`${req.params.chapter}_${req.params.date}`).delete();
    await writeActivity(req.user, "weekly_entry_deleted", { chapter: req.params.chapter, date: req.params.date });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/meta/:docId", async (req, res, next) => {
  try {
    res.json({ meta: await getMetaDoc(req.params.docId) });
  } catch (error) {
    next(error);
  }
});

router.put("/meta/:docId", requireRole("srdc"), async (req, res, next) => {
  try {
    const meta = await setMetaDoc(req.params.docId, req.body || {}, true);
    await writeActivity(req.user, "meta_saved", { docId: req.params.docId });
    res.json({ meta });
  } catch (error) {
    next(error);
  }
});

router.get("/:collection", async (req, res, next) => {
  try {
    const allowed = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers", "activityLog"]);
    if (!allowed.has(req.params.collection)) return res.status(404).json({ error: "Unknown collection" });
    const rows = await listCollection(req.params.collection);
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.put("/:collection/:id", async (req, res, next) => {
  try {
    const allowed = new Set(["attendance", "renewalsDone", "visitorPipeline", "miyagiMembers"]);
    if (!allowed.has(req.params.collection)) return res.status(404).json({ error: "Unknown collection" });
    await getDb().collection(req.params.collection).doc(req.params.id).set(req.body || {}, { merge: true });
    const doc = await getDb().collection(req.params.collection).doc(req.params.id).get();
    await writeActivity(req.user, `${req.params.collection}_saved`, { id: req.params.id });
    res.json({ row: docToData(doc) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:collection/:id", async (req, res, next) => {
  try {
    const allowed = new Set(["visitorPipeline", "miyagiMembers"]);
    if (!allowed.has(req.params.collection)) return res.status(404).json({ error: "Unknown collection" });
    await getDb().collection(req.params.collection).doc(req.params.id).delete();
    await writeActivity(req.user, `${req.params.collection}_deleted`, { id: req.params.id });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
