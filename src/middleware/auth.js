import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signSession(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      chapter: user.chapter || null,
      chapters: user.chapters || []
    },
    config.jwtSecret,
    { expiresIn: "12h" }
  );
}

export function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}
