// runSelect with a fake pg pool: the read-only transaction it wraps every query in,
// the row cap, masking, and how connection errors are handled. The real guard runs
// (parser only); no database is touched.

import { parse } from "libpg-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class DatabaseError extends Error {
    hint?: string;
  }
  const client = { query: vi.fn(), release: vi.fn(), on: vi.fn() };
  const pool = { connect: vi.fn(), on: vi.fn(), end: vi.fn(async () => {}) };
  const Pool = vi.fn(function () {
    return pool;
  });
  const getTypeParser = vi.fn(() => (v: string) => `parsed:${v}`);
  return { DatabaseError, client, pool, Pool, getTypeParser };
});
vi.mock("pg", () => ({ default: { Pool: h.Pool, DatabaseError: h.DatabaseError, types: { getTypeParser: h.getTypeParser } } }));

const { MAX_ROWS, closePool, connectionStringFor, runSelect } = await import("@/lib/agent/db.ts");

type QueryConfig = { text: string; values: unknown[]; queryMode: string };
let resultRows: Record<string, unknown>[] = [];
let failMain: Error | null = null;

beforeEach(() => {
  vi.stubEnv("NLQ_DATABASE_URL", "postgres://unit-test.invalid/db");
  vi.stubEnv("NLQ_STUDENT_DATABASE_URL", "");
  resultRows = [{ n: 1 }];
  failMain = null;
  h.pool.connect.mockReset().mockResolvedValue(h.client);
  h.client.release.mockReset();
  h.client.query.mockReset().mockImplementation(async (q: string | QueryConfig) => {
    if (typeof q === "string") return { rows: [] };
    if (q.text.startsWith("select set_config")) return { rows: [] };
    if (failMain) throw failMain;
    return { rows: resultRows, fields: Object.keys(resultRows[0] ?? { n: 0 }).map((name) => ({ name })) };
  });
});
afterEach(async () => {
  await closePool();
});

const mainQuery = () => h.client.query.mock.calls.map((c) => c[0]).find((q): q is QueryConfig => typeof q === "object" && "queryMode" in q)!;
const statements = () => h.client.query.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : c[0].text));

describe("runSelect: before connecting", () => {
  it("refuses an unknown role", async () => {
    expect(await runSelect("select 1", "postgres" as never)).toEqual({ ok: false, error: "Unknown role postgres" });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it("returns the guard's error and never connects", async () => {
    expect(await runSelect("delete from nlq.calendar", "nlq_admin")).toEqual({ ok: false, error: "Only SELECT queries are allowed; the data is read-only." });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});

describe("runSelect: the transaction", () => {
  it("runs as the role, read-only, with a timeout and the student's id, then rolls back", async () => {
    await runSelect("select count(*) from nlq.my_deals", "nlq_student", [], { userId: "user-1" });
    expect(statements()).toEqual([
      "begin read only",
      "set local role nlq_student",
      "set local statement_timeout = 3000",
      "select set_config('app.user_id', $1, true)",
      "select * from (\nselect count(*) from nlq.my_deals\n) as q limit 201",
      "rollback",
    ]);
    expect(h.client.query.mock.calls[3][1]).toEqual(["user-1"]);
    expect(h.client.release).toHaveBeenCalledWith(undefined);
  });

  it("gives admins a longer timeout and an empty user id when nobody is signed in", async () => {
    await runSelect("select 1 from nlq.deals", "nlq_admin");
    expect(statements()).toContain("set local statement_timeout = 5000");
    expect(h.client.query.mock.calls[3][1]).toEqual([""]);
  });

  it("sends parameters with the extended protocol (one statement only)", async () => {
    await runSelect("select name from nlq.meetup_spots where name ilike $1", "nlq_student", ["%curry%"]);
    expect(mainQuery()).toMatchObject({ values: ["%curry%"], queryMode: "extended" });
  });

  it("keeps a trailing line comment from swallowing the wrapper", async () => {
    await runSelect("select count(*) from nlq.reviews -- total reviews", "nlq_admin");
    await expect(parse(mainQuery().text)).resolves.toBeDefined();
  });

  // Fixed: the guard only stripped one trailing ";" at the very end of the text, so a query
  // that ended "; -- comment" (or ";;") passed the guard and was wrapped as
  // "select * from (\n...; -- comment\n) as q", a syntax error in Postgres. The guard
  // now returns the statement alone.
  it.each(["select count(*) from nlq.reviews; -- total reviews", "select count(*) from nlq.reviews;;", "select count(*) from nlq.reviews; /* x */ ;"])(
    "a query ending in %j is wrapped into valid SQL",
    async (sql) => {
      await runSelect(sql, "nlq_admin");
      await expect(parse(mainQuery().text)).resolves.toBeDefined();
      expect(mainQuery().text).toContain("select count(*) from nlq.reviews\n");
      expect(mainQuery().text).not.toContain(";");
    },
  );

  it("rolls back and releases even when the query fails", async () => {
    failMain = Object.assign(new h.DatabaseError('column "x" does not exist'), { hint: "Perhaps you meant l.title." });
    expect(await runSelect("select x from nlq.listings", "nlq_student")).toEqual({ ok: false, error: 'column "x" does not exist Hint: Perhaps you meant l.title.' });
    expect(statements().at(-1)).toBe("rollback");
    expect(h.client.release).toHaveBeenCalledWith(undefined); // a SQL error leaves the connection usable
  });

  // Red team: an error message quoted a row value (contact details in a listing) to the model and the browser
  it("masks contact details in database error messages", async () => {
    failMain = new h.DatabaseError('invalid input syntax for type boolean: "text me (617) 555-0142 or bob@example.com"');
    expect(await runSelect("select count(*) from nlq.listings where description::boolean", "nlq_student")).toEqual({
      ok: false,
      error: 'invalid input syntax for type boolean: "text me [phone removed] or [email removed]"',
    });
  });

  it("discards the connection after a connection-level error", async () => {
    const reset = new Error("Connection terminated unexpectedly");
    failMain = reset;
    expect(await runSelect("select 1 from nlq.listings", "nlq_student")).toEqual({ ok: false, error: "Connection terminated unexpectedly" });
    expect(h.client.release).toHaveBeenCalledWith(reset);
  });

  it("still releases if the rollback itself fails", async () => {
    h.client.query.mockImplementation(async (q: string | QueryConfig) => {
      if (q === "rollback") throw new Error("gone");
      return { rows: [{ n: 1 }], fields: [{ name: "n" }] };
    });
    expect(await runSelect("select 1 from nlq.listings", "nlq_student")).toMatchObject({ ok: true });
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });
});

describe("runSelect: results", () => {
  it("returns column names, rows and the row count", async () => {
    resultRows = [{ title: "Desk", price: "40.00" }, { title: "Lamp", price: "8.00" }];
    expect(await runSelect("select title, sale_price as price from nlq.listings", "nlq_student")).toEqual({
      ok: true, columns: ["title", "price"], rows: resultRows, rowCount: 2, truncated: false,
    });
  });

  it(`caps at ${MAX_ROWS} rows and says it was truncated`, async () => {
    resultRows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ i }));
    const r = await runSelect("select item_id from nlq.listings", "nlq_student");
    expect(r).toMatchObject({ ok: true, rowCount: MAX_ROWS, truncated: true });
    resultRows = Array.from({ length: MAX_ROWS }, (_, i) => ({ i }));
    expect(await runSelect("select item_id from nlq.listings", "nlq_student")).toMatchObject({ rowCount: MAX_ROWS, truncated: false });
  });

  it("masks contact details in text cells", async () => {
    resultRows = [{ description: "text me 617-555-0123", n: 5 }];
    const r = await runSelect("select description from nlq.listings", "nlq_student");
    expect(r.ok && r.rows[0]).toEqual({ description: "text me [phone removed]", n: 5 });
  });

  it("keeps dates, times and intervals as Postgres prints them", async () => {
    await runSelect("select 1 from nlq.listings", "nlq_student");
    const { types } = (h.Pool.mock.calls[0] as unknown as [{ types: { getTypeParser: (oid: number) => (v: string) => unknown } }])[0];
    for (const oid of [1082, 1083, 1114, 1184, 1186]) expect(types.getTypeParser(oid)("2025-04-21 00:00:00+00")).toBe("2025-04-21 00:00:00+00");
    expect(types.getTypeParser(20)("12")).toBe("parsed:12"); // everything else: pg's own parser
  });
});

describe("runSelect: connecting", () => {
  it("retries a failed connect once", async () => {
    h.pool.connect.mockReset().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(h.client);
    expect(await runSelect("select 1 from nlq.listings", "nlq_student")).toMatchObject({ ok: true });
    expect(h.pool.connect).toHaveBeenCalledTimes(2);
  });

  it("reports a connection failure after two attempts", async () => {
    h.pool.connect.mockReset().mockRejectedValue(new Error("ECONNRESET"));
    expect(await runSelect("select 1 from nlq.listings", "nlq_student")).toEqual({ ok: false, error: "Database connection failed (ECONNRESET). Try again." });
    expect(h.pool.connect).toHaveBeenCalledTimes(2);
  });

  it("students connect with NLQ_STUDENT_DATABASE_URL (nlq_agent_student), admins with NLQ_DATABASE_URL", async () => {
    vi.stubEnv("NLQ_STUDENT_DATABASE_URL", "postgres://student.invalid/db");
    h.Pool.mockClear();
    await runSelect("select 1 from nlq.listings", "nlq_student");
    await runSelect("select 1 from nlq.deals", "nlq_admin");
    expect(h.Pool.mock.calls.map((c) => (c as unknown as [{ connectionString: string }])[0].connectionString)).toEqual([
      "postgres://student.invalid/db",
      "postgres://unit-test.invalid/db",
    ]);
  });

  it("falls back to NLQ_DATABASE_URL for students when NLQ_STUDENT_DATABASE_URL is unset, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { NLQ_DATABASE_URL: "postgres://agent.invalid/db" };
    expect(connectionStringFor("nlq_student", env)).toBe("postgres://agent.invalid/db");
    expect(connectionStringFor("nlq_student", env)).toBe("postgres://agent.invalid/db");
    expect(connectionStringFor("nlq_admin", { ...env, NLQ_STUDENT_DATABASE_URL: "postgres://student.invalid/db" })).toBe("postgres://agent.invalid/db");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it("reports a missing NLQ_DATABASE_URL as a connection failure", async () => {
    vi.stubEnv("NLQ_DATABASE_URL", "");
    const r = await runSelect("select 1 from nlq.listings", "nlq_student");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Missing NLQ_DATABASE_URL") });
  });
});
