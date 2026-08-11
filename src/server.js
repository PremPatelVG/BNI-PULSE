import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { config, requireProductionSecrets } from "./config.js";
import authRoutes from "./routes/auth.js";
import dataRoutes from "./routes/data.js";

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
  res.json({ ok: true, service: "bni-pulse", environment: config.env });
});

app.get("/config.js", (req, res) => {
  res.type("application/javascript").send(
    `window.__BNI_PULSE_CONFIG__=${JSON.stringify({ firebase: config.publicFirebase })};`
  );
});

app.use("/api/auth", authRoutes);
app.use("/api", dataRoutes);
app.use(express.static(rootDir, { extensions: ["html"] }));

app.get("*", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`BNI Pulse listening on port ${config.port}`);
});
