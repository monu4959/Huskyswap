// A tiny OpenAI-compatible chat server for load tests: the assistant (/api/ask)
// runs its full graph (cache, retrieve, clarify, SQL, guard, execute, answer)
// without ever calling a real model.
//
//   node scripts/llm-stub.mjs [--port 8787] [--min-ms 1000] [--max-ms 3000]
//
//   POST /v1/chat/completions   answers the three kinds of calls the graph makes:
//     clarify (JSON, "You check questions ...")       -> {"clarify": false}
//     SQL node (tools offered)                          -> a submit_sql tool call on nlq.listings
//     answer (JSON, "You explain database results ...") -> one sentence using only numbers from the result
//   GET  /v1/models                lists the "stub" model
//   GET  /stats                    request counters (to prove the app really called the stub)
//
// Start the app with TEACHER_BASE_URL=http://127.0.0.1:<port>/v1 TEACHER_MODEL=stub TEACHER_API_KEY=stub.
// See src/lib/agent/{llm,clarify,sql-node,answer}.ts for what each reply must look like.

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    "min-ms": { type: "string", default: "1000" },
    "max-ms": { type: "string", default: "3000" },
  },
});
const PORT = Number(args.port);
const MIN_MS = Number(args["min-ms"]);
const MAX_MS = Number(args["max-ms"]);

const stats = { started: new Date().toISOString(), requests: 0, byKind: {}, errors: 0, inFlight: 0, maxInFlight: 0, models: 0 };
const count = (kind) => (stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => MIN_MS + Math.random() * (MAX_MS - MIN_MS);
const tokens = (text) => Math.ceil(text.length / 4); // rough, like a real tokenizer's order of magnitude

// The question the SQL node is answering ("Question to answer: ...")
function questionOf(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  return /Question to answer:\s*(.+)/.exec(user)?.[1]?.trim() ?? /Question:\s*(.+)/.exec(user)?.[1]?.trim() ?? "";
}

// "under $40", "less than 25 dollars": a price cap from the question, if any
function capOf(question) {
  const m = /(?:under|below|less than|at most|cheaper than)\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(question);
  return m ? Number(m[1]) : null;
}

function sqlFor(question) {
  const cap = capOf(question);
  const rent = /\b(rent|rental|borrow)\b/i.test(question);
  const col = rent ? "rent_price_per_week" : "sale_price";
  const where = [`${col} is not null`, ...(cap !== null ? [`${col} <= ${cap}`] : [])].join(" and ");
  return `select title, ${col}, meetup_spot from listings where ${where} order by ${col}, item_id limit 5`;
}

function toolCallReply(messages) {
  const question = questionOf(messages);
  const tools = messages.filter((m) => m.role === "tool").map((m) => m.content);
  const last = tools.at(-1) ?? "";
  let sql = sqlFor(question);
  // Rejected or failed: fall back to the plainest possible query
  if (/Not accepted|error/i.test(last)) sql = "select title, sale_price from listings where sale_price is not null order by sale_price, item_id limit 5";
  // An empty result is questioned once: confirm it by resubmitting the same SQL (sql-node.ts)
  return {
    content: null,
    tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: "submit_sql", arguments: JSON.stringify({ sql }) } }],
  };
}

// Answer from "Result (N rows...):\n{"columns": [...], "rows": [[...], ...]}" (prompt.ts answerUser)
function answerReply(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const json = /Result \([^)]*\):\n(\{[\s\S]*\})\s*$/.exec(user)?.[1];
  let parsed = null;
  try {
    parsed = json ? JSON.parse(json) : null;
  } catch {}
  const rows = parsed?.rows ?? [];
  if (!rows.length) return { content: JSON.stringify({ answer: "Nothing matched what you asked for right now." }) };
  const [title, price] = rows[0];
  const answer = `The cheapest match is "${title}" at $${price}, and the table shows ${rows.length} listing${rows.length === 1 ? "" : "s"} like it.`;
  return { content: JSON.stringify({ answer }) };
}

function reply(body) {
  const messages = body.messages ?? [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (Array.isArray(body.tools) && body.tools.length) return ["sql", toolCallReply(messages)];
  if (system.startsWith("You check questions")) return ["clarify", { content: JSON.stringify({ clarify: false }) }];
  if (system.startsWith("You explain database results")) return ["answer", answerReply(messages)];
  return ["other", { content: JSON.stringify({ answer: "ok" }) }];
}

const server = createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === "GET" && req.url === "/stats") return send(200, stats);
    if (req.method === "GET" && req.url?.replace(/\/$/, "").endsWith("/models")) {
      stats.models++;
      return send(200, { object: "list", data: [{ id: "stub", object: "model" }] });
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return send(404, { error: { message: "not found" } });

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    stats.requests++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const [kind, message] = reply(body);
    count(kind);
    await sleep(latency());
    stats.inFlight--;
    const prompt = tokens(raw);
    send(200, {
      id: `chatcmpl-stub-${stats.requests}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "stub",
      choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", ...message } }],
      usage: { prompt_tokens: prompt, completion_tokens: 60, total_tokens: prompt + 60 },
    });
  } catch (e) {
    stats.errors++;
    stats.inFlight = Math.max(0, stats.inFlight - 1);
    send(500, { error: { message: e.message } });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`[llm-stub] listening on http://127.0.0.1:${PORT}/v1 (latency ${MIN_MS}-${MAX_MS} ms)`));
