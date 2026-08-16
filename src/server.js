import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { config, requireProductionSecrets } from "./config.js";
import apiRoutes from "./routes/api.js";

requireProductionSecrets();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const app = express();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: config.corsOrigin ? config.corsOrigin.split(",").map(origin => origin.trim()) : true,
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
