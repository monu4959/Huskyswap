// Writes finished runs to ops.agent_runs. Uses the admin connection
// (DATABASE_URL): the nlq_agent login can't write anything, by design.

import { opsPool as getPool } from "./ops-db.ts";
import type { AgentRun } from "./types.ts";

// Per-student limits for /api/ask, enforced by reserving a row in ops.ask_quota
// BEFORE the run starts (supabase/migrations/0009_hardening.sql). The check and
// the insert happen under a per-user advisory lock, so parallel requests can't
// all pass; a run that crashes or is killed still counts, because its row exists.
export type AskLimits = { perMinute: number; perDay: number };
export type Reservation = { ok: true; id: string } | { ok: false; reason: "busy" | "minute" | "day" };

// A reservation still open after this long belongs to a run that was killed
// (the route's maxDuration is 120 s): it stops blocking new questions but still counts.
export const IN_FLIGHT_MS = 150_000;

export async function reserveAsk(userId: string, limits: AskLimits): Promise<Reservation> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    // Transaction-scoped, so it works through the transaction pooler too
    await client.query("select pg_advisory_xact_lock(hashtext('ask_quota'), hashtext($1))", [userId]);
    const { rows: [n] } = await client.query<{ running: number; minute: number; day: number }>(
      `select count(*) filter (where finished_at is null and started_at > now() - make_interval(secs => $2))::int as running,
              count(*) filter (where started_at > now() - interval '1 minute')::int as minute,
              count(*)::int as day
       from ops.ask_quota where user_id = $1 and started_at > now() - interval '1 day'`,
      [userId, IN_FLIGHT_MS / 1000],
    );
    const reason = n.running > 0 ? "busy" : n.minute >= limits.perMinute ? "minute" : n.day >= limits.perDay ? "day" : null;
    if (reason) {
      await client.query("rollback");
      return { ok: false, reason };
    }
    const { rows: [row] } = await client.query<{ id: string }>("insert into ops.ask_quota (user_id) values ($1) returning id::text", [userId]);
    // Old rows of this student are no longer needed for any window
    await client.query("delete from ops.ask_quota where user_id = $1 and started_at < now() - interval '2 days'", [userId]);
    await client.query("commit");
    return { ok: true, id: row.id };
  } catch (e) {
    broken = e as Error;
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release(broken);
  }
}

// The run behind a reservation ended (answered, failed or cancelled)
export async function finishAsk(id: string, runId: string | null): Promise<void> {
  await getPool().query("update ops.ask_quota set finished_at = now(), run_id = $2 where id = $1", [id, runId]);
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
