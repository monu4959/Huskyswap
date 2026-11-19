// checkSql: the parser-level SQL guard. Parser only, no database.
// scripts/test-agent-guard.mjs covers the same boundary end to end against a real
// database; these cases are the ones the parser alone decides.

import { describe, expect, it } from "vitest";
import { checkSql } from "@/lib/agent/guard.ts";
import { SCHEMA_CARD } from "@/lib/agent/schema-card.ts";
import type { DbRole } from "@/lib/agent/types.ts";

const STUDENT: DbRole = "nlq_student";
const ADMIN: DbRole = "nlq_admin";

async function accepted(sql: string, role: DbRole = ADMIN) {
  const r = await checkSql(sql, role);
  expect(r, `expected accepted: ${sql}`).toMatchObject({ ok: true });
  return r.ok ? r.sql : "";
}

async function rejected(sql: string, role: DbRole = ADMIN) {
  const r = await checkSql(sql, role);
  expect(r.ok, `expected rejected: ${sql}`).toBe(false);
  return r.ok ? "" : r.error;
}

describe("checkSql: legitimate queries", () => {
  it.each([
    ["schema-qualified view", "select title, sale_price from nlq.listings order by sale_price limit 5", STUDENT],
    ["unqualified view", "select count(*) from listings", STUDENT],
    ["calendar join with Boston conversion", "select c.semester, count(*) from listings l join calendar c on c.day = (l.listed_at at time zone 'America/New_York')::date group by 1", STUDENT],
    ["CTE + window function", "with m as (select date_trunc('month', listed_on) as month, count(*) n from nlq.listings_all group by 1) select month, n, lag(n) over (order by month) from m", ADMIN],
    ["SQL syntax that parses into pg_catalog calls", "select extract(year from listed_on), substring(title from 1 for 10), position('a' in title), trim(title) from nlq.listings_all where title like '%!%%' escape '!'", ADMIN],
    ["generate_series in FROM", "select d::date from generate_series('2025-01-01'::date, '2025-01-07', interval '1 day') d", ADMIN],
    ["unnest in FROM", "select x from unnest(array[1,2,3]) as t(x)", STUDENT],
    ["pg_catalog-qualified allowed function", "select pg_catalog.count(*) from nlq.listings", STUDENT],
    ["aggregate FILTER and percentile", "select count(*) filter (where sale_price > 10), percentile_cont(0.5) within group (order by sale_price) from nlq.listings", STUDENT],
    ["coalesce / nullif / greatest are expressions, not functions", "select coalesce(sale_price, 0), nullif(category, ''), greatest(sale_price, rent_price_per_week) from nlq.listings", STUDENT],
    ["student's own my_* views", "select count(*) from nlq.my_deals d join nlq.my_listings l on l.item_id = d.item_id", STUDENT],
    ["UNION of two allowed views", "select category from nlq.listings union select category from nlq.categories", STUDENT],
    ["scalar subquery", "select (select count(*) from nlq.listings) as n", STUDENT],
    ["qualified columns that exist", "select l.title, s.name from nlq.listings_all l join nlq.meetup_spots s on s.spot_id = l.spot_id", ADMIN],
    ["l.* star", "select l.* from nlq.listings l", STUDENT],
    ["date column cast to date", "select count(*) from nlq.deals where rental_due_date::date > '2025-01-01'", ADMIN],
    ["trailing line comment", "select count(*) from nlq.reviews -- total reviews", ADMIN],
    ["parameter placeholder", "select name from nlq.meetup_spots where name ilike $1", STUDENT],
  ])("accepts %s", async (_label, sql, role) => {
    await accepted(sql, role);
  });

  it("strips one trailing semicolon and surrounding whitespace", async () => {
    expect(await accepted("  select 1 from nlq.listings ;  \n", STUDENT)).toBe("select 1 from nlq.listings");
  });

  it("accepts a query at the length limit and rejects one over it", async () => {
    const base = "select 1 from nlq.listings /* ";
    const at = base + "x".repeat(8000 - base.length - 3) + " */";
    expect(at).toHaveLength(8000);
    await accepted(at, STUDENT);
    await accepted(`  ${at} ;  `, STUDENT); // measured after trimming
    const over = base + "x".repeat(8001 - base.length - 3) + " */";
    expect(await rejected(over, STUDENT)).toMatch(/too long \(max 8000/);
  });
});

describe("checkSql: shape of the input", () => {
  it.each(["", "   ", ";", " ; "])("rejects empty input %j", async (sql) => {
    expect(await rejected(sql)).toBe("Empty query.");
  });

  it("rejects a comment-only input as not one statement", async () => {
    expect(await rejected("-- nothing here")).toBe("Send exactly one SELECT statement.");
  });

  it("reports a syntax error with the parser's message", async () => {
    expect(await rejected("selec * from nlq.listings")).toMatch(/^Syntax error: /);
  });

  it.each([
    ["two SELECTs", "select 1; select 2"],
    ["select then delete", "select 1; delete from nlq.calendar"],
    ["semicolon hidden after a block comment", "select 1 /* ; */ ; drop table nlq.calendar"],
    ["second statement after a line comment and newline", "select 1 -- hi\n; select 2"],
  ])("rejects multiple statements: %s", async (_label, sql) => {
    expect(await rejected(sql)).toBe("Send exactly one SELECT statement.");
  });
});

describe("checkSql: writes and other statements", () => {
  it.each([
    ["insert", "insert into nlq.calendar (day) values ('2025-01-01')"],
    ["update", "update nlq.listings set title = 'x'"],
    ["delete", "delete from nlq.calendar"],
    ["merge", "merge into nlq.calendar c using nlq.calendar d on c.day = d.day when matched then delete"],
    ["truncate", "truncate nlq.calendar"],
    ["create table as", "create table nlq.stolen as select * from nlq.deals"],
    ["create view", "create view nlq.v as select 1"],
    ["alter", "alter table nlq.calendar add column x int"],
    ["grant", "grant select on nlq.deals to public"],
    ["set role", "set role postgres"],
    ["set transaction", "set transaction read write"],
    ["reset", "reset role"],
    ["show", "show data_directory"],
    ["explain", "explain analyze select 1"],
    ["copy to program", "copy (select 1) to program 'curl evil'"],
    ["call", "call some_proc()"],
    ["do block", "do $$ begin perform pg_sleep(1); end $$"],
    ["prepare", "prepare p as select 1"],
    ["listen", "listen chan"],
    ["vacuum", "vacuum nlq.calendar"],
  ])("rejects %s", async (_label, sql) => {
    expect(await rejected(sql)).toBe("Only SELECT queries are allowed; the data is read-only.");
  });

  it.each([
    ["delete in a CTE", "with d as (delete from nlq.calendar returning *) select count(*) from d"],
    ["update in a CTE", "with u as (update nlq.listings set title = 'x' returning item_id) select * from u"],
    ["insert in a nested CTE", "select * from (with i as (insert into nlq.calendar (day) values (now()) returning day) select * from i) s"],
  ])("rejects a write hidden in WITH: %s", async (_label, sql) => {
    expect(await rejected(sql)).toContain("Only SELECT is allowed, including inside WITH.");
  });

  it("rejects SELECT ... INTO (creates a table)", async () => {
    expect(await rejected("select * into nlq.stolen from nlq.deals")).toContain("SELECT INTO is not allowed.");
    expect(await rejected("select * into temp t from nlq.listings", STUDENT)).toContain("SELECT INTO is not allowed.");
  });

  it.each(["for update", "for share", "for no key update", "for key share", "for update skip locked", "for update of c nowait"])(
    "rejects locking clause %s",
    async (clause) => {
      expect(await rejected(`select * from nlq.calendar c ${clause}`)).toContain("FOR UPDATE / FOR SHARE is not allowed.");
    },
  );

  it("rejects a locking clause inside a subquery", async () => {
    expect(await rejected("select * from (select * from nlq.calendar for update) s")).toContain("FOR UPDATE / FOR SHARE");
  });
});

describe("checkSql: schemas and views", () => {
  it.each([
    ["public table", "select name from public.profiles"],
    ["auth.users", "select email from auth.users"],
    ["pg_catalog table", "select * from pg_catalog.pg_roles"],
    ["information_schema", "select * from information_schema.tables"],
    ["ops schema", "select * from ops.agent_runs"],
    ["storage schema in a join", "select 1 from nlq.listings l join storage.objects o on true"],
    ["catalog-qualified name", "select * from postgres.nlq.listings"],
    ["upper-case schema folds to lower case", "select email from AUTH.USERS"],
    ["comment between schema and dot", "select email from auth/**/.users"],
    ["view in a subquery", "select (select count(*) from auth.users)"],
    ["view in EXISTS", "select 1 where exists (select 1 from public.profiles)"],
  ])("rejects a non-nlq schema: %s", async (_label, sql) => {
    expect(await rejected(sql)).toMatch(/Only nlq views can be queried/);
  });

  it("names the forbidden relation in the error", async () => {
    expect(await rejected("select * from auth.users")).toBe("Only nlq views can be queried; auth.users is not allowed.");
  });

  it.each([
    ["pg_user (catalog, unqualified)", "select * from pg_user"],
    ["pg_settings (catalog, unqualified)", "select name, setting from pg_settings"],
    ["profiles (public, unqualified)", "select * from profiles"],
    ["unicode-escaped identifier", String.raw`select * from U&"pg\005fuser"`],
    ["quoted mixed-case name is a different relation", 'select * from nlq."Listings"'],
    ["made-up view", "select * from nlq.payments"],
  ])("rejects an unknown view: %s", async (_label, sql) => {
    expect(await rejected(sql)).toMatch(/^Unknown view "[^"]+"\. Views you can query: /);
  });

  // Every admin-only view in the schema card must be refused to a student
  const adminOnly = SCHEMA_CARD.filter((v) => !v.roles.includes("nlq_student")).map((v) => v.name);
  it("has admin-only views to check", () => {
    expect(adminOnly).toEqual(expect.arrayContaining(["deals", "listings_all", "reviews", "students", "conversations"]));
  });
  it.each(adminOnly)("student cannot read admin-only view %s (but admin can)", async (view) => {
    expect(await rejected(`select count(*) from nlq.${view}`, STUDENT)).toContain(`Unknown view "${view}"`);
    await accepted(`select count(*) from nlq.${view}`, ADMIN);
  });

  it("student cannot reach an admin view through a subquery, CTE or join", async () => {
    await rejected("select (select count(*) from nlq.reviews)", STUDENT);
    await rejected("with r as (select * from nlq.deals) select count(*) from r", STUDENT);
    await rejected("select 1 from nlq.listings l join nlq.listings_all a on a.item_id = l.item_id", STUDENT);
  });

  it("lists only the role's views in the error", async () => {
    const studentError = await rejected("select * from nlq.deals", STUDENT);
    expect(studentError).not.toMatch(/\bdeals\b.*Views you can query:.*\bdeals\b/);
    expect(studentError).toContain("my_deals");
    expect(studentError).not.toContain("listings_all");
  });

  it("accepts TABLE syntax for an allowed view, rejects it for a hidden one", async () => {
    await accepted("table nlq.deals", ADMIN);
    await rejected("table nlq.deals", STUDENT);
  });

  it("a CTE may shadow a view name it then reads", async () => {
    await accepted("with listings as (select * from nlq.listings where sale_price > 5) select count(*) from listings", STUDENT);
  });

  // Fixed: CTE names were collected from the whole query, not per scope. A CTE named
  // after a catalog view anywhere in the query made an unqualified reference to the
  // real catalog view elsewhere look like a CTE reference, so the guard accepted it.
  it("a CTE declared in one scope does not whitelist a catalog view in another", async () => {
    await rejected("select name, setting from pg_settings, (with pg_settings as (select 1) select 1) z");
  });
  it("a CTE in a scalar subquery does not whitelist pg_roles in the outer FROM", async () => {
    await rejected("select (with pg_roles as (select 1) select 1), rolname from pg_roles", STUDENT);
  });

  describe("WITH query scope", () => {
    it.each([
      ["CTE in a FROM subquery, view outside it", "select * from (with profiles as (select 1) select 1) a, profiles", STUDENT],
      ["CTE in one WITH query's body, used by a sibling", "with a as (with profiles as (select 1) select 1), b as (select * from profiles) select * from b", ADMIN],
      ["CTE in an EXISTS, used in the outer FROM", "select * from profiles where exists (with profiles as (select 1) select 1)", ADMIN],
      ["CTE in one UNION branch, used in the other", "select * from (with profiles as (select 1) select 1) a union all select * from profiles", ADMIN],
      ["forward reference without RECURSIVE is a real relation", "with a as (select * from profiles), profiles as (select 1) select * from a", ADMIN],
      ["a CTE does not see itself without RECURSIVE", "with profiles as (select * from profiles) select * from profiles", ADMIN],
    ])("rejects a name used outside its WITH query's scope: %s", async (_label, sql, role) => {
      expect(await rejected(sql, role)).toContain('Unknown view "profiles"');
    });

    it.each([
      ["earlier CTE from a later one", "with a as (select 1 as x), b as (select x from a) select x from b", STUDENT],
      ["CTE from a scalar subquery", "with s as (select 1 as x) select (select x from s)", STUDENT],
      ["CTE from a FROM subquery", "with s as (select 1 as x) select * from (select * from s) q", STUDENT],
      ["CTE from both UNION branches", "with s as (select 1 as x) select x from s union select x from s", STUDENT],
      ["outer CTE from a nested CTE", "with s as (select 1 as x) select * from (with t as (select x from s) select x from t) q", STUDENT],
    ])("accepts a WITH query used in scope: %s", async (_label, sql, role) => {
      await accepted(sql, role);
    });

    it.each([
      ["pg_settings", "with pg_settings as (select 1) select * from pg_settings", ADMIN],
      ["pg_roles, in a subquery", "select * from (with pg_roles as (select 1 as x) select x from pg_roles) q", ADMIN],
      ["an information_schema view", "with tables as (select 1 as x) select x from tables", ADMIN],
      ["a view the student can't see", "with deals as (select * from nlq.my_deals) select count(*) from deals", STUDENT],
    ])("rejects a WITH query named like a system relation or hidden view: %s", async (_label, sql, role) => {
      expect(await rejected(sql, role)).toMatch(/^WITH query name "\w+" is reserved/);
    });

    it("lets an admin name a CTE after a view the admin can see", async () => {
      await accepted("with deals as (select * from nlq.deals where status = 'completed') select count(*) from deals", ADMIN);
    });
  });
});

describe("checkSql: functions", () => {
  it.each([
    ["pg_sleep", "select pg_sleep(30)"],
    ["pg_catalog.pg_sleep", "select pg_catalog.pg_sleep(1)"],
    ["quoted pg_sleep", 'select "pg_sleep"(1)'],
    ["upper-case PG_SLEEP", "select PG_SLEEP(1)"],
    ["pg_read_file", "select pg_read_file('/etc/passwd')"],
    ["pg_read_binary_file", "select pg_read_binary_file('/etc/passwd')"],
    ["set_config", "select set_config('role', 'postgres', true)"],
    ["current_setting", "select current_setting('data_directory')"],
    ["query_to_xml (runs a query string)", "select query_to_xml('select * from auth.users', true, true, '')"],
    ["lo_import", "select lo_import('/etc/passwd')"],
    ["version", "select version()"],
    ["txid_current", "select txid_current()"],
    ["pg_advisory_lock", "select pg_advisory_lock(1)"],
    ["nextval", "select nextval('some_seq')"],
    ["app function, unqualified", "select remove_listing(1)"],
    ["function in WHERE", "select 1 from nlq.listings where pg_sleep(1) is not null"],
    ["function in ORDER BY", "select title from nlq.listings order by pg_sleep(0.1)"],
    ["function as an argument of an allowed one", "select count(pg_sleep(1))"],
    ["function inside a CASE", "select case when true then pg_sleep(1) end"],
    ["function in a CTE", "with s as (select pg_sleep(1)) select * from s"],
  ])("rejects disallowed function: %s", async (_label, sql) => {
    expect(await rejected(sql)).toMatch(/Function \w+\(\) is not allowed\./);
  });

  it("rejects any schema-qualified function outside pg_catalog, even an allowed name", async () => {
    expect(await rejected("select public.count(*) from nlq.listings")).toContain("Function public.count() is not allowed.");
    expect(await rejected("select public.remove_listing(1)")).toContain("Function public.remove_listing() is not allowed.");
  });

  it("rejects dblink in FROM twice over (as a function and in FROM)", async () => {
    const error = await rejected("select * from dblink('host=evil', 'select 1') as t(x int)");
    expect(error).toContain("dblink() is not allowed in FROM.");
    expect(error).toContain("Function dblink() is not allowed.");
  });

  it("rejects a disallowed function inside ROWS FROM", async () => {
    expect(await rejected("select * from rows from (generate_series(1,2), pg_ls_dir('.')) t(a,b)")).toContain("pg_ls_dir() is not allowed in FROM.");
  });

  it("rejects an allowed scalar function used as a FROM source", async () => {
    expect(await rejected("select * from lower('x') as t(x)")).toContain("lower() is not allowed in FROM.");
  });

  it("reports each distinct problem once", async () => {
    const error = await rejected("select pg_sleep(1), pg_sleep(2), pg_sleep(3)");
    expect(error).toBe("Function pg_sleep() is not allowed.");
  });

  it("collects several different problems in one message", async () => {
    const error = await rejected("select pg_sleep(1) from auth.users for update");
    expect(error).toContain("Function pg_sleep() is not allowed.");
    expect(error).toContain("auth.users is not allowed");
    expect(error).toContain("FOR UPDATE / FOR SHARE");
  });
});

describe("checkSql: made-up columns", () => {
  it("rejects alias.column that the view doesn't have, listing its columns", async () => {
    const error = await rejected("select l.price from nlq.listings l", STUDENT);
    expect(error).toMatch(/^Column l\.price does not exist in listings\. Its columns: item_id, title, /);
  });

  it("checks view.column and nlq.view.column too", async () => {
    await rejected("select deals.buyer_name from nlq.deals", ADMIN);
    await rejected("select nlq.deals.buyer_name from nlq.deals", ADMIN);
    await accepted("select nlq.deals.deal_id from nlq.deals", ADMIN);
  });

  it("leaves unqualified and unknown-qualifier columns to Postgres", async () => {
    await accepted("select price from nlq.listings", STUDENT);
    await accepted("select x.price from nlq.listings l", STUDENT);
  });

  it("accepts an alias bound to two views when either has the column", async () => {
    await accepted("select t.title from nlq.listings t union all select t.title from nlq.my_listings t", STUDENT);
  });

  // Fixed: aliases were collected across all scopes. A CTE (or subquery) reusing the
  // alias or name of a view it reads made the outer reference look like the view, so
  // columns the CTE computes were reported as missing.
  it("alias reused inside a CTE does not hide the CTE's own columns", async () => {
    await accepted("with l as (select category, count(*) as n from nlq.listings l group by 1) select l.category, l.n from l", STUDENT);
  });
  it("CTE named after the view it aggregates", async () => {
    await accepted("with listings as (select category, count(*) as n from nlq.listings group by 1) select listings.n from listings", STUDENT);
  });
  it("subquery aliased like the view it reads", async () => {
    await accepted("select l.n from (select count(*) as n from nlq.listings l) l", STUDENT);
  });
  it("still checks columns inside the CTE or subquery", async () => {
    expect(await rejected("with c as (select l.price from nlq.listings l) select * from c", STUDENT)).toMatch(/^Column l\.price does not exist in listings/);
    expect(await rejected("select * from (select l.price from nlq.listings l) l", STUDENT)).toMatch(/^Column l\.price does not exist/);
  });
  it("resolves a correlated qualifier to the outer query, and an inner alias shadows it", async () => {
    await accepted("select title from nlq.listings l where exists (select 1 from nlq.categories c where c.category = l.category)", STUDENT);
    expect(await rejected("select 1 from nlq.listings l where exists (select 1 from nlq.categories c where l.nope = c.category)", STUDENT)).toContain("Column l.nope does not exist in listings");
    await accepted("select 1 from nlq.listings l where exists (select 1 from nlq.categories l where l.label = 'x')", STUDENT);
    expect(await rejected("select 1 from nlq.listings l where exists (select 1 from nlq.categories l where l.title = 'x')", STUDENT)).toContain("Column l.title does not exist in categories");
  });
  it("does not check columns of a source renamed with a column list", async () => {
    await accepted("select l.a from nlq.listings l(a)", STUDENT);
  });
});

describe("checkSql: UTC timestamp cast to date", () => {
  it.each([
    ["alias.col::date", "select avg(r.resolved_at::date - r.filed_on) from nlq.reports r", ADMIN],
    ["cast(col as date)", "select count(*) from nlq.listings where cast(listed_at as date) = '2025-04-21'", STUDENT],
    ["unqualified col::date", "select listed_at::date from nlq.listings", STUDENT],
    ["pg_catalog.date target", "select listed_at::pg_catalog.date from nlq.listings", STUDENT],
  ])("rejects %s with a hint", async (_label, sql, role) => {
    expect(await rejected(sql, role)).toMatch(/is a UTC timestamp, so \w+::date is the UTC day\. Use \(\w+ at time zone 'America\/New_York'\)::date/);
  });

  it.each([
    ["converted to Boston first", "select (resolved_at at time zone 'America/New_York')::date from nlq.reports", ADMIN],
    ["a date column", "select listed_on::date from nlq.listings_all", ADMIN],
    ["a text column", "select title::date from nlq.listings", STUDENT],
    ["cast to timestamp, not date", "select listed_at::timestamp from nlq.listings", STUDENT],
  ])("allows %s", async (_label, sql, role) => {
    await accepted(sql, role);
  });

  // Fixed (gap): only a bare column cast to date was checked; a cast chain still yields the UTC day.
  it("listed_at::timestamp::date still yields the UTC day and is rejected", async () => {
    await rejected("select listed_at::timestamp::date from nlq.listings_all", ADMIN);
  });

  // Fixed (false positive): an unqualified column was checked against every view in the
  // query, so a CTE column that reuses a timestamptz column's name was rejected even
  // after it was converted to Boston time. Columns now resolve through the CTE.
  it("a converted CTE column with the same name is not a UTC timestamp", async () => {
    await accepted(
      "with x as (select (listed_at at time zone 'America/New_York') as listed_at from nlq.listings) select listed_at::date from x",
      STUDENT,
    );
  });

  it.each([
    ["through text", "select listed_at::text::date from nlq.listings", STUDENT],
    ["cast(cast(...))", "select cast(cast(l.listed_at as timestamp) as date) from nlq.listings l", STUDENT],
    ["a CTE passing the column through", "with x as (select listed_at from nlq.listings) select listed_at::date from x", STUDENT],
    ["a CTE renaming it", "with x as (select l.listed_at as t from nlq.listings l) select t::date from x", STUDENT],
    ["a CTE column list renaming it", "with x(t) as (select listed_at from nlq.listings) select x.t::date from x", STUDENT],
    ["a subquery casting it to timestamp", "select s.t::date from (select listed_at::timestamp as t from nlq.listings) s", STUDENT],
    ["SELECT * in a CTE", "with x as (select * from nlq.listings) select listed_at::date from x", STUDENT],
    ["a UNION in a CTE", "with x as (select title, listed_at from nlq.listings union all select title, listed_at from nlq.my_listings) select listed_at::date from x", STUDENT],
    ["inside a correlated subquery", "select (select max(listed_at::date) from nlq.categories c where c.category = l.category) from nlq.listings l", STUDENT],
  ])("rejects a UTC day reached %s", async (_label, sql, role) => {
    expect(await rejected(sql, role)).toContain("is a UTC timestamp");
  });

  it.each([
    ["a subquery converting it", "select t::date from (select listed_at at time zone 'America/New_York' as t from nlq.listings) s", STUDENT],
    ["a CTE column of another type with the same name", "with x as (select listed_on as listed_at from nlq.listings_all) select listed_at::date from x", ADMIN],
    ["a converted column in a UNION", "select (listed_at at time zone 'America/New_York')::date from nlq.listings union select listed_on from nlq.my_listings", STUDENT],
  ])("allows %s", async (_label, sql, role) => {
    await accepted(sql, role);
  });
});

describe("checkSql: returned SQL", () => {
  it("returns the SQL the caller should run (trimmed, no trailing semicolon)", async () => {
    expect(await accepted("select 1 from nlq.listings;", STUDENT)).toBe("select 1 from nlq.listings");
  });

  // Fixed: db.ts wraps checked.sql as `select * from (\n<sql>\n) as q limit 201`. Only one
  // trailing semicolon at the very end was stripped, so "...; -- note" or ";;" passed the
  // guard and then failed in the database with a syntax error. The guard now returns the
  // statement's own text, cut at the parser's statement boundaries.
  it("a semicolon followed by a comment is not left in the returned SQL", async () => {
    expect(await accepted("select count(*) from nlq.reviews; -- total reviews")).not.toContain(";");
  });
  it("a doubled trailing semicolon is not left in the returned SQL", async () => {
    expect(await accepted("select count(*) from nlq.reviews;;")).not.toContain(";");
  });
  it.each([
    ["semicolon and line comment", "select count(*) from nlq.reviews; -- total reviews"],
    ["semicolon and block comment", "select count(*) from nlq.reviews; /* total */"],
    ["two semicolons", "select count(*) from nlq.reviews;;"],
    ["semicolons with space and newlines", "select count(*) from nlq.reviews ; ;\n ;\n"],
    ["a leading comment", "-- how many reviews\nselect count(*) from nlq.reviews;"],
    ["a leading block comment", "/* q1 */ select count(*) from nlq.reviews"],
  ])("returns just the statement: %s", async (_label, sql) => {
    expect(await accepted(sql)).toBe("select count(*) from nlq.reviews");
  });
  it("cuts at the right place after non-ASCII text (byte offsets)", async () => {
    expect(await accepted("select 'café ☕' as x from nlq.listings; -- é", STUDENT)).toBe("select 'café ☕' as x from nlq.listings");
  });
  it("keeps semicolons and comments inside the statement", async () => {
    expect(await accepted("select ';' as s, /* ; */ count(*) from nlq.reviews;")).toBe("select ';' as s, /* ; */ count(*) from nlq.reviews");
  });
  it("still rejects a second statement after trailing semicolons", async () => {
    expect(await rejected("select 1 from nlq.reviews; ; select 2")).toBe("Send exactly one SELECT statement.");
  });
});

describe("checkSql: functions that allocate by a number argument", () => {
  it.each([
    ["lpad to 250 million", "select lpad('x', 250000000, 'y')"],
    ["rpad over the cap", "select rpad(title, 1001, '.') from nlq.listings"],
    ["lpad with a computed length", "select lpad(title, length(title) * 100000, 'x') from nlq.listings"],
    ["lpad with a cast length", "select lpad('x', 5::int, 'y')"],
    ["generate_series over the cap", "select count(*) from generate_series(1, 100000000)"],
    ["generate_series with a float literal", "select count(*) from generate_series(1, 1e9) g"],
    ["generate_series with a big negative start", "select count(*) from generate_series(-100000000, 0) g"],
    ["format with a huge width", "select format('%250000000s', 'x')"],
    ["format with a width over 1000", "select format('%1001s', 'x')"],
    ["format with a * width", "select format('%*s', 50, 'x')"],
    ["format with a positional * width", "select format('%*1$s', 50)"],
    ["format with a computed template", "select format(title, 1) from nlq.listings"],
  ])("rejects %s", async (_label, sql) => {
    expect(await rejected(sql)).toMatch(/limited to 10000|plain number of at most 1000 as its length|literal format string/);
  });

  it.each([
    ["lpad of an academic year, as in the gold SQL", "select lpad(((extract(year from listed_on)::int + 1) % 100)::text, 2, '0') from nlq.listings_all"],
    ["rpad at the cap", "select rpad(title, 1000, '.') from nlq.listings"],
    ["generate_series of months", "select m from generate_series(1, 12) m"],
    ["generate_series of dates", "select d::date from generate_series('2025-01-01'::date, '2025-12-31', interval '1 day') d"],
    ["format with plain and positional specs", "select format('%s sold for $%s (%1$-20s|%%)', title, sale_price) from nlq.listings"],
  ])("accepts %s", async (_label, sql) => {
    await accepted(sql);
  });
});

describe("checkSql: values that could grow without bound", () => {
  it.each([
    ["WITH RECURSIVE", "with recursive t(n) as (select 1 union all select n + 1 from t where n < 5) select n from t", /^WITH RECURSIVE is not allowed\.$/],
    ["WITH RECURSIVE doubling a string", "with recursive t(s) as (select 'x' union all select s || s from t where length(s) < 100000000) select max(length(s)) from t", /WITH RECURSIVE is not allowed/],
    ["a string literal over 1000 characters", `select '${"x".repeat(1001)}' from nlq.listings`, /String literals are limited to 1000 characters/],
    ["replace of a replace", "select replace(replace(title, 'a', 'aaaa'), 'a', 'aaaa') from nlq.listings", /^replace\(\) can multiply/],
    ["replace with a padded replacement", "select replace(rpad('x', 1000, 'x'), 'x', rpad('y', 1000, 'y') || 'z')", /^replace\(\) can multiply/],
    ["regexp_replace of a concatenation", "select regexp_replace(title || description, '.', title, 'g') from nlq.listings", /^regexp_replace\(\) can multiply/],
    ["regexp_match of a built string", "select regexp_match(concat(title, title), '((((.*))))') from nlq.listings", /^regexp_match\(\) can multiply/],
    ["format repeating a built argument", "select format('%1$s%1$s%1$s', title || title) from nlq.listings", /^format\(\) can multiply/],
    ["concat_ws with a built separator", "select concat_ws(concat_ws(title, title, title), title, title) from nlq.listings", /^concat_ws\(\) can multiply/],
    ["array_to_string of ARRAY[]", "select array_to_string(array[title, title], title) from nlq.listings", /^array_to_string\(\) can multiply/],
    ["replace of a CTE column built with ||", "with a as (select title || title as s from nlq.listings) select replace(s, 'a', 'bb') from a", /^replace\(\) can multiply/],
    ["replace of a subquery column built with concat", "select replace(s, 'a', 'bb') from (select concat(title, 'x') as s from nlq.listings) q", /^replace\(\) can multiply/],
    ["replace of a scalar subquery that builds", "select replace((select string_agg(title, ',') from nlq.listings), ',', ',,')", /^replace\(\) can multiply/],
    ["replace of SELECT * from a building CTE", "with a as (select title || title as s from nlq.listings) select replace(q.s, 'a', 'bb') from (select * from a) q", /^replace\(\) can multiply/],
    ["doubling through WITH levels", "with a as (select rpad('x', 1000, 'x') as s), b as (select s || s as s from a), c as (select s || s as s from b) select length(s) from c", /used at most once per expression/],
    ["doubling through scalar subqueries", "with a as (select title || 'x' as s from nlq.listings limit 1) select (select s from a) || (select s from a)", /used at most once per expression/],
    ["doubling through ARRAY[]", "with a as (select array[title, title] as s from nlq.listings) select array[s, s] from a", /used at most once per expression/],
    ["string_agg of a concatenation", "select string_agg(title || description, ',') from nlq.listings", /^string_agg\(\) can multiply/],
    ["string_agg of a built CTE column", "with a as (select title || 'x' as s from nlq.listings) select string_agg(s, ',') from a", /^string_agg\(\) can multiply/],
    ["array_agg of another aggregate's result", "with a as (select string_agg(title, ',') as s from nlq.listings) select array_agg(s) from a", /^array_agg\(\) can multiply/],
    ["string_agg as a window function", "select string_agg(title, ',') over (order by item_id) from nlq.listings", /can't be used as a window function/],
    ["string_agg over a cross product", "select string_agg(l.title, ',') from nlq.listings l, nlq.calendar c", /over a cross product/],
    ["string_agg over a CROSS JOIN", "select string_agg(l.title, ',') from nlq.listings l cross join nlq.calendar c", /over a cross product/],
    ["string_agg over a cross product in a subquery", "select string_agg(t, ',') from (select l.title as t from nlq.listings l, nlq.calendar c) q", /over a cross product/],
    ["string_agg over generate_series with computed bounds", "select string_agg(g::text, ',') from generate_series(1, (select count(*) from nlq.listings) * 1000) g", /over a cross product/],
    ["string_agg over date generate_series", "select string_agg(d::text, ',') from generate_series('2000-01-01'::timestamp, '2030-01-01', interval '1 second') d", /over a cross product/],
    ["string_agg over a SELECT-list generate_series", "select string_agg(x::text, ',') from (select generate_series(1, (select count(*) from nlq.listings) * 1000) as x) q", /over a cross product/],
    ["four unrelated tables", "select count(*) from nlq.listings a, nlq.calendar b, nlq.categories c, nlq.meetup_spots d", /^4 tables are combined without join conditions/],
    ["four tables, one join among them", "select 1 from nlq.listings a join nlq.categories c on c.category = a.category, nlq.calendar b, nlq.meetup_spots d, nlq.reviews r", /^4 tables are combined/],
    ["more than four size-multiplying calls", "select replace(title, 'a', 'b'), replace(title, 'c', 'd'), replace(title, 'e', 'f'), replace(title, 'g', 'h'), replace(title, 'i', 'j') from nlq.listings", /At most 4 calls/],
  ])("rejects %s", async (_label, sql, error) => {
    expect(await rejected(sql)).toMatch(error);
  });

  it.each([
    ["a string literal of 1000 characters", `select '${"x".repeat(1000)}' from nlq.listings`],
    ["|| chains, as in the gold SQL", "select extract(year from listed_on)::int || '-' || lpad(((extract(year from listed_on)::int + 1) % 100)::text, 2, '0') from nlq.listings_all"],
    ["concat of view columns", "select count(*) from nlq.listings where concat(title, ' ', description) ilike '%pickup only%'"],
    ["replace of a view column", "select replace(category, '_', ' ') from nlq.listings"],
    ["regexp_replace of a view column", "select regexp_replace(title, '\\s+', ' ', 'g') from nlq.listings"],
    ["replace inside concat", "select concat(replace(category, '_', ' '), ': ', title) from nlq.listings"],
    ["a built CTE column used once", "with a as (select title || ' (' || category || ')' as label from nlq.listings) select label || '!' from a"],
    ["a built CTE column used once in each of two expressions", "with a as (select title || 'x' as s from nlq.listings) select s || '1', s || '2' from a"],
    ["a CTE column that isn't built, used twice", "with a as (select lower(title) as t from nlq.listings) select t || ' / ' || t from a"],
    ["string_agg of a view column", "select category, string_agg(title, ', ' order by title) from nlq.listings group by category"],
    ["string_agg over a join with a condition", "select string_agg(l.title, ',') from nlq.listings l join nlq.categories c on c.category = l.category"],
    ["string_agg over a comma join with a WHERE condition", "select string_agg(l.title, ',') from nlq.listings l, nlq.categories c where c.category = l.category"],
    ["string_agg over a literal generate_series", "select string_agg(g::text, ',') from generate_series(1, 12) g"],
    ["array_agg of a view column", "select array_agg(distinct category) from nlq.listings"],
    ["a cross product of single-row subqueries", "select a.n, b.n, c.n, d.n from (select count(*) n from nlq.listings) a, (select count(*) n from nlq.categories) b, (select count(*) n from nlq.calendar) c, (select count(*) n from nlq.meetup_spots) d"],
    ["comma joins with WHERE conditions", "select round(sum(d.agreed_price) / count(*), 2) from nlq.deals d, nlq.listings_all l where l.item_id = d.item_id and d.status = 'completed'"],
    ["three unrelated tables", "select count(*) from nlq.categories a, nlq.meetup_spots b, nlq.calendar c"],
    ["a LATERAL subquery with LIMIT 1", "with m as (select month, count(*) n from nlq.calendar group by 1) select nxt.n - cur.n from m cur cross join lateral (select * from m where month = cur.month + 1 limit 1) nxt"],
    ["four size-multiplying calls", "select replace(title, 'a', 'b'), replace(title, 'c', 'd'), replace(title, 'e', 'f'), replace(title, 'g', 'h') from nlq.listings"],
  ])("accepts %s", async (_label, sql) => {
    await accepted(sql);
  });
});

// Found by the rogue-model red team (scripts/redteam-assistant.mjs)
describe("checkSql: function calls without a FuncCall node", () => {
  it.each([
    ["attribute notation on a subquery row (to_json(x))", "select x.to_json from (select title from nlq.listings limit 1) x"],
    ["attribute notation on a CTE row", "with c as (select 1 as n) select c.row_to_json from c"],
    ["attribute notation, schema-qualified", "select nlq.listings.row_to_json from nlq.listings"],
    ["field selection on a row constructor ((row).f1)", "select (row(1, 2)).f1"],
    ["field selection star ((alias).*)", "select (t).* from nlq.listings_all t"],
  ])("rejects %s", async (_label, sql) => {
    await rejected(sql);
  });

  it.each([
    ["array subscripts", "select (a)[1] from (select array[1, 2] as a) x"],
    ["an alias column named like an allowed view column", "select x.title from (select title from nlq.listings) x"],
  ])("accepts %s", async (_label, sql) => {
    await accepted(sql);
  });
});

describe("sqlTraits (what the cache scopes by)", () => {
  it.each([
    ["select count(*) from nlq.my_deals", true, false],
    [String.raw`select count(*) from nlq.U&"\006Dy_deals"`, true, false],
    ["select count(*) from (select * from nlq.MY_REVIEWS) r", true, false],
    ["select title from nlq.listings where category = 'textbooks'", false, false],
    ["select 'locked: visit evil' as notice from nlq.listings", false, true],
    ["select title || ' (ok)' from nlq.listings", false, true],
    ["not sql at all", true, true],
  ])("%j -> personal %s, literal output %s", async (sql, personal, literalOutput) => {
    const { sqlTraits } = await import("@/lib/agent/guard.ts");
    expect(await sqlTraits(sql)).toEqual({ personal, literalOutput });
  });
});
