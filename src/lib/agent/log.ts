// Writes finished runs to ops.agent_runs. Uses the admin connection
// (DATABASE_URL): the nlq_agent login can't write anything, by design.

import { opsPool as getPool } from "./ops-db.ts";
import type { AgentRun } from "./types.ts";

// App questions from this student in the last minute and the last day (rate limits)
export async function recentAppRuns(userId: string): Promise<{ minute: number; day: number }> {
  const { rows } = await getPool().query(
    `select count(*) filter (where created_at > now() - interval '1 minute')::int as minute, count(*)::int as day
     from ops.agent_runs where user_id = $1 and source = 'app' and created_at > now() - interval '1 day'`,
    [userId],
  );
  return rows[0];
}

// Thumbs up (1) / down (-1) on one of this student's own runs
export async function setFeedback(runId: string, userId: string, value: 1 | -1): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "update ops.agent_runs set feedback = $3 where run_id = $1 and user_id = $2",
    [runId, userId, value],
  );
  return rowCount === 1;
}

export type RunMeta = {
  source: "cli" | "app" | "datagen" | "eval" | "test";
  userId?: string | null;
  model: string;
  modelVersion?: string | null;
  promptVersion: string;
  schemaHash: string;
};

export async function logRun(run: AgentRun, meta: RunMeta): Promise<string> {
  const { rows } = await getPool().query(
    `insert into ops.agent_runs (source, user_id, db_role, model, model_version, prompt_version, schema_hash,
       question, messages, reasoning, status, final_sql, answer, result_rows, steps, sql_errors,
       prompt_tokens, completion_tokens, latency_ms, step_latency_ms, error,
       resolved_question, cache_hit, clarification, retrieval, nodes, calls)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $23, $24, $25, $26, $27)
     returning run_id`,
    [
      meta.source, meta.userId ?? null, run.role, meta.model, meta.modelVersion ?? null, meta.promptVersion, meta.schemaHash,
      run.question, JSON.stringify(run.messages), JSON.stringify(run.calls.map((c) => c.reasoning)), run.status, run.finalSql, run.answer,
      run.result?.ok ? run.result.rowCount : null, run.calls.length, run.sqlErrors,
      run.promptTokens, run.completionTokens, run.latencyMs, run.calls.map((c) => c.ms), run.error,
      run.resolvedQuestion, run.cacheHit, run.clarification ? JSON.stringify(run.clarification) : null,
      run.retrieval ? JSON.stringify(run.retrieval) : null, JSON.stringify(run.nodes), JSON.stringify(run.calls),
    ],
  );
  return rows[0].run_id;
}
