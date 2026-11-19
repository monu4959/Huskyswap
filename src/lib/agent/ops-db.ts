// Admin connection (DATABASE_URL) for the agent's own bookkeeping: the run log,
// the retrieval index and the semantic cache, all in the ops schema. Only
// fixed, parameterized queries run here; model-written SQL never does (that
// goes through db.ts as nlq_agent).

import pg from "pg";

let pool: pg.Pool | null = null;

// Small and quick to give up: many serverless instances share the database's
// connection budget. No session state is used (only single statements and
// transaction-scoped locks), so this works through the transaction pooler (6543).
export function opsPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL in .env.local");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000 });
    pool.on("error", () => {}); // idle connection dropped by the pooler; the pool replaces it
  }
  return pool;
}

export async function closeOpsPool() {
  await pool?.end();
  pool = null;
}
