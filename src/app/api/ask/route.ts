// POST /api/ask  { question, clarifications? }  ->  a stream of newline-delimited JSON events
//
//   {"type":"node", ...}   progress through the graph (cache, retrieve, clarify, sql, validate, execute, answer)
//   {"type":"done", ...}   the answer, the SQL and its result (first 50 rows), or a clarifying question
//
// clarifications: earlier clarifying questions in this conversation and the
// user's answers, sent back with the original question.
//
// The signed-in student's role decides what the agent can query, and their id
// scopes the my_* views (see src/lib/agent/auth.ts). The model comes from the
// registry (src/lib/agent/serving.ts): production, a canary candidate, or the
// teacher when the student's server is down. Every question is logged in
// ops.agent_runs.

import { askerFrom } from "@/lib/agent/auth";
import { runAgent, type GraphEvent } from "@/lib/agent/graph";
import type { ModelConfig } from "@/lib/agent/llm";
import { recentAppRuns } from "@/lib/agent/log";
import { fallback, markDown, route } from "@/lib/agent/serving";
import type { AgentRun, Clarification, ClarificationTurn } from "@/lib/agent/types";

// The free teacher tier rate-limits per minute, so one question can take a while
export const maxDuration = 120;

const PER_MINUTE = 3;
const PER_DAY = 40;
const ROWS_SENT = 50;

export type AskNode = { type: "node" } & GraphEvent;

export type AskDone = {
  type: "done";
  runId: string | null;
  status: AgentRun["status"];
  answer: string | null;
  clarification: Clarification | null;
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  cacheHit: boolean;
  modelCalls: number;
  latencyMs: number;
  error: string | null;
};

function doneEvent(run: AgentRun): AskDone {
  // Only an answered run shows its result
  const result = run.status === "answered" && run.result?.ok ? run.result : null;
  return {
    type: "done",
    runId: run.runId,
    status: run.status,
    answer: run.answer,
    clarification: run.clarification,
    sql: run.status === "answered" ? run.finalSql : null,
    columns: result?.columns ?? [],
    rows: result?.rows.slice(0, ROWS_SENT) ?? [],
    rowCount: result?.rowCount ?? 0,
    truncated: result?.truncated ?? false,
    cacheHit: run.cacheHit,
    modelCalls: run.calls.length,
    latencyMs: run.latencyMs,
    error: run.status === "error" ? "The assistant couldn't finish this one. Try again in a minute." : null,
  };
}

function clarificationsFrom(value: unknown): ClarificationTurn[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return null;
  const turns = value.map((t) => ({ question: String(t?.question ?? "").slice(0, 300), answer: String(t?.answer ?? "").slice(0, 300) }));
  return turns.every((t) => t.question && t.answer) ? turns : null;
}

export async function POST(request: Request) {
  const asker = await askerFrom(request);
  if (asker instanceof Response) return asker;

  const body = (await request.json().catch(() => null)) as { question?: unknown; clarifications?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const clarifications = clarificationsFrom(body?.clarifications);
  if (question.length < 3 || question.length > 500 || !clarifications) {
    return Response.json({ error: "Ask a question between 3 and 500 characters." }, { status: 400 });
  }

  const recent = await recentAppRuns(asker.userId);
  if (recent.minute >= PER_MINUTE) return Response.json({ error: "One moment: try again in a minute." }, { status: 429 });
  if (recent.day >= PER_DAY) return Response.json({ error: "That's today's limit. Ask again tomorrow." }, { status: 429 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AskNode | AskDone) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const ask = (model: ModelConfig) =>
        runAgent({ question, clarifications, role: asker.role, source: "app", userId: asker.userId, model, onEvent: (e) => send({ type: "node", ...e }) });
      const chosen = await route(asker.userId).catch((e) => fallback(`routing failed: ${e.message}`));
      let run = await ask(chosen.model);
      // The student's server went down mid-run: answer with the teacher instead
      if (run.status === "error" && chosen.arm !== "fallback") {
        markDown(chosen.model);
        run = await ask(fallback(`${chosen.modelId} failed: ${run.error}`).model);
      }
      send(doneEvent(run));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
