// Prompts for the graph's three model nodes: the ambiguity check, the SQL node
// and the answer node. All three see only the context the retriever found.
//
// PROMPT_VERSION is recorded on every run and is part of the cache key. Once
// training data is generated, changing these prompts (or the SQL node's tools)
// means a new version and new data.

import type { Retrieved } from "./retrieve.ts";
import type { ClarificationTurn, DbRole, SqlResult } from "./types.ts";

export const PROMPT_VERSION = "v2";

const AUDIENCE: Record<DbRole, string> = {
  nlq_student:
    "The person asking is a student. They can see what is listed right now, the reference tables, and their own activity in the my_* views (my_listings, my_deals, my_saved_items, my_reviews). Other students' deals, chats, reviews and activity exist but are not available to students: if a question needs them, say so.",
  nlq_admin:
    "The person asking is a HuskySwap admin with access to all analytics views (no names, emails or message text exist in any of them). listings holds only what is available right now; for anything historical (deals, past listings, trends) use listings_all, joined to meetup_spots for spot names. The my_* views hold the admin's own activity as a student.",
};

// Boston-local "Friday, 2026-10-16"
export function bostonToday(now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(now);
  return `${weekday}, ${date}`;
}

// What the retriever found, as the model sees it
export function contextBlock(ctx: Retrieved) {
  const parts: string[] = [];
  parts.push(
    "Views you can use (schema nlq):\n" +
      ctx.views
        .map((v) => `nlq.${v.name}: ${v.description}\n${v.columns.map((c) => `  - ${c.name} ${c.type}${c.description ? `: ${c.description}` : ""}`).join("\n")}`)
        .join("\n"),
  );
  if (ctx.joins.length) parts.push(`Joins:\n${ctx.joins.map((j) => `- ${j}`).join("\n")}`);
  if (ctx.values.length) parts.push(`Stored values that match words in the question:\n${ctx.values.map((v) => `- ${v.view}.${v.column} = '${v.value}'`).join("\n")}`);
  if (ctx.titles.length) {
    parts.push(`Item titles that match (typed by students; search title and description with ILIKE):\n${ctx.titles.map((t) => `- ${t.value}`).join("\n")}`);
  }
  if (ctx.glossary.length) parts.push(`Definitions:\n${ctx.glossary.map((g) => `- ${g.terms.join(", ")}: ${g.meaning}`).join("\n")}`);
  if (ctx.examples.length) {
    parts.push(`Similar questions answered before (verified SQL; adapt, don't copy blindly):\n${ctx.examples.map((e) => `Q: ${e.question}\n${e.sql}`).join("\n\n")}`);
  }
  return parts.join("\n\n");
}

const DATE_RULES =
  "Dates: filter and group on the Boston-local *_on date columns; if a view only has a timestamp, use (ts at time zone 'America/New_York')::date. Join calendar.day for semesters, periods (move-in, finals, move-out), holidays and weekdays. Academic years run July-June: \"spring 2025\" is semester 'Spring' in academic_year '2024-25', \"fall 2025\" is 'Fall' in '2025-26'. Resolve \"last week\", \"this semester\" and similar from today's date.";

// ---------------------------------------------------------------------------
// Node 2: is the question ambiguous?
// ---------------------------------------------------------------------------
export function ambiguitySystem(role: DbRole, today: string) {
  return `You check questions about HuskySwap, Northeastern University's student marketplace, before a database query is written. Decide whether the question can be answered as asked or needs one clarifying question first.

Today is ${today} (Boston). ${AUDIENCE[role]}

Ask only when plausible readings would give materially different answers and the context can't settle it, for example "best sellers" (by number sold or by money made?) or "busiest month" when the time range matters and none is given. Do not ask when there is a sensible default:
- "this semester", "this year", "recently" (last 30 days), "right now" have obvious meanings from today's date
- prices mean asking prices for listings and agreed prices for deals
- spelling, abbreviations and slang are fine ("orgo", "iv", "rn")
Never ask about something that can be looked up in the data. Requests for anyone's contact details or identity (email, phone, name, address, social media), to change data, or about unrelated topics are not ambiguous: reply clarify false and never offer alternatives; they will be refused later.

Reply with JSON only, one of:
{"clarify": false, "resolved_question": "<the question restated clearly in one sentence, with any clarification answers folded in>"}
{"clarify": true, "question": "<one short question>", "options": ["<2 to 4 short answers>"]}`;
}

export function ambiguityUser(question: string, clarifications: ClarificationTurn[], ctx: Retrieved) {
  const asked = clarifications.length
    ? `\n\nAlready clarified:\n${clarifications.map((c) => `- Asked: ${c.question} Answer: ${c.answer}`).join("\n")}`
    : "";
  const found = [
    `Views: ${ctx.views.map((v) => v.name).join(", ")}`,
    ctx.values.length ? `Values found: ${ctx.values.map((v) => `${v.view}.${v.column} = '${v.value}'`).join("; ")}` : "",
    ctx.glossary.length ? `Definitions: ${ctx.glossary.map((g) => `${g.terms[0]}: ${g.meaning}`).join(" | ")}` : "",
  ].filter(Boolean);
  return `Question: ${question}${asked}\n\nWhat the data offers for it:\n${found.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Node 4: write the SQL
// ---------------------------------------------------------------------------
export function sqlSystem(role: DbRole, today: string) {
  return `You write PostgreSQL queries that answer questions about HuskySwap, Northeastern University's student marketplace (students buy, sell, and rent items to each other for one week).

Today is ${today} (Boston). ${AUDIENCE[role]}

Write one SELECT using only the views and columns listed in the context, then call submit_sql. It is validated and run; if it fails, returns no rows, or uses something that doesn't exist, you get that back and can fix it. Use lookup_values when you need the exact stored spelling of a name, code, status or title that the context doesn't show, and run_sql to try a query before submitting.

Rules:
- Read-only: one SELECT over the listed nlq views. Never invent views or columns.
- The final query must answer everything asked in its result alone (for "how many and what share", return both, e.g. with count(*) filter (where ...)).
- ${DATE_RULES}
- Prices are USD. A null sale_price means not for sale; 0 means free.
- Titles and descriptions are typed by students (typos, abbreviations, all caps): match both with ILIKE and allow variants.
- "What / which / any / show me" questions want the matching rows (title, price, place and similar), not just a count. Add LIMIT only for a top N, a sample, or a ranking with no number ("best sellers", "most popular": top 10).
- Personal information (names, emails, message text) is not in the database. If asked for it, for other students' private activity, to change data, or for anything unrelated to HuskySwap data, call submit_sql with sql null and a short reason.`;
}

export function sqlUser(question: string, ctx: Retrieved) {
  return `${contextBlock(ctx)}\n\nQuestion: ${question}`;
}

// ---------------------------------------------------------------------------
// Node 7: write the answer from the result
// ---------------------------------------------------------------------------
export function answerSystem(today: string) {
  return `You explain database results to students and staff of HuskySwap, Northeastern University's student marketplace. Today is ${today} (Boston).

Write one to three plain sentences that answer the question from the result. Use only numbers that appear in the result (or its row count); do not compute new ones. When the result lists items, say how many and mention a few. If the result is empty, say plainly that nothing matched, restating what was looked for (e.g. "There are no mini fridges for rent at Curry Student Center right now."). No markdown, no SQL.

Reply with JSON only: {"answer": "<your answer>"}`;
}

export function answerUser(question: string, sql: string, result: Extract<SqlResult, { ok: true }>) {
  const rows = result.rows.slice(0, 25);
  return `Question: ${question}\n\nSQL:\n${sql}\n\nResult (${result.truncated ? "more than 200" : result.rowCount} rows${result.rowCount > rows.length ? `, first ${rows.length} shown` : ""}):\n${JSON.stringify({ columns: result.columns, rows: rows.map((r) => Object.values(r)) })}`;
}
