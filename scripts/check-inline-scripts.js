import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean);

scripts.forEach((script, index) => {
  new vm.Script(script, { filename: `index-inline-script-${index}.js` });
});

console.log(`Checked ${scripts.length} inline script${scripts.length === 1 ? "" : "s"}`);
