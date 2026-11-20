# Testing

## Local test environment

Tests run against a **local Supabase stack in Docker**, never against the production
project. The 50+ students testing HuskySwap use production, so the rule is simple:

> **Tests never use `.env.local`.** Every test command goes through `scripts/test-env.mjs`
> (`npm run test:env -- <command>`), which loads `.env.test` and points everything at
> `127.0.0.1`.

### What the wrapper does

`node scripts/test-env.mjs <command> [args...]` (or `npm run test:env -- <command> [args...]`):

1. Loads `.env.test` (git-ignored) over the current environment.
2. Refuses to run (exit 2) unless every `*DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` is
   on `127.0.0.1`/`localhost`.
3. Sets `NEXT_DIST_DIR=.next-test`, so `next build` writes to `.next-test/` and never touches
   your normal `.next/` build (`distDir` in `next.config.ts`).
4. Adds `--require scripts/test-env-preload.cjs` to `NODE_OPTIONS`. In every Node process it
   starts (scripts, `next build`, `next start`), any read of `.env.local` is served from
   `.env.test` instead, and the process exits (97) if a database or Supabase URL is not local.
   So keys that exist only in `.env.local` (`TEACHER_*`, `STUDENT_*`, `VERCEL_*`) never leak
   into a test run either.

Values already in the environment win over `.env.local` both for `process.loadEnvFile()` (used
by the scripts) and for Next.js's own env loading (server code and `NEXT_PUBLIC_*` inlining).
`test-rls.mjs`, `smoke-client.mjs` and `sql.mjs` used to read `.env.local` directly; they now
prefer the environment too.

### Ports

| Service                         | Address                                                  |
| ------------------------------- | -------------------------------------------------------- |
| Supabase API (Kong: auth, REST, realtime, storage) | `http://127.0.0.1:54321`              |
| Postgres                        | `127.0.0.1:54322` (user `postgres`, password `postgres`) |
| Test app (`next start`)         | `http://localhost:3100`                                  |

Port 3000 is left for your own `next dev`. Studio, analytics, mail, edge functions, imgproxy
and postgres-meta are switched off to save RAM (`supabase/config.toml`, project id
`huskyswap-test`). Auth rate limits are raised there so e2e and load tests aren't throttled.

### First-time setup / full reset

The Supabase CLI is run with `npx`, pinned (nothing is added to `package.json`):

```bash
SB="npx --yes supabase@2.122.1"

$SB start -x imgproxy,postgres-meta,studio,mailpit,logflare,vector,edge-runtime,supavisor
$SB status -o env          # API URL and the local publishable (anon) key for .env.test
```

`.env.test` (create it once; it is git-ignored):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY / PUBLISHABLE_KEY from `supabase status`>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable
NLQ_DATABASE_URL=postgresql://nlq_agent:<any local password>@127.0.0.1:54322/postgres?sslmode=disable
NLQ_STUDENT_DATABASE_URL=postgresql://nlq_agent_student:<another local password>@127.0.0.1:54322/postgres?sslmode=disable
DEMO_LOGIN=true
NEXT_PUBLIC_DEMO_LOGIN=true
```

`sslmode=disable` matters: local Postgres has no SSL, and the scripts and the app ask for it.

Build the schema, seed, and index in one go (about 35 s):

```bash
npm run test:env -- node scripts/test-db-setup.mjs --seed
```

That runs, in order: `supabase/schema.sql`, `supabase/migrations/*.sql` (filename order), the
local `nlq_agent` and `nlq_agent_student` login passwords (taken from `NLQ_DATABASE_URL` and `NLQ_STUDENT_DATABASE_URL`), `scripts/seed-supabase.mjs`,
`ANALYZE`, and `npm run rag:index`. Without `--seed` it does only the schema and password. If the
schema is already there it skips straight to the password (and the data steps, with `--seed`).

`supabase start` does **not** apply `supabase/migrations/*` itself (`[db.migrations]
enabled = false`): the base schema lives in `supabase/schema.sql`, which is not a migration
file, so the CLI would try to run `0002_…` against an empty database.

`ANALYZE` matters: right after a bulk seed the planner has no statistics, and some of the
agent's verified examples then hit `nlq_admin`'s 5 s statement timeout, which fails
`rag:index`. If you seed by hand (`npm run test:env -- npm run seed`), wait for autovacuum or
run `ANALYZE` before `rag:index`.

To wipe the database back to an empty Supabase and rebuild (about 1.5 min):

```bash
npx --yes supabase@2.122.1 db reset --local
npm run test:env -- node scripts/test-db-setup.mjs --seed
```

### Day to day

```bash
npx --yes supabase@2.122.1 start -x imgproxy,postgres-meta,studio,mailpit,logflare,vector,edge-runtime,supavisor
npx --yes supabase@2.122.1 stop          # keeps the data (Docker volumes)
npx --yes supabase@2.122.1 stop --no-backup   # throws the data away

# checks (no model calls)
npm run test:env -- npm run test:rls
npm run test:env -- node scripts/smoke-client.mjs
npm run test:env -- npm run test:agent-guard
npm run test:env -- npm run test:retrieval

# rogue-model red team: a compromised-LLM stub (scripts/llm-adversary.mjs) runs 113 attacks
# (scripts/redteam-attacks.mjs) as students and as admins through POST /api/ask, plus cache
# scenarios, and fails on any canary, victim id or contact detail in the response. Starts
# `next start -p 3101` itself (from .next-test, so build first) unless something already
# answers there, and stops it afterwards. About 15 minutes (per-user rate limits).
npm run test:env -- npm run test:redteam

# the app on :3100, built into .next-test/
npm run test:env -- npx next build
npm run test:env -- npx next start -p 3100
```

`next build` under the wrapper still prints `Environments: .env.local`; what it actually read is
`.env.test` (the preload). Check with `grep -r 127.0.0.1:54321 .next-test/static`. The first
test build added `.next-test/types/**/*.ts` and `.next-test/dev/types/**/*.ts` to `tsconfig.json`
(Next does this for any `distDir`); keep those lines, or Next re-adds them on every test build.

Stop the test app: find the PID with `netstat -ano | findstr :3100` and `taskkill /PID <pid> /T /F`.

Never `supabase link` this folder: the local stack has nothing to do with the production
project, and no command here needs it.
