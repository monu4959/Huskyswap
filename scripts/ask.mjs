// Ask the text-to-SQL agent a question from the terminal and watch every step.
//
//   npm run ask -- "how many bikes were listed during finals last spring?"
//   npm run ask -- --role=student "any mini fridges for rent at curry?"
//   npm run ask -- --no-log "..."        don't write the run to ops.agent_runs
//
// Uses the teacher model from .env.local (TEACHER_*). Runs are logged with
// source 'cli'.

import { fileURLToPath } from "node:url";
import { closePool } from "../src/lib/agent/db.ts";
import { closeLogPool } from "../src/lib/agent/log.ts";
import { runAgent } from "../src/lib/agent/run.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
const role = (flag("role") ?? "admin") === "student" ? "nlq_student" : "nlq_admin";
if (!question) {
  console.error('Usage: npm run ask -- [--role=student|admin] [--no-log] "question"');
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

function summarize(name, content) {
  const r = JSON.parse(content);
  if (r.error) return `error: ${r.error}`;
  if (name === "describe_view") return `${r.columns.length} columns: ${r.columns.map((c) => c.name).join(", ")}`;
  if (name === "submit_answer") return "submitted";
  return `${r.row_count} row(s)${r.rows?.length ? `, first: ${JSON.stringify(r.rows[0])}` : ""}`;
}

console.log(dim(`role ${role} · model ${process.env.TEACHER_MODEL}`));
console.log(`Q: ${question}\n`);

const run = await runAgent({
  question,
  role,
  source: "cli",
  log: !args.includes("--no-log"),
  onStep(e) {
    if (e.type === "tool_call") {
      const a = JSON.parse(e.args || "{}");
      if (e.name === "run_sql" || e.name === "submit_answer") {
        console.log(`  [${e.step}] ${e.name}${a.sql ? `:\n${dim(a.sql.replace(/^/gm, "        "))}` : " (no SQL)"}`);
      } else {
        console.log(`  [${e.step}] ${e.name}(${Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`);
      }
    } else if (e.type === "tool_result") {
      console.log(dim(`      -> ${short(summarize(e.name, e.content))}`));
    }
  },
});

console.log(`\nStatus: ${run.status}`);
console.log(`Answer: ${run.answer ?? "(none)"}`);
if (run.finalSql) console.log(`\nFinal SQL:\n${run.finalSql}`);
if (run.result?.ok && run.result.rows.length) console.table(run.result.rows.slice(0, 10));
if (run.error) console.log(`Error: ${run.error}`);
console.log(
  dim(
    `\n${run.steps} step(s) · ${run.sqlErrors} SQL error(s) · ${run.promptTokens}+${run.completionTokens} tokens · ` +
      `${(run.latencyMs / 1000).toFixed(1)} s (steps: ${run.stepLatencyMs.map((ms) => (ms / 1000).toFixed(1)).join(", ")} s)` +
      (run.runId ? ` · run ${run.runId}` : ""),
  ),
);

await closePool();
await closeLogPool();
