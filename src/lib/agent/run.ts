// The agent loop: question -> model -> tool calls -> results -> ... -> submit_answer.
//
// The same loop serves the app, the CLI, training-data generation and evals,
// so the student model later sees exactly the prompts and tools the teacher saw.

import { chat, teacherConfig, type ModelConfig } from "./llm.ts";
import { logRun, type RunMeta } from "./log.ts";
import { PROMPT_VERSION, bostonToday, systemPrompt } from "./prompt.ts";
import { SCHEMA_HASH } from "./schema-card.ts";
import { TOOLS, executeTool, type ToolOutcome } from "./tools.ts";
import type { AgentRun, ChatMessage, DbRole, SqlResult } from "./types.ts";

export const MAX_STEPS = 8;

const SUBMIT_ONLY = TOOLS.filter((t) => t.function.name === "submit_answer");

// A plain-text final reply sometimes holds submit_answer's JSON or pastes the
// SQL after the answer; keep just the answer text.
function plainAnswer(content: string | null) {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.answer === "string") return parsed.answer;
  } catch {}
  return content.replace(/```[\s\S]*?```/g, "").replace(/\n+\s*\**SQL( used)?\**:?[\s\S]*$/i, "").trim() || null;
}

export type StepEvent =
  | { type: "thinking"; step: number }
  | { type: "tool_call"; step: number; name: string; args: string }
  | { type: "tool_result"; step: number; name: string; content: string };

export type RunOptions = {
  question: string;
  role: DbRole;
  source: RunMeta["source"];
  userId?: string | null;
  model?: ModelConfig;
  today?: string; // fixed date for reproducible data generation and evals
  log?: boolean; // write to ops.agent_runs (default true)
  onStep?: (event: StepEvent) => void;
};

export async function runAgent(opts: RunOptions): Promise<AgentRun> {
  const model = opts.model ?? teacherConfig();
  const started = performance.now();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(opts.role, opts.today ?? bostonToday()) },
    { role: "user", content: opts.question },
  ];
  const run: AgentRun = {
    runId: null,
    question: opts.question,
    role: opts.role,
    status: "gave_up",
    answer: null,
    finalSql: null,
    result: null,
    messages,
    reasoning: [],
    steps: 0,
    sqlErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    stepLatencyMs: [],
    error: null,
  };

  let lastOk: { sql: string; result: SqlResult } | null = null;
  try {
    steps: for (let step = 1; step <= MAX_STEPS; step++) {
      run.steps = step;
      opts.onStep?.({ type: "thinking", step });
      const t0 = performance.now();
      // Last step: only submit_answer is offered. If the model still won't submit,
      // end with the last query that ran (status stays gave_up).
      const last = step === MAX_STEPS;
      let reply;
      try {
        reply = await chat(model, messages, last ? SUBMIT_ONLY : TOOLS, last);
      } catch (e) {
        if (!last) throw e;
        run.finalSql = lastOk?.sql ?? null;
        run.result = lastOk?.result ?? null;
        break;
      }
      run.stepLatencyMs.push(Math.round(performance.now() - t0));
      run.promptTokens += reply.promptTokens;
      run.completionTokens += reply.completionTokens;
      run.reasoning.push(reply.reasoning);
      messages.push({
        role: "assistant",
        content: reply.content,
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
      });

      // Answered in plain text without submit_answer: accept it, with the last SQL that ran
      if (!reply.toolCalls.length) {
        run.answer = plainAnswer(reply.content);
        run.finalSql = lastOk?.sql ?? null;
        run.result = lastOk?.result ?? null;
        run.status = reply.content ? "answered" : "gave_up";
        break;
      }

      let done = false;
      for (const call of reply.toolCalls) {
        opts.onStep?.({ type: "tool_call", step, name: call.function.name, args: call.function.arguments });
        // Every tool call needs a reply; calls after submit_answer in the same turn are skipped
        const outcome: ToolOutcome = done
          ? { content: JSON.stringify({ error: "Skipped: answer already submitted." }) }
          : await executeTool(call, opts.role);
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
        opts.onStep?.({ type: "tool_result", step, name: call.function.name, content: outcome.content });
        if (outcome.sqlError) run.sqlErrors++;
        if (outcome.ok) lastOk = outcome.ok;
        if (outcome.done && !done) {
          done = true;
          run.finalSql = outcome.done.sql;
          run.answer = outcome.done.answer;
          run.result = outcome.done.result;
          run.status = outcome.done.sql ? "answered" : "refused";
        }
      }
      if (done) break steps;
    }
  } catch (e) {
    run.status = "error";
    run.error = (e as Error).message;
  }
  run.latencyMs = Math.round(performance.now() - started);

  if (opts.log !== false) {
    try {
      run.runId = await logRun(run, {
        source: opts.source,
        userId: opts.userId,
        model: model.label,
        modelVersion: model.version,
        promptVersion: PROMPT_VERSION,
        schemaHash: SCHEMA_HASH,
      });
    } catch (e) {
      run.error = [run.error, `log failed: ${(e as Error).message}`].filter(Boolean).join("; ");
    }
  }
  return run;
}
