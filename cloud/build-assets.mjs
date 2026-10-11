// Assembles cloud/public from host/, guest/ (served at /play) and shared/. Never copies ROM or test files.
import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "cloud", "public");
const SKIP = new Set([".z64", ".n64", ".v64", ".o2r", ".otr", ".md"]);
rmSync(out, { recursive: true, force: true });
for (const [from, to] of [["host", "host"], ["guest", "play"], ["shared", "shared"]]) {
  mkdirSync(join(out, to), { recursive: true });
  for (const name of readdirSync(join(root, from))) {
    if (SKIP.has(extname(name).toLowerCase()) || name.endsWith(".test.js")) continue;
    cpSync(join(root, from, name), join(out, to, name), { recursive: true });
  }
}
console.log(`cloud/public ready`);
