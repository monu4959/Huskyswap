// Builds the LOCAL test database: supabase/schema.sql (the base, "0001") then
// supabase/migrations/*.sql in filename order, then gives the nlq_agent role the
// local login password from NLQ_DATABASE_URL (and nlq_agent_student the one from
// NLQ_STUDENT_DATABASE_URL, when set). Run it through the wrapper on a
// fresh stack (`supabase start`, or after `supabase db reset`):
//
//   npm run test:env -- node scripts/test-db-setup.mjs           schema only
//   npm run test:env -- node scripts/test-db-setup.mjs --seed    schema + data + index
//
// --seed then also loads the synthetic data (scripts/seed-supabase.mjs), runs ANALYZE
// (fresh bulk-loaded tables have no planner stats, and some of the agent's verified
// examples then hit nlq_admin's 5 s statement timeout), and builds the retrieval index
// (npm run rag:index).
//
// It only ever connects to 127.0.0.1/localhost, and it does nothing to the schema if it
// is already there (reset the stack to rebuild). See docs/TESTING.md.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function localUrl(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set. Run through scripts/test-env.mjs.`);
  const url = new URL(value);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`${key} is not local (${url.hostname}); refusing.`);
  return url;
}

const adminUrl = localUrl("DATABASE_URL");
const agentUrl = localUrl("NLQ_DATABASE_URL");

const db = new pg.Client({ connectionString: adminUrl.href });
await db.connect();
try {
  const { rows } = await db.query("select to_regclass('public.profiles') is not null as built");
  if (rows[0].built) {
    console.log("Schema already present; nothing to do. (Reset the stack to rebuild: see docs/TESTING.md.)");
  } else {
    const dir = join(ROOT, "supabase", "migrations");
    const files = [
      join(ROOT, "supabase", "schema.sql"),
      ...readdirSync(dir)
        .filter((f) => /^\d+_.*\.sql$/.test(f))
        .sort()
        .map((f) => join(dir, f)),
    ];
    for (const file of files) {
      const t = Date.now();
      await db.query("begin");
      try {
        await db.query(readFileSync(file, "utf8"));
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw new Error(`${file.slice(ROOT.length + 1)}: ${e.message}`);
      }
      console.log(`applied ${file.slice(ROOT.length + 1)} (${Date.now() - t} ms)`);
    }
  }

  // Local-only password for the agent login (the cloud one is set by hand, outside the repo)
  const password = decodeURIComponent(agentUrl.password);
  const user = decodeURIComponent(agentUrl.username);
  if (user !== "nlq_agent" || !password) throw new Error("NLQ_DATABASE_URL must log in as nlq_agent with a password");
  const { rows: lit } = await db.query("select quote_literal($1) as p", [password]);
  await db.query(`alter role nlq_agent login password ${lit[0].p}`);
  console.log("nlq_agent can log in locally");

  // The student-only login (migration 0011), when .env.test names it
  if (process.env.NLQ_STUDENT_DATABASE_URL) {
    const studentUrl = localUrl("NLQ_STUDENT_DATABASE_URL");
    const studentPassword = decodeURIComponent(studentUrl.password);
    if (decodeURIComponent(studentUrl.username) !== "nlq_agent_student" || !studentPassword) {
      throw new Error("NLQ_STUDENT_DATABASE_URL must log in as nlq_agent_student with a password");
    }
    const { rows: slit } = await db.query("select quote_literal($1) as p", [studentPassword]);
    await db.query(`alter role nlq_agent_student login password ${slit[0].p}`);
    console.log("nlq_agent_student can log in locally");
  }
} finally {
  await db.end();
}

if (process.argv.includes("--seed")) {
  const run = (cmd) => {
    console.log(`\n> ${cmd}`);
    const r = spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  run("node scripts/seed-supabase.mjs");
  const db2 = new pg.Client({ connectionString: adminUrl.href });
  await db2.connect();
  await db2.query("analyze");
  await db2.end();
  console.log("analyzed");
  run("npm run rag:index");
}
