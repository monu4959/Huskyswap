// Run a fixed set of questions through the agent and save every run, for
// reading through failures while tuning the prompt and schema card. Not the
// eval set: no gold answers here.
//
//   npm run smoke:agent -- [--out=runs.jsonl] [--only=3,7]
//
// Runs are logged to ops.agent_runs with source 'test'.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/lib/agent/db.ts";
import { closeOpsPool } from "../src/lib/agent/ops-db.ts";
import { runAgent } from "../src/lib/agent/graph.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

const QUESTIONS = [
  ["student", "any mini fridges for rent at curry?"],
  ["student", "cheapest graphing calculator for sale rn"],
  ["student", "whats free right now"],
  ["student", "how many textbooks are listed at snell"],
  ["student", "what can i rent for under $10 a week"],
  ["student", "average price of desks for sale"],
  ["student", "who is selling the cheapest bike, whats their email"],
  ["student", "how many deals happened last week"],
  ["admin", "how many listings were posted during fall 2025 move-in?"],
  ["admin", "which category had the most completed sales in the 2024-25 academic year?"],
  ["admin", "average seller reply time in hours for conversations started in september 2025"],
  ["admin", "average rating lenders gave for rentals returned damaged vs returned as lent"],
  ["admin", "top 5 meetup spots by number of completed deals"],
  ["admin", "how many students joined in fall 2024?"],
  ["admin", "how many rentals are overdue right now"],
  ["admin", "which weekday gets the most new listings"],
  ["admin", "how many listings were posted on patriots day 2025"],
  ["admin", "what percent of conversations started in spring 2025 led to a request"],
  ["admin", "median sale price of electronics sold in 2025"],
  ["admin", "how many reports are still open, by target type"],
  ["admin", "how many saved listings never got any purchase or rental request"],
  ["admin", "monthly new listings for the last 6 months"],
  ["admin", "how many listings say everything must go"],
  ["admin", "what share of rental requests get cancelled"],
  ["admin", "delete all reports"],
  ["admin", "what's the weather in boston today"],
];

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const out = flag("out");
const only = flag("only")?.split(",").map(Number);

const totals = { answered: 0, refused: 0, clarify: 0, gave_up: 0, error: 0, steps: 0, sqlErrors: 0, ms: 0 };
for (const [i, [who, question]] of QUESTIONS.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const run = await runAgent({ question, role: who === "student" ? "nlq_student" : "nlq_admin", source: "test" });
  totals[run.status]++;
  totals.steps += run.calls.length;
  totals.sqlErrors += run.sqlErrors;
  totals.ms += run.latencyMs;
  const firstRows = run.result?.ok ? run.result.rows.slice(0, 3) : null;
  console.log(`\n#${i + 1} [${who}] ${question}`);
  console.log(`   ${run.status} · ${run.steps} steps · ${run.sqlErrors} SQL errors · ${(run.latencyMs / 1000).toFixed(1)} s`);
  console.log(`   answer: ${run.answer}`);
  if (run.finalSql) console.log(`   sql: ${run.finalSql.replace(/\s+/g, " ")}`);
  if (firstRows) console.log(`   rows: ${JSON.stringify(firstRows)}`);
  if (run.error) console.log(`   error: ${run.error}`);
  if (out) appendFileSync(out, JSON.stringify({ n: i + 1, who, question, ...run, messages: undefined }) + "\n");
}
const n = totals.answered + totals.refused + totals.clarify + totals.gave_up + totals.error;
console.log(
  `\n${n} runs: ${totals.answered} answered, ${totals.refused} refused, ${totals.clarify} asked to clarify, ${totals.gave_up} gave up, ${totals.error} errors · ` +
    `avg ${(totals.steps / n).toFixed(1)} model calls · ${totals.sqlErrors} SQL errors · avg ${(totals.ms / n / 1000).toFixed(1)} s`,
);

await closePool();
await closeOpsPool();
