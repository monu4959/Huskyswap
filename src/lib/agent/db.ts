// Runs model-written SQL. This is the only code that executes it, and it always
// goes through the guard first.
//
// Never the admin login. Student questions connect as nlq_agent_student
// (NLQ_STUDENT_DATABASE_URL), a login that can only become nlq_student, so even a
// query that slipped past the guard could not switch to nlq_admin; admin questions
// connect as nlq_agent (NLQ_DATABASE_URL). Without NLQ_STUDENT_DATABASE_URL students
// fall back to nlq_agent (logged once). Each query runs in its own read-only
// transaction as nlq_student or nlq_admin, with a timeout and a row cap, and is
// rolled back. Database error messages are scrubbed like results: they can quote
// row values (invalid input syntax for type boolean: "...").

import pg from "pg";
import { checkSql } from "./guard.ts";
import { scrubRow, scrubText } from "./privacy.ts";
import type { DbRole, SqlResult } from "./types.ts";

const ROLES = new Set<DbRole>(["nlq_student", "nlq_admin"]);
const TIMEOUT_MS: Record<DbRole, number> = { nlq_student: 3000, nlq_admin: 5000 };
export const MAX_ROWS = 200;

// Keep dates, timestamps and intervals as Postgres prints them (no JS Date / time zone shifts)
const RAW_TYPES = new Set([1082, 1083, 1114, 1184, 1186]);
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    RAW_TYPES.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

// Small and quick to give up: many serverless instances share the database's
// connection budget. Everything per query is SET LOCAL / set_config(..., true)
// inside its transaction, so this works through the transaction pooler (6543).
const pools = new Map<DbRole, pg.Pool>();
let warnedFallback = false;

// The login for a role: nlq_agent_student for students when configured, else nlq_agent
export function connectionStringFor(role: DbRole, env: Record<string, string | undefined> = process.env) {
  const agent = env.NLQ_DATABASE_URL;
  if (role === "nlq_student" && env.NLQ_STUDENT_DATABASE_URL) return env.NLQ_STUDENT_DATABASE_URL;
  if (!agent) throw new Error("Missing NLQ_DATABASE_URL (the nlq_agent login) in .env.local");
  if (role === "nlq_student" && !warnedFallback) {
    warnedFallback = true;
    console.warn("NLQ_STUDENT_DATABASE_URL is not set: student questions use the nlq_agent login (which can also become nlq_admin). Set it to the nlq_agent_student login.");
  }
  return agent;
}

function getPool(role: DbRole) {
  let pool = pools.get(role);
  if (!pool) {
    const connectionString = connectionStringFor(role);
    pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, types });
    // An idle connection dropped by the pooler must not crash the process; the pool replaces it
    pool.on("error", () => {});
    // Nor one dropped mid-query: the query fails and runSelect discards the connection
    pool.on("connect", (client) => client.on("error", () => {}));
    pools.set(role, pool);
  }
  return pool;
}

// Connections through the Supabase pooler occasionally reset while opening; try twice
async function connect(role: DbRole) {
  try {
    return await getPool(role).connect();
  } catch {
    return await getPool(role).connect();
  }
}

export async function closePool() {
  const all = [...new Set(pools.values())];
  pools.clear();
  await Promise.all(all.map((p) => p.end()));
}

// userId: the signed-in student, from the verified session (never from the model).
// The my_* views show only that student's rows; without it they are empty.
export async function runSelect(
  sql: string,
  role: DbRole,
  params: unknown[] = [],
  { userId = null }: { userId?: string | null } = {},
): Promise<SqlResult> {
  if (!ROLES.has(role)) return { ok: false, error: `Unknown role ${role}` };
  const checked = await checkSql(sql, role);
  if (!checked.ok) return checked;

  let client: pg.PoolClient;
  try {
    client = await connect(role);
  } catch (e) {
    return { ok: false, error: `Database connection failed (${(e as Error).message}). Try again.` };
  }
  let broken: Error | undefined;
  try {
    await client.query("begin read only");
    await client.query(`set local role ${role}`);
    await client.query(`set local statement_timeout = ${TIMEOUT_MS[role]}`);
    // Who is asking, for the my_* views. Being a query, this also locks the
    // transaction read-only: after it, SET TRANSACTION READ WRITE is refused.
    await client.query("select set_config('app.user_id', $1, true)", [userId ?? ""]);
    // Extended protocol rejects multiple statements; the newline keeps a trailing -- comment from eating the wrapper
    // (queryMode is supported by pg 8.23 but missing from @types/pg)
    const result = await client.query<Record<string, unknown>>({
      text: `select * from (\n${checked.sql}\n) as q limit ${MAX_ROWS + 1}`,
      values: params,
      queryMode: "extended",
    } as pg.QueryConfig);
    const truncated = result.rows.length > MAX_ROWS;
    const rows = (truncated ? result.rows.slice(0, MAX_ROWS) : result.rows).map(scrubRow);
    return { ok: true, columns: result.fields.map((f) => f.name), rows, rowCount: rows.length, truncated };
  } catch (e) {
    const err = e as Error & { hint?: string };
    if (!(err instanceof pg.DatabaseError)) broken = err; // connection problem, not a SQL error
    return { ok: false, error: scrubText(err.message + (err.hint ? ` Hint: ${err.hint}` : "")) };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release(broken);
  }
}
