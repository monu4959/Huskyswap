// Run a fixed set of questions through the agent and save every run, for
// reading through failures while tuning the prompts and the semantic layer.
// Not the eval set: no gold answers here, and none of these may become eval
// questions (they shape the prompts).
//
//   npm run smoke:agent -- [--out=runs.jsonl] [--only=3,7] [--group=complex] [--parallel=4]
//
// "own data" questions run as the seeded student with the most deals.
// Runs are logged to ops.agent_runs with source 'test' (no cache).

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/lib/agent/db.ts";
import { runAgent } from "../src/lib/agent/graph.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";
import { QUESTIONS } from "./smoke-questions.mjs";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));


const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const out = flag("out");
const only = flag("only")?.split(",").map(Number);
const group = flag("group");
const parallel = Number(flag("parallel") ?? 4);

// The seeded student with the most deals, for the "own data" questions
const { rows: [me] } = await opsPool().query(
  "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text from u group by id order by count(*) desc limit 1",
);

const jobs = QUESTIONS.map((q, i) => ({ n: i + 1, group: q[0], who: q[1], question: q[2], expect: q[3] })).filter(
  (j) => (!only || only.includes(j.n)) && (!group || j.group === group),
);

const STATUS_FOR = { answer: "answered", refuse: "refused", clarify: "clarify" };
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const run = await runAgent({
      question: job.question,
      role: job.who === "admin" ? "nlq_admin" : "nlq_student",
      userId: job.who === "me" ? me.id : null,
      source: "test",
    });
    const asExpected = run.status === STATUS_FOR[job.expect];
    results.push({ job, run, asExpected });
    const rows = run.status === "answered" && run.result?.ok ? JSON.stringify(run.result.rows.slice(0, 3)) : null;
    console.log(
      `\n#${job.n} [${job.group}] ${job.question}\n` +
        `   ${asExpected ? "as expected" : `EXPECTED ${job.expect.toUpperCase()}`}: ${run.status}${run.grounded === false ? " (ungrounded)" : ""} · ` +
        `${run.calls.length} model calls · ${run.sqlErrors} failed SQL · ${run.promptTokens + run.completionTokens} tokens · ${(run.latencyMs / 1000).toFixed(1)} s\n` +
        `   ${run.status === "clarify" ? `asks: ${run.clarification.question} [${run.clarification.options.join(" | ")}]` : `answer: ${run.answer}`}` +
        (run.status === "answered" && run.finalSql ? `\n   sql: ${run.finalSql.replace(/\s+/g, " ")}` : "") +
        (rows ? `\n   rows: ${rows}` : "") +
        (run.error ? `\n   error: ${run.error}` : ""),
    );
    if (out) appendFileSync(out, JSON.stringify({ ...job, ...run, calls: undefined, messages: undefined }) + "\n");
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));

// Summary by group
console.log("\n=== Summary ===");
const groups = [...new Set(results.map((r) => r.job.group))];
for (const g of groups) {
  const rs = results.filter((r) => r.job.group === g);
  console.log(`${g.padEnd(10)} ${rs.filter((r) => r.asExpected).length}/${rs.length} as expected`);
}
const tokens = results.reduce((s, r) => s + r.run.promptTokens + r.run.completionTokens, 0);
const calls = results.reduce((s, r) => s + r.run.calls.length, 0);
const ms = results.map((r) => r.run.latencyMs).sort((a, b) => a - b);
console.log(
  `\n${results.length} runs · ${results.filter((r) => r.asExpected).length} as expected · ${results.filter((r) => r.run.status === "error").length} errors · ` +
    `avg ${(calls / results.length).toFixed(1)} model calls · avg ${Math.round(tokens / results.length)} tokens · ` +
    `median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s · p95 ${(ms[Math.floor(ms.length * 0.95)] / 1000).toFixed(1)} s`,
);

await closePool();
await closeOpsPool();
