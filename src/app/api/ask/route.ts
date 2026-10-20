// POST /api/ask  { question }  ->  a stream of newline-delimited JSON events
//
//   {"type":"step", ...}   one per tool call / result, for the progress list
//   {"type":"done", ...}   the answer, the SQL and its result (first 50 rows)
//
// The signed-in student's role decides what the agent can query (see
// src/lib/agent/auth.ts). Every question is logged in ops.agent_runs.

import { askerFrom } from "@/lib/agent/auth";
import { recentAppRuns } from "@/lib/agent/log";
import { runAgent, type StepEvent } from "@/lib/agent/run";
import type { AgentRun } from "@/lib/agent/types";

// The free teacher tier rate-limits per minute, so one question can take a while
export const maxDuration = 120;

const PER_MINUTE = 3;
const PER_DAY = 40;
const ROWS_SENT = 50;

export type AskStep = {
  type: "step";
  step: number;
  tool: string;
  phase: "call" | "result";
  args?: Record<string, unknown>;
  ok?: boolean;
};

export type AskDone = {
  type: "done";
  runId: string | null;
  status: AgentRun["status"];
  answer: string | null;
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  steps: number;
  latencyMs: number;
  error: string | null;
};

function stepEvent(e: StepEvent): AskStep | null {
  if (e.type === "tool_call") {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(e.args || "{}");
    } catch {}
    return { type: "step", step: e.step, tool: e.name, phase: "call", args };
  }
  if (e.type === "tool_result") {
    return { type: "step", step: e.step, tool: e.name, phase: "result", ok: !e.content.startsWith('{"error"') };
  }
  return null;
}

function doneEvent(run: AgentRun): AskDone {
  const result = run.result?.ok ? run.result : null;
  return {
    type: "done",
    runId: run.runId,
    status: run.status,
    answer: run.answer,
    sql: run.finalSql,
    columns: result?.columns ?? [],
    rows: result?.rows.slice(0, ROWS_SENT) ?? [],
    rowCount: result?.rowCount ?? 0,
    truncated: result?.truncated ?? false,
    steps: run.steps,
    latencyMs: run.latencyMs,
    error: run.status === "error" ? "The assistant couldn't finish this one. Try again in a minute." : null,
  };
}

export async function POST(request: Request) {
  const asker = await askerFrom(request);
  if (asker instanceof Response) return asker;

  const body = (await request.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length < 3 || question.length > 500) {
    return Response.json({ error: "Ask a question between 3 and 500 characters." }, { status: 400 });
  }

  const recent = await recentAppRuns(asker.userId);
  if (recent.minute >= PER_MINUTE) return Response.json({ error: "One moment: try again in a minute." }, { status: 429 });
  if (recent.day >= PER_DAY) return Response.json({ error: "That's today's limit. Ask again tomorrow." }, { status: 429 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AskStep | AskDone) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const run = await runAgent({
        question,
        role: asker.role,
        source: "app",
        userId: asker.userId,
        onStep(e) {
          const event = stepEvent(e);
          if (event) send(event);
        },
      });
      send(doneEvent(run));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
