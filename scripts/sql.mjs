// Run SQL against the Supabase database from the terminal.
//
//   npm run sql -- "select category, count(*) from public.items group by 1 order by 2 desc"
//   npm run sql -- --as=nlq_student "select title, sale_price from nlq.listings order by sale_price limit 5"
//   npm run sql -- --file=query.sql
//
// --as=<role> runs the query as that role (e.g. nlq_student / nlq_admin) inside a
// read-only transaction, which is how the text-to-SQL model will run queries.

import { readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const role = flag("as");
const file = flag("file");
const sql = file ? readFileSync(file, "utf8") : args.filter((a) => !a.startsWith("--")).join(" ");
if (!sql.trim()) {
  console.error('Usage: npm run sql -- "select ..."   [--as=nlq_student] [--file=query.sql]');
  process.exit(1);
}

const url = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABASE_URL=(.*)$/m)?.[1].trim();
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  if (role) {
    if (!/^[a-z_]+$/.test(role)) throw new Error("Invalid role name");
    await db.query("begin read only");
    await db.query(`set local role ${role}`);
    await db.query("set local statement_timeout = '5s'");
  }
  const result = await db.query(sql);
  const rows = Array.isArray(result) ? result.at(-1).rows : result.rows;
  if (rows?.length) console.table(rows.slice(0, 200));
  else console.log(`${result.command ?? "OK"}: ${result.rowCount ?? 0} rows`);
  if (rows?.length > 200) console.log(`(showing 200 of ${rows.length} rows)`);
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
} finally {
  if (role) await db.query("rollback").catch(() => {});
  await db.end();
}
