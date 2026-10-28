import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { config, requireProductionSecrets } from "./config.js";
import apiRoutes from "./routes/api.js";
import { CSP_DIRECTIVES, PERMISSIONS_POLICY, REFERRER_POLICY } from "./securityHeaders.js";

requireProductionSecrets();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const app = express();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
  frameguard: { action: "deny" },
  referrerPolicy: { policy: REFERRER_POLICY }
}));
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  next();
});
// The dashboard calls its own server, so no other site needs to. Without CORS_ORIGIN
// set, cross-site requests get no CORS headers (it used to allow any site).
app.use(cors({
  origin: config.corsOrigin ? config.corsOrigin.split(",").map(origin => origin.trim()) : false,
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(morgan(config.env === "production" ? "combined" : "dev"));

app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "bni-chapter-pulse", environment: config.env });
});

app.get("/config.js", (req, res) => {
  res.type("application/javascript").send(
    `window.__BNI_PULSE_CONFIG__=${JSON.stringify({ firebase: config.publicFirebase })};`
  );
});

app.use("/api", apiRoutes);

// Serve only the files the browser actually needs. The repository root holds
// service-account credentials, .env, server logs and application source, so it must
// never be handed to express.static wholesale.
const staticOptions = { dotfiles: "deny", index: false, redirect: false };
app.get("/", (req, res) => res.sendFile(path.join(rootDir, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(rootDir, "index.html")));
app.use("/vendor", express.static(path.join(rootDir, "vendor"), staticOptions));

if (config.env !== "production") {
  app.get(["/local-dues-data.json", "/local-tlr-data.json"], (req, res) => {
    res.sendFile(path.join(rootDir, req.path.slice(1)));
  });
}

// Single-page app fallback. Anything that is not an API route or a known asset
// renders the dashboard rather than exposing a file from disk.
app.get("*", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`BNI CHAPTER PULSE listening on port ${config.port}`);
});
