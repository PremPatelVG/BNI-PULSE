// Loads the DC logins the barter scripts sign in as. Real PINs must never be
// committed - the repo is public - so they live in scripts/.barter-test-accounts.json,
// which .gitignore blocks. See .barter-test-accounts.example.json for the shape.
import { readFileSync } from "node:fs";

const FILE = new URL("./.barter-test-accounts.json", import.meta.url);

let accounts;
try {
  accounts = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  console.error(
    "Missing scripts/.barter-test-accounts.json\n" +
    "Copy scripts/.barter-test-accounts.example.json to that name and fill in the\n" +
    "real DC ids and PINs. The file is gitignored - never commit live PINs."
  );
  process.exit(1);
}

export function account(key) {
  const a = accounts[key];
  if (!a || !a.id || !a.pin) throw new Error(`No login for "${key}" in .barter-test-accounts.json`);
  return a;
}

// drop the "_comment" key the example file carries
export default Object.fromEntries(Object.entries(accounts).filter(([k]) => !k.startsWith("_")));
