// Loaded into every Node process started by scripts/test-env.mjs (via NODE_OPTIONS --require).
// Second line of defence after the wrapper's own checks:
//
//   1. Any read of the repo's .env.local (fs.readFileSync / readFile / fs.promises.readFile /
//      process.loadEnvFile) is served from .env.test instead, so a script that reads the file
//      directly, or a key that .env.test doesn't set (TEACHER_*, STUDENT_*, VERCEL_*), can never
//      pick up production values.
//   2. Refuses to start if a database URL or the Supabase URL in the environment is not local.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const PROD_FILES = new Set([".env.local", ".env.production.local", ".env.development.local"].map((f) => path.join(ROOT, f).toLowerCase()));
const TEST_FILE = path.join(ROOT, ".env.test");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

for (const [key, value] of Object.entries(process.env)) {
  if (!value || !(/DATABASE_URL$/.test(key) || /SUPABASE_URL$/.test(key))) continue;
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    host = "(unparseable)";
  }
  if (!LOCAL_HOSTS.has(host)) {
    process.stderr.write(`[test-env] refusing to run: ${key} points at a non-local host (${host}).\n`);
    process.exit(97);
  }
}

function redirect(p) {
  try {
    let s = p;
    if (s instanceof URL) s = fileURLToPath(s);
    else if (Buffer.isBuffer(s)) s = s.toString();
    if (typeof s !== "string") return p;
    if (s.startsWith("file:")) s = fileURLToPath(s);
    return PROD_FILES.has(path.resolve(s).toLowerCase()) ? TEST_FILE : p;
  } catch {
    return p;
  }
}

const { readFileSync, readFile } = fs;
fs.readFileSync = function (p, ...rest) {
  return readFileSync.call(this, redirect(p), ...rest);
};
fs.readFile = function (p, ...rest) {
  return readFile.call(this, redirect(p), ...rest);
};
const promisesReadFile = fs.promises.readFile;
fs.promises.readFile = function (p, ...rest) {
  return promisesReadFile.call(this, redirect(p), ...rest);
};
if (typeof process.loadEnvFile === "function") {
  const loadEnvFile = process.loadEnvFile;
  process.loadEnvFile = function (p, ...rest) {
    return loadEnvFile.call(this, p === undefined ? p : redirect(p), ...rest);
  };
}
// Make `import { readFileSync } from "node:fs"` in ES modules see the patched functions.
syncBuiltinESMExports();
