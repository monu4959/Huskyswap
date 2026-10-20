// Run the eval set through the agent and score it.
//
//   npm run eval                              teacher (TEACHER_* in .env.local)
//   npm run eval -- --model=student           student (STUDENT_BASE_URL, STUDENT_API_KEY, STUDENT_MODEL, STUDENT_VERSION)
//   npm run eval -- --only=ev-001,ev-019 --parallel=2 --no-examples --label=teacher-pilot
//
// Scoring:
//   answer items   correct when the agent answers and its result matches the gold
//                  query's result (src/lib/agent/compare.ts: execution accuracy)
//   refuse items   correct when the agent refuses
//   clarify items  correct when the agent asks a clarifying question
// No cache (it would answer from earlier runs). Runs are logged with source 'eval'.
// The report goes to eval/reports/<date>-<label>.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareResults, projectColumns } from "../src/lib/agent/compare.ts";
import { closePool, runSelect } from "../src/lib/agent/db.ts";
import { runAgent } from "../src/lib/agent/graph.ts";
import { teacherConfig } from "../src/lib/agent/llm.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";
import { PROMPT_VERSION } from "../src/lib/agent/prompt.ts";
import { SEMANTIC_VERSION } from "../src/lib/agent/semantic-layer.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const set = JSON.parse(readFileSync(new URL("../eval/eval-set.json", import.meta.url), "utf8"));

function studentConfig() {
  const { STUDENT_BASE_URL, STUDENT_API_KEY, STUDENT_MODEL, STUDENT_VERSION } = process.env;
  if (!STUDENT_BASE_URL || !STUDENT_MODEL) throw new Error("Set STUDENT_BASE_URL and STUDENT_MODEL in .env.local");
  return { label: STUDENT_MODEL, version: STUDENT_VERSION, baseUrl: STUDENT_BASE_URL, apiKeys: [STUDENT_API_KEY ?? "none"], model: STUDENT_MODEL };
}
const model = flag("model") === "student" ? studentConfig() : teacherConfig();
const label = flag("label") ?? `${flag("model") ?? "teacher"}-${model.version ?? model.label.split("/").pop()}`;
const only = flag("only")?.split(",");
const parallel = Number(flag("parallel") ?? 2);
const useExamples = !args.includes("--no-examples");

const { rows: [topStudent] } = await opsPool().query(
  "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text from u group by id order by count(*) desc limit 1",
);
const items = set.items.filter((i) => !only || only.includes(i.id)).slice(0, Number(flag("limit") ?? Infinity));

async function score(item) {
  const role = item.role === "admin" ? "nlq_admin" : "nlq_student";
  const userId = item.as_user === "top_student" ? topStudent.id : null;
  const run = await runAgent({ question: item.question, role, userId, source: "eval", useCache: false, useExamples, model });
  let correct = false;
  let reason = "";
  if (item.expect === "answer") {
    if (run.status !== "answered" || !run.result?.ok) {
      reason = `expected an answer, got ${run.status}`;
    } else {
      // The gold reading first, then any other accepted readings of an ambiguous question
      const readings = [item.gold_sql, ...(item.accept_sql ?? [])];
      for (const [i, sql] of readings.entries()) {
        const gold = await runSelect(sql, role, [], { userId });
        const c = gold.ok
          ? compareResults(i === 0 ? projectColumns(gold, item.compare_columns) : gold, run.result, item.order_matters ?? false)
          : { match: false, reason: `gold failed: ${gold.error}` };
        if (i === 0) reason = c.reason;
        if (c.match) {
          correct = true;
          reason = i === 0 ? c.reason : `matches accepted reading ${i}`;
          break;
        }
      }
    }
  } else {
    const wanted = item.expect === "refuse" ? "refused" : "clarify";
    correct = run.status === wanted;
    reason = correct ? item.expect : `expected ${item.expect}, got ${run.status}`;
  }
  return {
    id: item.id, expect: item.expect, difficulty: item.difficulty, tags: item.tags, question: item.question,
    correct, reason, status: run.status, sql: run.finalSql, answer: run.answer, clarification: run.clarification,
    modelCalls: run.calls.length, sqlErrors: run.sqlErrors, tokens: run.promptTokens + run.completionTokens,
    latencyMs: run.latencyMs, runId: run.runId, error: run.error,
  };
}

const results = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      const r = await score(item);
      results.push(r);
      console.log(`${r.correct ? "✓" : "✗"} ${r.id} [${r.expect}/${r.difficulty}] ${r.question.slice(0, 70)}${r.correct ? "" : `  ->  ${r.reason}`}`);
    }
  }),
);
results.sort((a, b) => a.id.localeCompare(b.id));

// Summary
const pct = (rs) => (rs.length ? Math.round((1000 * rs.filter((r) => r.correct).length) / rs.length) / 10 : null);
const by = (key) => Object.fromEntries(Object.entries(Object.groupBy(results, key)).map(([k, rs]) => [k, { n: rs.length, accuracy: pct(rs) }]));
const byTag = {};
for (const r of results) for (const t of r.tags ?? []) (byTag[t] ??= []).push(r);
const ms = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const quantile = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
const summary = {
  label, model: model.label, modelVersion: model.version ?? null, promptVersion: `${PROMPT_VERSION}/${SEMANTIC_VERSION}`,
  evalSet: set.version, items: results.length, useExamples, ranAt: new Date().toISOString(),
  executionAccuracy: pct(results.filter((r) => r.expect === "answer")),
  refuseAccuracy: pct(results.filter((r) => r.expect === "refuse")),
  clarifyAccuracy: pct(results.filter((r) => r.expect === "clarify")),
  overall: pct(results),
  byDifficulty: by((r) => r.difficulty),
  byTag: Object.fromEntries(Object.entries(byTag).map(([t, rs]) => [t, { n: rs.length, accuracy: pct(rs) }])),
  latencyMs: { p50: quantile(0.5), p95: quantile(0.95) },
  avgModelCalls: Math.round((10 * results.reduce((s, r) => s + r.modelCalls, 0)) / results.length) / 10,
  avgTokens: Math.round(results.reduce((s, r) => s + r.tokens, 0) / results.length),
  totalTokens: results.reduce((s, r) => s + r.tokens, 0),
  errors: results.filter((r) => r.status === "error").length,
};

const dir = new URL("../eval/reports/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${new Date().toISOString().slice(0, 10)}-${label}.json`, dir);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2) + "\n");

console.log(`\n=== ${label} on ${set.version} (${results.length} items) ===`);
console.log(`Execution accuracy (answer items): ${summary.executionAccuracy}%`);
console.log(`Refuses when it should:            ${summary.refuseAccuracy}%`);
console.log(`Clarifies when it should:          ${summary.clarifyAccuracy}%`);
console.log(`Overall:                           ${summary.overall}%`);
console.log(`By difficulty: ${Object.entries(summary.byDifficulty).map(([k, v]) => `${k} ${v.accuracy}% (${v.n})`).join(" · ")}`);
console.log(`Latency p50 ${(summary.latencyMs.p50 / 1000).toFixed(1)} s · p95 ${(summary.latencyMs.p95 / 1000).toFixed(1)} s · avg ${summary.avgModelCalls} model calls · avg ${summary.avgTokens} tokens · ${summary.errors} errors`);
console.log(`Report: ${fileURLToPath(file)}`);

await closePool();
await closeOpsPool();
