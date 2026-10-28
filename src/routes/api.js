// Express adapter. All logic lives in ../api/handlers.js; this file only translates
// between Express request/response objects and the shared router.
import express from "express";
import { routeApi } from "../api/handlers.js";

const router = express.Router();

router.use(async (req, res, next) => {
  // API answers carry member data: never cached on the way (helmet already sends nosniff).
  res.set("Cache-Control", "no-store");
  try {
    const segments = req.path.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    const result = await routeApi({
      method: req.method,
      segments,
      body: req.body,
      authorization: req.get("authorization"),
      query: req.query,
      ip: req.ip || null
    });

    if (result.status === 204 || result.body === null) return res.status(result.status).end();
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});

export default router;
