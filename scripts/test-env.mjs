// Run any command against the LOCAL Supabase test stack, never production.
//
//   node scripts/test-env.mjs <command> [args...]
//   npm run test:env -- npm run test:rls
//   npm run test:env -- npx next build
//
// 1. Loads .env.test (git-ignored) over the current environment.
// 2. Refuses to run (exit 2) unless every *DATABASE_URL and NEXT_PUBLIC_SUPABASE_URL points at
//    127.0.0.1 / localhost.
// 3. Sets NEXT_DIST_DIR=.next-test so a test build never touches the normal .next build.
// 4. Preloads scripts/test-env-preload.cjs into every Node process (NODE_OPTIONS), which serves
//    .env.test whenever anything tries to read .env.local. Scripts and Next.js only fill in
//    keys that are missing from the environment, but this also stops production-only keys
//    (TEACHER_*, STUDENT_*, ...) from leaking in.
// See docs/TESTING.md.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.test");
const PRELOAD = join(ROOT, "scripts", "test-env-preload.cjs");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REQUIRED = ["DATABASE_URL", "NLQ_DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

const die = (msg) => {
  console.error(`[test-env] ${msg}`);
  process.exit(2);
};

const command = process.argv.slice(2);
if (!command.length) die("usage: node scripts/test-env.mjs <command> [args...]");
if (!existsSync(ENV_FILE)) die(".env.test not found. See docs/TESTING.md (Local test environment).");

const fileEnv = parseEnv(readFileSync(ENV_FILE, "utf8"));
const env = { ...process.env, ...fileEnv, NEXT_DIST_DIR: ".next-test" };

for (const key of REQUIRED) if (!env[key]) die(`${key} is missing from .env.test`);
for (const [key, value] of Object.entries(env)) {
  if (!value || !(/DATABASE_URL$/.test(key) || /SUPABASE_URL$/.test(key))) continue;
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    die(`${key} is not a valid URL`);
  }
  if (!LOCAL_HOSTS.has(host)) die(`refusing to run: ${key} points at ${host}, not 127.0.0.1/localhost`);
}

// NODE_OPTIONS treats backslashes inside quotes as escapes, so use forward slashes
env.NODE_OPTIONS = [`--require "${PRELOAD.replace(/\\/g, "/")}"`, env.NODE_OPTIONS].filter(Boolean).join(" ");

// One command string (shell: true), each argument quoted when it needs it, so it works in cmd.exe and sh
const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const child = spawn(command.map(quote).join(" "), { cwd: process.cwd(), env, stdio: "inherit", shell: true });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => die(`could not start: ${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
