// sqlNode: the write -> guard -> execute loop, driven by a scripted fake model.
// The guard and the database are mocked; nothing here parses or runs SQL.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResult } from "@/lib/agent/llm.ts";
import type { Retrieved } from "@/lib/agent/retrieve.ts";
import type { ChatMessage, DbRole, SqlResult, ToolCall } from "@/lib/agent/types.ts";

const runSelect = vi.fn<(sql: string, role: DbRole, params?: unknown[], opts?: { userId?: string | null }) => Promise<SqlResult>>();
const checkSql = vi.fn<(sql: string, role: DbRole) => Promise<{ ok: true; sql: string } | { ok: false; error: string }>>();
vi.mock("@/lib/agent/db.ts", () => ({ runSelect: (...a: Parameters<typeof runSelect>) => runSelect(...a) }));
vi.mock("@/lib/agent/guard.ts", () => ({ checkSql: (...a: Parameters<typeof checkSql>) => checkSql(...a) }));

const { SQL_LIMITS, SQL_TOOLS, sqlNode } = await import("@/lib/agent/sql-node.ts");

const CTX: Retrieved = { views: [], values: [], titles: [], glossary: [], examples: [], joins: [], ms: 0 };

const rows = (n: number, make: (i: number) => Record<string, unknown> = (i) => ({ n: i })): Extract<SqlResult, { ok: true }> => {
  const list = Array.from({ length: n }, (_, i) => make(i));
  return { ok: true, columns: Object.keys(list[0] ?? { n: 0 }), rows: list, rowCount: n, truncated: false };
};
const EMPTY = rows(0);
const ONE = rows(1);

let nextId = 0;
const tc = (name: string, args: unknown): ToolCall => ({
  id: `call_${++nextId}`,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const reply = (...toolCalls: ToolCall[]): ChatResult => ({ content: null, toolCalls, reasoning: null, promptTokens: 0, completionTokens: 0, waitedMs: 0 });
const text = (content: string): ChatResult => ({ ...reply(), content });

type Script = (ChatResult | Error)[];
function scripted(script: Script) {
  const seen: { messages: ChatMessage[]; tools: readonly unknown[] }[] = [];
  const call = vi.fn(async (messages: ChatMessage[], opts: { tools: readonly unknown[] }) => {
    seen.push({ messages: [...messages], tools: opts.tools });
    const next = script.shift();
    if (!next) throw new Error("script exhausted: the node made more calls than expected");
    if (next instanceof Error) throw next;
    return next;
  });
  return { call, seen };
}

async function run(script: Script, extra: { role?: DbRole; userId?: string | null } = {}) {
  const { call, seen } = scripted(script);
  const events: { stage: string; ok: boolean; detail?: string }[] = [];
  const out = await sqlNode({
    question: "how many bikes?", ctx: CTX, role: extra.role ?? "nlq_student", userId: extra.userId ?? null,
    today: "Wednesday, 2026-11-18", call, onEvent: (e) => events.push(e),
  });
  const toolReplies = out.messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool").map((m) => JSON.parse(m.content));
  return { out, call, seen, events, toolReplies };
}

const toolNames = (tools: readonly unknown[]) => (tools as { function: { name: string } }[]).map((t) => t.function.name);

beforeEach(() => {
  runSelect.mockReset();
  checkSql.mockReset();
  checkSql.mockImplementation(async (sql) => ({ ok: true, sql }));
  runSelect.mockResolvedValue(ONE);
});

describe("sqlNode: answering", () => {
  it("answers on the first submit that returns rows", async () => {
    const { out, call, events, toolReplies } = await run([reply(tc("submit_sql", { sql: "select 1" }))], { userId: "u1" });
    expect(out).toMatchObject({ status: "answered", sql: "select 1", result: ONE, reason: null, sqlErrors: 0, lastError: null });
    expect(call).toHaveBeenCalledTimes(1);
    expect(toolReplies).toEqual([{ ok: true }]);
    expect(runSelect).toHaveBeenCalledWith("select 1", "nlq_student", [], { userId: "u1" });
    expect(events).toEqual([{ stage: "validate", ok: true, detail: undefined }, { stage: "execute", ok: true, detail: "1 rows" }]);
  });

  it("keeps the whole conversation: system, question, assistant turn, tool reply", async () => {
    const { out } = await run([reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(out.messages[0].content).toContain("Wednesday, 2026-11-18");
    expect(out.messages[1].content).toContain("how many bikes?");
    const tool = out.messages[3] as Extract<ChatMessage, { role: "tool" }>;
    const assistant = out.messages[2] as Extract<ChatMessage, { role: "assistant" }>;
    expect(tool.tool_call_id).toBe(assistant.tool_calls![0].id);
  });

  it("offers all three tools on ordinary calls", async () => {
    const { seen } = await run([reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolNames(seen[0].tools)).toEqual(["lookup_values", "run_sql", "submit_sql"]);
    expect(seen[0].tools).toBe(SQL_TOOLS);
  });
});

describe("sqlNode: empty results", () => {
  it("questions an empty result once, then accepts the same SQL resubmitted", async () => {
    runSelect.mockResolvedValue(EMPTY);
    const { out, call, toolReplies } = await run([reply(tc("submit_sql", { sql: "select 0" })), reply(tc("submit_sql", { sql: "select 0" }))]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(toolReplies[0].note).toMatch(/returned no rows/);
    expect(toolReplies[1]).toEqual({ ok: true });
    expect(out).toMatchObject({ status: "answered", sql: "select 0", result: EMPTY });
  });

  it("questions a different empty query again", async () => {
    runSelect.mockResolvedValue(EMPTY);
    const { out, toolReplies } = await run([
      reply(tc("submit_sql", { sql: "select a" })),
      reply(tc("submit_sql", { sql: "select b" })),
      reply(tc("submit_sql", { sql: "select b" })),
    ]);
    expect(toolReplies.map((r) => ("note" in r ? "note" : "ok"))).toEqual(["note", "note", "ok"]);
    expect(out.sql).toBe("select b");
  });

  it("accepts a fixed query with rows after an empty one", async () => {
    runSelect.mockImplementation(async (sql) => (sql === "select bad" ? EMPTY : ONE));
    const { out } = await run([reply(tc("submit_sql", { sql: "select bad" })), reply(tc("submit_sql", { sql: "select good" }))]);
    expect(out).toMatchObject({ status: "answered", sql: "select good", result: ONE });
  });

  it("does not call an unconfirmed empty result answered when calls run out", async () => {
    runSelect.mockResolvedValue(EMPTY);
    const script: Script = [reply(tc("submit_sql", { sql: "select 0" }))];
    for (let i = 1; i < SQL_LIMITS.calls; i++) script.push(text("thinking..."));
    const { out, call } = await run(script);
    expect(call).toHaveBeenCalledTimes(SQL_LIMITS.calls);
    // keeps the last query that ran, for the give-up explanation, but not as an answer
    expect(out).toMatchObject({ status: "gave_up", sql: "select 0", result: EMPTY });
  });
});

describe("sqlNode: failures", () => {
  it("counts a guard rejection, sets lastError and doesn't run the SQL", async () => {
    checkSql.mockResolvedValueOnce({ ok: false, error: "Function pg_sleep() is not allowed." });
    const { out, events, toolReplies } = await run([reply(tc("submit_sql", { sql: "select pg_sleep(1)" })), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies[0]).toEqual({ error: "Not accepted: Function pg_sleep() is not allowed." });
    expect(runSelect).toHaveBeenCalledTimes(1); // only the second query ran
    expect(events[0]).toEqual({ stage: "validate", ok: false, detail: "Function pg_sleep() is not allowed." });
    expect(out).toMatchObject({ status: "answered", sqlErrors: 1, lastError: "Function pg_sleep() is not allowed." });
  });

  it("counts database errors from run_sql and submit_sql", async () => {
    runSelect.mockResolvedValueOnce({ ok: false, error: 'column "x" does not exist' }).mockResolvedValueOnce({ ok: false, error: "division by zero" });
    const { out, events } = await run([
      reply(tc("run_sql", { sql: "select x" })),
      reply(tc("submit_sql", { sql: "select 1/0" })),
      reply(tc("submit_sql", { sql: "select 1" })),
    ]);
    expect(out).toMatchObject({ status: "answered", sqlErrors: 2, lastError: "division by zero" });
    expect(events.filter((e) => e.stage === "execute" && !e.ok).map((e) => e.detail)).toEqual(['column "x" does not exist', "division by zero"]);
  });

  it(`stops after SQL_LIMITS.failures (${SQL_LIMITS.failures}) failed queries, with calls to spare`, async () => {
    checkSql.mockImplementation(async (sql) => ({ ok: false, error: `bad ${sql}` }));
    const script: Script = Array.from({ length: SQL_LIMITS.calls }, (_, i) => reply(tc("submit_sql", { sql: `q${i}` })));
    const { out, call } = await run(script);
    expect(call).toHaveBeenCalledTimes(SQL_LIMITS.failures);
    expect(out).toMatchObject({ status: "gave_up", sql: null, result: null, sqlErrors: SQL_LIMITS.failures, lastError: `bad q${SQL_LIMITS.failures - 1}` });
  });

  it("falls back to the last query that ran when it gives up", async () => {
    checkSql.mockImplementation(async (sql) => (sql === "select ok" ? { ok: true, sql } : { ok: false, error: "nope" }));
    const { out } = await run([
      reply(tc("run_sql", { sql: "select ok" })),
      reply(tc("submit_sql", { sql: "f1" })),
      reply(tc("submit_sql", { sql: "f2" })),
      reply(tc("submit_sql", { sql: "f3" })),
    ]);
    expect(out).toMatchObject({ status: "gave_up", sql: "select ok", result: ONE, sqlErrors: 3, lastError: "nope" });
  });

  it("rejects non-string SQL without counting a failure", async () => {
    const { out, toolReplies } = await run([reply(tc("submit_sql", { sql: 42 })), reply(tc("run_sql", { sql: ["x"] })), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies.slice(0, 2)).toEqual([{ error: "sql must be a string or null." }, { error: "sql must be a string." }]);
    expect(out).toMatchObject({ status: "answered", sqlErrors: 0 });
  });

  it("answers invalid JSON arguments with an error and carries on", async () => {
    const { out, toolReplies } = await run([reply(tc("submit_sql", "{sql: select 1")), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies[0]).toEqual({ error: "Arguments were not valid JSON." });
    expect(out).toMatchObject({ status: "answered", sqlErrors: 0 });
  });

  it("treats empty arguments as {} (a refusal for submit_sql)", async () => {
    const { out } = await run([reply(tc("submit_sql", ""))]);
    expect(out.status).toBe("refused");
  });

  it("answers an unknown tool with an error", async () => {
    const { toolReplies } = await run([reply(tc("drop_table", {})), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies[0]).toEqual({ error: "Unknown tool drop_table." });
  });
});

describe("sqlNode: refusals", () => {
  it("refuses with the model's reason, trimmed", async () => {
    const { out, toolReplies } = await run([reply(tc("submit_sql", { sql: null, reason: "  Emails aren't stored.  " }))]);
    expect(out).toMatchObject({ status: "refused", reason: "Emails aren't stored.", sql: null, result: null });
    expect(toolReplies).toEqual([{ ok: true }]);
    expect(checkSql).not.toHaveBeenCalled();
  });

  it.each([
    ["sql null, no reason", { sql: null }],
    ["empty sql", { sql: "", reason: "" }],
    ["blank reason", { sql: null, reason: "   " }],
    ["non-string reason", { sql: null, reason: 5 }],
  ])("uses a default reason: %s", async (_label, args) => {
    const { out } = await run([reply(tc("submit_sql", args))]);
    expect(out).toMatchObject({ status: "refused", reason: "That can't be answered from the data I can see." });
  });
});

describe("sqlNode: the last call", () => {
  it("offers only submit_sql, with a plain instruction, on the last call", async () => {
    const script: Script = Array.from({ length: SQL_LIMITS.calls - 1 }, () => text("hmm"));
    script.push(reply(tc("submit_sql", { sql: "select 1" })));
    const { out, seen } = await run(script);
    for (const s of seen.slice(0, -1)) expect(toolNames(s.tools)).toEqual(["lookup_values", "run_sql", "submit_sql"]);
    const last = seen.at(-1)!;
    expect(toolNames(last.tools)).toEqual(["submit_sql"]);
    expect(last.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/^This is your last step: call submit_sql now/) });
    expect(out.status).toBe("answered");
  });

  it("nudges a text-only reply to call submit_sql", async () => {
    const { seen } = await run([text("Let me think"), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(seen[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Let me think" },
      { role: "user", content: "Call submit_sql with the final SELECT, or with sql null and a reason." },
    ]);
  });

  it("gives up quietly if the model call fails on the last call", async () => {
    const script: Script = Array.from({ length: SQL_LIMITS.calls - 1 }, () => text("hmm"));
    script.push(new Error("tool_use_failed"));
    const { out } = await run(script);
    expect(out).toMatchObject({ status: "gave_up", sql: null });
  });

  it("propagates a model failure before the last call", async () => {
    await expect(run([new Error("rate limited")])).rejects.toThrow("rate limited");
  });

  it("never makes more than SQL_LIMITS.calls calls", async () => {
    const script: Script = Array.from({ length: SQL_LIMITS.calls + 3 }, () => text("hmm"));
    const { call, out } = await run(script);
    expect(call).toHaveBeenCalledTimes(SQL_LIMITS.calls);
    expect(out.status).toBe("gave_up");
  });
});

describe("sqlNode: several tool calls in one turn", () => {
  it("replies to every call and skips the ones after a final submit", async () => {
    const { out, toolReplies } = await run([
      reply(tc("submit_sql", { sql: "select 1" }), tc("run_sql", { sql: "select 2" }), tc("submit_sql", { sql: "select 3" })),
    ]);
    expect(toolReplies).toEqual([{ ok: true }, { error: "Skipped: already submitted." }, { error: "Skipped: already submitted." }]);
    expect(out.sql).toBe("select 1");
    expect(runSelect).toHaveBeenCalledTimes(1);
  });
});

describe("sqlNode: duplicate calls", () => {
  it("returns an identical run_sql's earlier result without running it again", async () => {
    const { toolReplies } = await run([
      reply(tc("run_sql", { sql: "select 1" })),
      reply(tc("run_sql", { sql: "select 1" })),
      reply(tc("submit_sql", { sql: "select 1" })),
    ]);
    expect(toolReplies[1]).toEqual({ note: "Same call as before; its result again.", result: toolReplies[0] });
    expect(runSelect).toHaveBeenCalledTimes(2); // first run_sql + submit; never the repeat
  });

  it("a repeated failing run_sql is not counted twice", async () => {
    runSelect.mockResolvedValueOnce({ ok: false, error: "boom" });
    const { out } = await run([reply(tc("run_sql", { sql: "select x" })), reply(tc("run_sql", { sql: "select x" })), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(out.sqlErrors).toBe(1);
  });

  it("always runs submit_sql, even when repeated", async () => {
    runSelect.mockResolvedValue(EMPTY);
    await run([reply(tc("submit_sql", { sql: "select 0" })), reply(tc("submit_sql", { sql: "select 0" }))]);
    expect(runSelect).toHaveBeenCalledTimes(2);
  });
});

describe("sqlNode: lookup_values", () => {
  it("looks values up with identifiers from the schema card and the search as a parameter", async () => {
    const { toolReplies } = await run(
      [reply(tc("lookup_values", { view: "nlq.meetup_spots", column: '"name"', search: "  curry " })), reply(tc("submit_sql", { sql: "select 1" }))],
      { userId: "u1" },
    );
    expect(runSelect.mock.calls[0]).toEqual([
      `select "name" as value, count(*) as n from nlq."meetup_spots" where "name"::text ilike $1 group by 1 order by 2 desc, 1 limit 25`,
      "nlq_student", ["%curry%"], { userId: "u1" },
    ]);
    expect(toolReplies[0]).toEqual({ columns: ["n"], rows: [[0]], row_count: 1 });
  });

  it("refuses a view the role can't see, and an unknown column", async () => {
    const { toolReplies } = await run([
      reply(tc("lookup_values", { view: "deals", column: "status", search: "x" })),
      reply(tc("lookup_values", { view: "listings", column: "price", search: "x" })),
      reply(tc("submit_sql", { sql: "select 1" })),
    ]);
    expect(toolReplies[0]).toEqual({ error: "Unknown view deals." });
    expect(toolReplies[1].error).toMatch(/^listings has no column price\. Its columns: item_id, title, /);
    expect(runSelect).toHaveBeenCalledTimes(1); // only the submit
  });

  it("lets an admin look up an admin-only view", async () => {
    await run([reply(tc("lookup_values", { view: "deals", column: "status", search: "x" })), reply(tc("submit_sql", { sql: "select 1" }))], { role: "nlq_admin" });
    expect(runSelect.mock.calls[0][0]).toContain('from nlq."deals"');
  });

  it(`allows SQL_LIMITS.lookups (${SQL_LIMITS.lookups}) lookups, then refuses`, async () => {
    const { toolReplies } = await run([
      reply(tc("lookup_values", { view: "listings", column: "title", search: "a" })),
      reply(tc("lookup_values", { view: "listings", column: "title", search: "b" })),
      reply(tc("lookup_values", { view: "listings", column: "title", search: "c" })),
      reply(tc("submit_sql", { sql: "select 1" })),
    ]);
    expect(toolReplies[2]).toEqual({ error: "Lookup limit reached. Write the query with what you have." });
    expect(runSelect).toHaveBeenCalledTimes(3); // two lookups + submit
  });

  it("a repeated lookup is served from memory and doesn't use up the limit", async () => {
    const { toolReplies } = await run([
      reply(tc("lookup_values", { view: "listings", column: "title", search: "a" })),
      reply(tc("lookup_values", { view: "listings", column: "title", search: "a" })),
      reply(tc("lookup_values", { view: "listings", column: "title", search: "b" })),
      reply(tc("submit_sql", { sql: "select 1" })),
    ]);
    expect(toolReplies[1].note).toBe("Same call as before; its result again.");
    expect(toolReplies[2].error).toBeUndefined();
  });
});

describe("sqlNode: what the model sees of a result", () => {
  it("shows the first 25 rows, cuts long text, and says how many there were", async () => {
    const long = "x".repeat(200);
    runSelect.mockResolvedValueOnce(rows(30, (i) => ({ i, t: i === 0 ? long : "short" })));
    const { toolReplies } = await run([reply(tc("run_sql", { sql: "select big" })), reply(tc("submit_sql", { sql: "select 1" }))]);
    const shown = toolReplies[0];
    expect(shown.columns).toEqual(["i", "t"]);
    expect(shown.rows).toHaveLength(25);
    expect(shown.rows[0]).toEqual([0, `${"x".repeat(120)}…`]);
    expect(shown.row_count).toBe(30);
    expect(shown.note).toBe("showing the first 25 rows");
  });

  it("says 'more than 200' for a truncated result", async () => {
    runSelect.mockResolvedValueOnce({ ...rows(200), truncated: true });
    const { toolReplies } = await run([reply(tc("run_sql", { sql: "select all" })), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies[0].row_count).toBe("more than 200");
  });

  it("shows an error as {error}", async () => {
    runSelect.mockResolvedValueOnce({ ok: false, error: "relation does not exist" });
    const { toolReplies } = await run([reply(tc("run_sql", { sql: "select x" })), reply(tc("submit_sql", { sql: "select 1" }))]);
    expect(toolReplies[0]).toEqual({ error: "relation does not exist" });
  });
});
