// The agent's four tools: their definitions (OpenAI tool format) and what runs
// when the model calls them. Tool results go back to the model as compact JSON.

import { runSelect } from "./db.ts";
import { SCHEMA_CARD } from "./schema-card.ts";
import type { DbRole, SqlResult, ToolCall } from "./types.ts";

const ROWS_SHOWN = 25; // rows the model sees from a result
const CELL_CHARS = 120; // longer text cells are cut

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "describe_view",
      description: "List a view's columns with their types and descriptions.",
      parameters: {
        type: "object",
        properties: { view: { type: "string", description: "View name, e.g. listings" } },
        required: ["view"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sample_values",
      description: "Show the most common stored values of a column with their counts, optionally only values containing a search text. Use it to find exact names, codes and statuses.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string" },
          column: { type: "string" },
          search: { type: "string", description: "Optional: case-insensitive text the value must contain" },
        },
        required: ["view", "column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description: `Run one read-only PostgreSQL SELECT and see the result (first ${ROWS_SHOWN} rows, total row count up to 200).`,
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_answer",
      description: "Finish: give the final SQL that answers the question and a short plain-English answer based on its result. Use sql null when the question cannot or must not be answered from the data.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: ["string", "null"], description: "The final SELECT, or null" },
          answer: { type: "string" },
        },
        required: ["sql", "answer"],
      },
    },
  },
] as const;

export type ToolOutcome = {
  content: string; // what the model sees
  sqlError?: boolean;
  ok?: { sql: string; result: SqlResult }; // SQL that ran successfully in this call
  done?: { sql: string | null; answer: string; result: SqlResult | null };
};

function view(name: unknown, role: DbRole) {
  return SCHEMA_CARD.find((v) => v.name === name && v.roles.includes(role));
}

function unknownView(name: unknown, role: DbRole) {
  const names = SCHEMA_CARD.filter((v) => v.roles.includes(role)).map((v) => v.name);
  return JSON.stringify({ error: `Unknown view "${String(name)}". Views you can query: ${names.join(", ")}.` });
}

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

export async function executeTool(call: ToolCall, role: DbRole): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { content: JSON.stringify({ error: "Arguments were not valid JSON." }) };
  }

  switch (call.function.name) {
    case "describe_view": {
      const v = view(args.view, role);
      if (!v) return { content: unknownView(args.view, role) };
      return { content: JSON.stringify({ view: v.name, description: v.description, columns: v.columns }) };
    }

    case "sample_values": {
      const v = view(args.view, role);
      if (!v) return { content: unknownView(args.view, role) };
      const column = v.columns.find((c) => c.name === args.column);
      if (!column) {
        return { content: JSON.stringify({ error: `View ${v.name} has no column "${String(args.column)}". Columns: ${v.columns.map((c) => c.name).join(", ")}.` }) };
      }
      // Identifiers come from the schema card, never from the model's text
      const search = typeof args.search === "string" && args.search.trim() ? `%${args.search.trim()}%` : null;
      const sql = `select "${column.name}" as value, count(*) as n from nlq."${v.name}" where "${column.name}" is not null${search ? ` and "${column.name}"::text ilike $1` : ""} group by 1 order by 2 desc, 1 limit 25`;
      return { content: forModel(await runSelect(sql, role, search ? [search] : [])) };
    }

    case "run_sql": {
      if (typeof args.sql !== "string") return { content: JSON.stringify({ error: "sql must be a string." }), sqlError: true };
      const result = await runSelect(args.sql, role);
      return { content: forModel(result), sqlError: !result.ok, ok: result.ok ? { sql: args.sql, result } : undefined };
    }

    case "submit_answer": {
      const answer = typeof args.answer === "string" ? args.answer : "";
      if (args.sql === null || args.sql === undefined || args.sql === "") {
        return { content: JSON.stringify({ ok: true }), done: { sql: null, answer, result: null } };
      }
      if (typeof args.sql !== "string") return { content: JSON.stringify({ error: "sql must be a string or null." }) };
      // The final SQL must run; if it doesn't, the model gets the error and keeps going
      const result = await runSelect(args.sql, role);
      if (!result.ok) return { content: JSON.stringify({ error: `Final SQL failed: ${result.error}` }), sqlError: true };
      return { content: JSON.stringify({ ok: true }), done: { sql: args.sql, answer, result } };
    }

    default:
      return { content: JSON.stringify({ error: `Unknown tool ${call.function.name}.` }) };
  }
}
