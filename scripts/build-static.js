import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

fs.copyFileSync(path.join(rootDir, "index.html"), path.join(distDir, "index.html"));

// local-tlr-data.json / local-dues-data.json are deliberately NOT copied. The
// browser only fetches them on localhost (see isLocalTlrMode); in production the
// app reads meta/tlr and meta/dues through the API, so shipping them would publish
// membership data to a public URL for no benefit.

const vendorDir = path.join(rootDir, "vendor");
if (fs.existsSync(vendorDir)) {
  fs.cpSync(vendorDir, path.join(distDir, "vendor"), { recursive: true });
}

console.log(`Built static frontend in ${distDir}`);
