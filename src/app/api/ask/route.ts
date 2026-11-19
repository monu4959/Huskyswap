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
//
// Limits per student: one question at a time, PER_MINUTE and PER_DAY. A slot is
// reserved in ops.ask_quota before the run starts (src/lib/agent/log.ts), so
// parallel requests can't slip past the limits. If the client disconnects, the
// run stops before its next model call.

import { askerFrom } from "@/lib/agent/auth";
import { runAgent, type GraphEvent } from "@/lib/agent/graph";
import type { ModelConfig } from "@/lib/agent/llm";
import { finishAsk, reserveAsk } from "@/lib/agent/log";
import { scrubDetail } from "@/lib/agent/privacy";
import { fallback, markDown, route } from "@/lib/agent/serving";
import type { AgentRun, Clarification, ClarificationTurn } from "@/lib/agent/types";

// The free teacher tier rate-limits per minute, so one question can take a while
export const maxDuration = 120;

const PER_MINUTE = 3;
const PER_DAY = 40;
const ROWS_SENT = 50;

// Node details carry guard and database messages, which can quote row values: masked and cut short
function nodeEvent(e: GraphEvent): AskNode {
  return { type: "node", ...e, ...(e.detail !== undefined ? { detail: scrubDetail(e.detail) } : {}) };
}

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
    // An answer shows its SQL, and so does a give-up whose query ran but found nothing
    sql: run.status === "answered" || (run.status === "gave_up" && run.result?.ok && run.result.rowCount === 0) ? run.finalSql : null,
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

  let reservation;
  try {
    reservation = await reserveAsk(asker.userId, { perMinute: PER_MINUTE, perDay: PER_DAY });
  } catch (e) {
    console.error("ask: couldn't reserve a slot:", e);
    return Response.json({ error: "The assistant is unavailable right now. Try again in a minute." }, { status: 503 });
  }
  if (!reservation.ok) {
    const error = { busy: "One question at a time: wait for the current answer.", minute: "One moment: try again in a minute.", day: "That's today's limit. Ask again tomorrow." }[reservation.reason];
    return Response.json({ error }, { status: 429 });
  }
  const slot = reservation.id;
  const signal = request.signal;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Once the client has gone, writes fail: drop them and let the run notice the abort
      const send = (event: AskNode | AskDone) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // stream closed or cancelled
        }
      };
      const ask = (model: ModelConfig) =>
        runAgent({ question, clarifications, role: asker.role, source: "app", userId: asker.userId, model, signal, onEvent: (e) => send(nodeEvent(e)) });
      let run: AgentRun | null = null;
      try {
        const chosen = await route(asker.userId).catch((e) => fallback(`routing failed: ${e.message}`));
        run = await ask(chosen.model);
        // The student's server went down mid-run: answer with the teacher instead (not if the client left)
        if (run.status === "error" && chosen.arm !== "fallback" && !signal.aborted) {
          markDown(chosen.model);
          run = await ask(fallback(`${chosen.modelId} failed: ${run.error}`).model);
        }
        send(doneEvent(run));
      } finally {
        await finishAsk(slot, run?.runId ?? null).catch((e) => console.error("ask: couldn't finish the reservation:", e));
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
