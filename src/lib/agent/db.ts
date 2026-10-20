// Runs model-written SQL. This is the only code that executes it, and it always
// goes through the guard first.
//
// Connects as nlq_agent (NLQ_DATABASE_URL), never the admin login. Each query
// runs in its own read-only transaction as nlq_student or nlq_admin, with a
// timeout and a row cap, and is rolled back.

import pg from "pg";
import { checkSql } from "./guard.ts";
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

let pool: pg.Pool | null = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.NLQ_DATABASE_URL;
    if (!connectionString) throw new Error("Missing NLQ_DATABASE_URL (the nlq_agent login) in .env.local");
    pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10_000, types });
    // An idle connection dropped by the pooler must not crash the process; the pool replaces it
    pool.on("error", () => {});
  }
  return pool;
}

// Connections through the Supabase pooler occasionally reset while opening; try twice
async function connect() {
  try {
    return await getPool().connect();
  } catch {
    return await getPool().connect();
  }
}

export async function closePool() {
  await pool?.end();
  pool = null;
}

export async function runSelect(sql: string, role: DbRole, params: unknown[] = []): Promise<SqlResult> {
  if (!ROLES.has(role)) return { ok: false, error: `Unknown role ${role}` };
  const checked = await checkSql(sql, role);
  if (!checked.ok) return checked;

  let client: pg.PoolClient;
  try {
    client = await connect();
  } catch (e) {
    return { ok: false, error: `Database connection failed (${(e as Error).message}). Try again.` };
  }
  let broken: Error | undefined;
  try {
    await client.query("begin read only");
    await client.query(`set local role ${role}`);
    await client.query(`set local statement_timeout = ${TIMEOUT_MS[role]}`);
    // A query must run before the model's SQL: after it, SET TRANSACTION READ WRITE is refused
    await client.query("select 1");
    // Extended protocol rejects multiple statements; the newline keeps a trailing -- comment from eating the wrapper
    // (queryMode is supported by pg 8.23 but missing from @types/pg)
    const result = await client.query<Record<string, unknown>>({
      text: `select * from (\n${checked.sql}\n) as q limit ${MAX_ROWS + 1}`,
      values: params,
      queryMode: "extended",
    } as pg.QueryConfig);
    const truncated = result.rows.length > MAX_ROWS;
    const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;
    return { ok: true, columns: result.fields.map((f) => f.name), rows, rowCount: rows.length, truncated };
  } catch (e) {
    const err = e as Error & { hint?: string };
    if (!(err instanceof pg.DatabaseError)) broken = err; // connection problem, not a SQL error
    return { ok: false, error: err.message + (err.hint ? ` Hint: ${err.hint}` : "") };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release(broken);
  }
}
