// The agent as an explicit graph:
//
//   question
//     -> [1] semantic cache ----------------------------- hit -> re-run stored SQL -> answer
//     -> [3] context retriever (views, values, glossary, examples; no model)
//     -> [2] ambiguous? (sees what [3] found) ------------ yes -> clarifying question to the user
//     -> [4] SQL node -> [5] guardrails -> [6] execute --- error / empty -> back to [4]
//     -> [7] answer + grounding check -> stored in the cache
//
// Limits: each node has its own (see sql-node.ts, clarify.ts, answer.ts), and
// the whole run has RUN_BUDGET (tokens and time). The same graph serves the
// app, the CLI, training-data generation and evals, so the student model later
// sees exactly the prompts the teacher saw.

import { writeAnswer } from "./answer.ts";
import { cacheLookup, cacheStore, resultHash, type CacheHit } from "./cache.ts";
import { checkAmbiguity } from "./clarify.ts";
import { runSelect } from "./db.ts";
import { embed } from "./embed.ts";
import { chat, teacherConfig, type ChatResult, type ModelConfig } from "./llm.ts";
import { logRun, type RunMeta } from "./log.ts";
import { scrubText } from "./privacy.ts";
import { PROMPT_VERSION, bostonToday } from "./prompt.ts";
import { retrieve, summarize } from "./retrieve.ts";
import { SCHEMA_HASH } from "./schema-card.ts";
import { SEMANTIC_VERSION } from "./semantic-layer.ts";
import { sqlNode } from "./sql-node.ts";
import type { AgentRun, ChatMessage, ClarificationTurn, DbRole, NodeName } from "./types.ts";

// Time counts work, not waiting out rate limits (the app is still capped by the
// API route's 120 s maxDuration)
export const RUN_BUDGET = { tokens: 30_000, ms: 110_000, waitMs: 120_000 };

export type GraphEvent = {
  node: NodeName | "validate" | "execute";
  status: "start" | "done" | "hit" | "miss" | "error";
  detail?: string;
};

export type RunOptions = {
  question: string;
  role: DbRole;
  source: RunMeta["source"];
  userId?: string | null; // the signed-in student (app only), for the my_* views
  clarifications?: ClarificationTurn[]; // earlier clarifying questions and the user's answers
  model?: ModelConfig;
  today?: string; // fixed date for reproducible data generation and evals
  log?: boolean; // write to ops.agent_runs (default true)
  useCache?: boolean; // default: on for the app and CLI, off for datagen/eval/test
  useExamples?: boolean; // retrieve verified examples (default true)
  onEvent?: (event: GraphEvent) => void;
};

class BudgetExceeded extends Error {}

const GAVE_UP = "I couldn't work out a reliable query for that. Try rephrasing it or narrowing it down.";

export async function runAgent(opts: RunOptions): Promise<AgentRun> {
  const model = opts.model ?? teacherConfig();
  const started = performance.now();
  const today = opts.today ?? bostonToday();
  const userId = opts.userId ?? null;
  const clarifications = opts.clarifications ?? [];
  const useCache = opts.useCache ?? (opts.source === "app" || opts.source === "cli");
  const emit = (e: GraphEvent) => opts.onEvent?.(e);

  const run: AgentRun = {
    runId: null, question: opts.question, resolvedQuestion: null, role: opts.role, status: "gave_up",
    answer: null, finalSql: null, result: null, clarification: null, cacheHit: false, grounded: null,
    retrieval: null, nodes: [], calls: [], messages: [], sqlErrors: 0, promptTokens: 0, completionTokens: 0,
    latencyMs: 0, error: null,
  };

  // Run one node: timed, reported, recorded
  async function node<T>(name: NodeName, fn: () => Promise<T>, outcome: (value: T) => string): Promise<T> {
    emit({ node: name, status: "start" });
    const t0 = performance.now();
    const value = await fn();
    const text = outcome(value);
    run.nodes.push({ node: name, ms: Math.round(performance.now() - t0), outcome: text });
    emit({ node: name, status: text.startsWith("hit") ? "hit" : text === "miss" ? "miss" : "done", detail: text });
    return value;
  }

  let waitedMs = 0; // rate-limit waiting, excluded from the time budget

  // A model call made by a node: checked against the run budget and kept whole
  const caller =
    (name: NodeName) =>
    async (messages: ChatMessage[], options: Parameters<typeof chat>[2]): Promise<ChatResult> => {
      if (run.promptTokens + run.completionTokens > RUN_BUDGET.tokens || performance.now() - started - waitedMs > RUN_BUDGET.ms || waitedMs > RUN_BUDGET.waitMs) {
        throw new BudgetExceeded("Run budget exceeded");
      }
      const t0 = performance.now();
      const reply = await chat(model, messages, options);
      run.calls.push({
        node: name,
        messages: [...messages],
        reply: { content: reply.content, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) },
        reasoning: reply.reasoning,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        ms: Math.round(performance.now() - t0),
      });
      run.promptTokens += reply.promptTokens;
      waitedMs += reply.waitedMs;
      run.completionTokens += reply.completionTokens;
      return reply;
    };

  // Serve a cache hit: run the stored SQL on today's data; reuse the answer if the result is unchanged
  async function serve(hit: CacheHit): Promise<boolean> {
    const result = await runSelect(hit.sql, opts.role, [], { userId });
    if (!result.ok) return false; // e.g. the data changed shape: treat as a miss
    run.cacheHit = true;
    run.resolvedQuestion = hit.question;
    run.finalSql = hit.sql;
    run.result = result;
    if (resultHash(result) === hit.resultHash) {
      run.answer = hit.answer;
      run.grounded = true;
    } else {
      const ans = await node("answer", () => writeAnswer({ question: hit.question, sql: hit.sql, result, today, call: caller("answer") }), (a) => (a.grounded ? "grounded" : "ungrounded"));
      run.answer = ans.answer;
      run.grounded = ans.grounded;
    }
    run.status = "answered";
    return true;
  }

  let cacheVector: number[] | null = null; // embedding of the question the cache should store
  try {
    const [vector] = await embed([opts.question]);
    cacheVector = vector;

    // [1] Semantic cache (only for a fresh question; after a clarification, see below)
    if (useCache && !clarifications.length) {
      const hit = await node("cache", () => cacheLookup(opts.question, vector, opts.role, userId), (h) => (h ? `hit ${h.similarity.toFixed(3)}` : "miss"));
      if (hit && (await serve(hit))) return await finish();
    }

    // [3] Context retriever, before the ambiguity decision so that can see what the data offers
    const query = clarifications.length ? `${opts.question} ${clarifications.map((c) => c.answer).join(" ")}` : opts.question;
    const ctx = await node(
      "retrieve",
      () => retrieve(query, opts.role, { vector: clarifications.length ? undefined : vector, examples: opts.useExamples ?? true }),
      (r) => `${r.views.length} views, ${r.values.length} values, ${r.titles.length} titles, ${r.glossary.length} definitions, ${r.examples.length} examples`,
    );
    run.retrieval = summarize(ctx);

    // [2] Ambiguous?
    const amb = await node(
      "clarify",
      () => checkAmbiguity({ question: opts.question, clarifications, ctx, role: opts.role, today, call: caller("clarify") }),
      (a) => (a.clarify ? "asked" : "clear"),
    );
    if (amb.clarify) {
      run.status = "clarify";
      run.clarification = amb.clarify;
      run.answer = amb.clarify.question;
      return await finish();
    }
    // Without clarifications the question stands as asked; with them, the resolved
    // version is what gets answered and cached
    const resolved = clarifications.length ? amb.resolved : opts.question;
    run.resolvedQuestion = resolved;
    if (clarifications.length) {
      [cacheVector] = await embed([resolved]);
      if (useCache) {
        const hit = await node("cache", () => cacheLookup(resolved, cacheVector!, opts.role, userId), (h) => (h ? `hit ${h.similarity.toFixed(3)}` : "miss"));
        if (hit && (await serve(hit))) return await finish();
      }
    }

    // [4]-[6] SQL node with guardrails, execution and the feedback loop
    const sql = await node(
      "sql",
      () =>
        sqlNode({
          question: resolved, ctx, role: opts.role, userId, today, call: caller("sql"),
          onEvent: (e) => emit({ node: e.stage, status: e.ok ? "done" : "error", detail: e.detail }),
        }),
      (s) => `${s.status}, ${s.sqlErrors} failed`,
    );
    run.messages = sql.messages;
    run.sqlErrors = sql.sqlErrors;
    run.finalSql = sql.sql;
    run.result = sql.result;
    if (sql.status === "refused") {
      run.status = "refused";
      run.answer = scrubText(sql.reason ?? "");
      return await finish();
    }
    if (sql.status !== "answered" || !sql.result?.ok) {
      run.status = "gave_up";
      run.answer = GAVE_UP;
      return await finish();
    }

    // [7] Answer + grounding check
    const ans = await node(
      "answer",
      () => writeAnswer({ question: resolved, sql: sql.sql!, result: sql.result as Extract<typeof sql.result, { ok: true }>, today, call: caller("answer") }),
      (a) => (a.grounded ? "grounded" : "ungrounded"),
    );
    run.answer = ans.answer;
    run.grounded = ans.grounded;
    run.status = "answered";
  } catch (e) {
    run.status = e instanceof BudgetExceeded ? "gave_up" : "error";
    run.answer = e instanceof BudgetExceeded ? GAVE_UP : null;
    run.error = (e as Error).message;
  }
  return await finish();

  async function finish() {
    run.latencyMs = Math.round(performance.now() - started);
    if (opts.log !== false) {
      try {
        run.runId = await logRun(run, {
          source: opts.source,
          userId,
          model: model.label,
          modelVersion: model.version,
          promptVersion: `${PROMPT_VERSION}/${SEMANTIC_VERSION}`,
          schemaHash: SCHEMA_HASH,
        });
      } catch (e) {
        run.error = [run.error, `log failed: ${(e as Error).message}`].filter(Boolean).join("; ");
      }
    }
    // Only fresh, grounded answers go into the cache
    if (useCache && run.status === "answered" && !run.cacheHit && run.grounded && run.finalSql && run.result && cacheVector) {
      await cacheStore({
        question: run.resolvedQuestion ?? run.question, vector: cacheVector, role: opts.role, userId,
        sql: run.finalSql, answer: run.answer ?? "", result: run.result, runId: run.runId,
      }).catch((e) => (run.error = [run.error, `cache store failed: ${(e as Error).message}`].filter(Boolean).join("; ")));
    }
    return run;
  }
}
