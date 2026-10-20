// SQL node (graph nodes 4-6): write SQL -> guardrails -> execute, with every
// rejection, error or empty result fed back to the model to fix.
//
// Node limits: at most SQL_LIMITS.calls model calls, SQL_LIMITS.failures failed
// queries and SQL_LIMITS.lookups value lookups; repeating a call returns the
// earlier result instead of running it again. On the last call only
// submit_sql is offered.
//
// This conversation (system, context + question, tool calls, feedback) is the
// multi-step trace the student model is trained on.

import { runSelect } from "./db.ts";
import { checkSql } from "./guard.ts";
import type { ChatResult } from "./llm.ts";
import { sqlSystem, sqlUser } from "./prompt.ts";
import type { Retrieved } from "./retrieve.ts";
import { SCHEMA_CARD } from "./schema-card.ts";
import type { ChatMessage, DbRole, SqlResult, ToolCall } from "./types.ts";

export const SQL_LIMITS = { calls: 5, failures: 3, lookups: 2 };
const ROWS_SHOWN = 25; // rows the model sees from a result
const CELL_CHARS = 120; // longer text cells are cut

export const SQL_TOOLS = [
  {
    type: "function",
    function: {
      name: "lookup_values",
      description: "Find the exact stored values of a column that contain some text (names, codes, statuses, titles), with how often each occurs.",
      parameters: {
        type: "object",
        properties: { view: { type: "string" }, column: { type: "string" }, search: { type: "string" } },
        required: ["view", "column", "search"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description: `Try a SELECT and see its result (first ${ROWS_SHOWN} rows) without submitting it.`,
      parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_sql",
      description:
        "Submit the final SELECT that answers the question. It is validated and run; errors, unknown views or columns, and empty results come back to you. Use sql null with a reason when the question must not or cannot be answered from these views.",
      parameters: {
        type: "object",
        properties: { sql: { type: ["string", "null"] }, reason: { type: ["string", "null"] } },
        required: ["sql"],
      },
    },
  },
] as const;
const SUBMIT_ONLY = SQL_TOOLS.filter((t) => t.function.name === "submit_sql");

export type SqlEvent = { stage: "validate" | "execute"; ok: boolean; detail?: string };
type Call = (messages: ChatMessage[], opts: { tools: readonly unknown[]; requireTool?: boolean }) => Promise<ChatResult>;

export type SqlOutcome = {
  status: "answered" | "refused" | "gave_up";
  sql: string | null;
  result: SqlResult | null;
  reason: string | null; // why it was refused
  messages: ChatMessage[];
  sqlErrors: number;
};

// Compact JSON for the model: first rows only, long cells cut
function forModel(result: SqlResult) {
  if (!result.ok) return JSON.stringify({ error: result.error });
  const rows = result.rows.slice(0, ROWS_SHOWN).map((row) =>
    Object.values(row).map((v) => (typeof v === "string" && v.length > CELL_CHARS ? `${v.slice(0, CELL_CHARS)}…` : v)),
  );
  return JSON.stringify({
    columns: result.columns,
    rows,
    row_count: result.truncated ? "more than 200" : result.rowCount,
    ...(result.rowCount > ROWS_SHOWN ? { note: `showing the first ${ROWS_SHOWN} rows` } : {}),
  });
}

export async function sqlNode(input: {
  question: string;
  ctx: Retrieved;
  role: DbRole;
  userId: string | null;
  today: string;
  call: Call;
  onEvent?: (e: SqlEvent) => void;
}): Promise<SqlOutcome> {
  const { role, userId } = input;
  const messages: ChatMessage[] = [
    { role: "system", content: sqlSystem(role, input.today) },
    { role: "user", content: sqlUser(input.question, input.ctx) },
  ];
  const out: SqlOutcome = { status: "gave_up", sql: null, result: null, reason: null, messages, sqlErrors: 0 };
  let lookups = 0;
  let lastOk: { sql: string; result: SqlResult } | null = null;
  let submitted: { sql: string; result: SqlResult } | null = null; // last submit_sql that ran (even if empty)
  let emptyWarned: string | null = null; // SQL whose empty result was already questioned
  const seen = new Map<string, string>();

  // Validate (guard) and execute, reporting each stage
  const run = async (sql: string): Promise<SqlResult> => {
    const checked = await checkSql(sql, role);
    input.onEvent?.({ stage: "validate", ok: checked.ok, detail: checked.ok ? undefined : checked.error });
    if (!checked.ok) return checked;
    const result = await runSelect(sql, role, [], { userId });
    input.onEvent?.({ stage: "execute", ok: result.ok, detail: result.ok ? `${result.rowCount} rows` : result.error });
    return result;
  };

  const handle = async (call: ToolCall): Promise<{ content: string; done?: boolean }> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { content: JSON.stringify({ error: "Arguments were not valid JSON." }) };
    }
    const key = `${call.function.name}:${JSON.stringify(args)}`;
    if (call.function.name !== "submit_sql" && seen.has(key)) {
      return { content: JSON.stringify({ note: "Same call as before; its result again.", result: JSON.parse(seen.get(key)!) }) };
    }

    if (call.function.name === "lookup_values") {
      if (lookups >= SQL_LIMITS.lookups) return { content: JSON.stringify({ error: "Lookup limit reached. Write the query with what you have." }) };
      lookups++;
      // Accept "listings", "nlq.listings" or quoted names
      const viewName = String(args.view ?? "").replace(/"/g, "").replace(/^nlq\./, "");
      const view = SCHEMA_CARD.find((v) => v.name === viewName && v.roles.includes(role));
      if (!view) return { content: JSON.stringify({ error: `Unknown view ${viewName}.` }) };
      const column = view.columns.find((c) => c.name === String(args.column ?? "").replace(/"/g, ""));
      if (!column) return { content: JSON.stringify({ error: `${view.name} has no column ${String(args.column)}. Its columns: ${view.columns.map((c) => c.name).join(", ")}.` }) };
      const search = `%${String(args.search ?? "").trim()}%`;
      // Identifiers come from the schema card, never from the model's text
      const result = await runSelect(
        `select "${column.name}" as value, count(*) as n from nlq."${view.name}" where "${column.name}"::text ilike $1 group by 1 order by 2 desc, 1 limit 25`,
        role, [search], { userId },
      );
      const content = forModel(result);
      seen.set(key, content);
      return { content };
    }

    if (call.function.name === "run_sql") {
      if (typeof args.sql !== "string") return { content: JSON.stringify({ error: "sql must be a string." }) };
      const result = await run(args.sql);
      if (!result.ok) out.sqlErrors++;
      else lastOk = { sql: args.sql, result };
      const content = forModel(result);
      seen.set(key, content);
      return { content };
    }

    if (call.function.name === "submit_sql") {
      if (args.sql === null || args.sql === undefined || args.sql === "") {
        out.status = "refused";
        out.reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "That can't be answered from the data I can see.";
        return { content: JSON.stringify({ ok: true }), done: true };
      }
      if (typeof args.sql !== "string") return { content: JSON.stringify({ error: "sql must be a string or null." }) };
      const result = await run(args.sql);
      if (!result.ok) {
        out.sqlErrors++;
        return { content: JSON.stringify({ error: `Not accepted: ${result.error}` }) };
      }
      lastOk = { sql: args.sql, result };
      submitted = { sql: args.sql, result };
      // An empty result is often a wrong filter value: question it once
      if (result.rowCount === 0 && emptyWarned !== args.sql) {
        emptyWarned = args.sql;
        return { content: JSON.stringify({ note: "The query returned no rows. If nothing matching is the right answer, submit the same SQL again; otherwise check the filter values (lookup_values) and fix it." }) };
      }
      out.status = "answered";
      out.sql = args.sql;
      out.result = result;
      return { content: JSON.stringify({ ok: true }), done: true };
    }

    return { content: JSON.stringify({ error: `Unknown tool ${call.function.name}.` }) };
  };

  for (let n = 1; n <= SQL_LIMITS.calls; n++) {
    const last = n === SQL_LIMITS.calls;
    let reply: ChatResult;
    try {
      reply = await input.call(messages, { tools: last ? SUBMIT_ONLY : SQL_TOOLS, requireTool: last });
    } catch (e) {
      if (!last) throw e;
      break; // the model wouldn't submit on its last call
    }
    messages.push({ role: "assistant", content: reply.content, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });

    if (!reply.toolCalls.length) {
      messages.push({ role: "user", content: "Call submit_sql with the final SELECT, or with sql null and a reason." });
      continue;
    }
    let done = false;
    for (const call of reply.toolCalls) {
      // Every tool call needs a reply; calls after a final submit in the same turn are skipped
      const outcome = done ? { content: JSON.stringify({ error: "Skipped: already submitted." }) } : await handle(call);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      if (outcome.done) done = true;
    }
    if (done) break;
    if (out.sqlErrors >= SQL_LIMITS.failures) break;
  }

  // Out of calls after a submission that ran and returned rows: accept it. An empty
  // result counts only when the model confirmed it by resubmitting (handled above):
  // an unconfirmed "nothing found" is too often a wrong filter. Otherwise keep the
  // last query that ran, but don't call it answered.
  const accepted = submitted as { sql: string; result: SqlResult } | null; // (assigned inside handle)
  const fallback = lastOk as { sql: string; result: SqlResult } | null;
  if (out.status === "gave_up" && accepted?.result.ok && accepted.result.rowCount > 0) {
    out.status = "answered";
    out.sql = accepted.sql;
    out.result = accepted.result;
  } else if (out.status === "gave_up" && fallback) {
    out.sql = fallback.sql;
    out.result = fallback.result;
  }
  return out;
}
