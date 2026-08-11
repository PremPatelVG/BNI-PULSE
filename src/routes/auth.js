import bcrypt from "bcryptjs";
import express from "express";
import { config } from "../config.js";
import { getDb } from "../firebaseAdmin.js";
import { requireAuth, signSession } from "../middleware/auth.js";

const router = express.Router();

function publicUser(id, data) {
  return {
    id,
    name: data.name,
    role: data.role,
    chapter: data.chapter || null,
    chapters: data.chapters || []
  };
}

async function pinMatches(member, pin) {
  if (member.pinHash) return bcrypt.compare(pin, member.pinHash);
  return member.pin && member.pin === pin;
}

router.post("/login", async (req, res, next) => {
  try {
    const { memberId, pin } = req.body || {};
    if (!memberId || !pin) {
      return res.status(400).json({ error: "memberId and pin are required" });
    }

    const db = getDb();

    if (memberId === "__srdc__") {
      const cfg = await db.collection("meta").doc("config").get();
      const srPin = cfg.exists ? cfg.data().srPin : "";
      const fallback = config.srAdminPin;
      if (!srPin && !fallback) {
        return res.status(503).json({ error: "Sr. DC login is not configured" });
      }
      if (pin !== srPin && pin !== fallback) {
        return res.status(401).json({ error: "Incorrect PIN" });
      }

      const user = { id: "__srdc__", name: "Dinesh Sitlani", role: "srdc", chapter: null, chapters: [] };
      return res.json({ token: signSession(user), user });
    }

    const doc = await db.collection("members").doc(memberId).get();
    if (!doc.exists || !(await pinMatches(doc.data(), pin))) {
      return res.status(401).json({ error: "Incorrect PIN" });
    }

    const user = publicUser(doc.id, doc.data());
    return res.json({ token: signSession(user), user });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
