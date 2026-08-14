import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

fs.copyFileSync(path.join(rootDir, "index.html"), path.join(distDir, "index.html"));

const localTlrPath = path.join(rootDir, "local-tlr-data.json");
if (fs.existsSync(localTlrPath)) {
  fs.copyFileSync(localTlrPath, path.join(distDir, "local-tlr-data.json"));
}

const vendorDir = path.join(rootDir, "vendor");
if (fs.existsSync(vendorDir)) {
  fs.cpSync(vendorDir, path.join(distDir, "vendor"), { recursive: true });
}

console.log(`Built static frontend in ${distDir}`);
