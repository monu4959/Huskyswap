// Ask the text-to-SQL agent a question from the terminal and watch the graph run.
//
//   npm run ask -- "how many bikes were listed during finals last spring?"
//   npm run ask -- --role=student "any mini fridges for rent at curry?"
//   npm run ask -- --role=student --as-user=<student uuid> "how much have I earned?"
//   npm run ask -- --no-cache --no-log "..."
//
// If the agent asks a clarifying question, answer it here (a number picks an
// option). Uses the teacher model from .env.local (TEACHER_*); runs are
// logged with source 'cli'.

import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/lib/agent/db.ts";
import { runAgent } from "../src/lib/agent/graph.ts";
import { closeOpsPool } from "../src/lib/agent/ops-db.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
const role = (flag("role") ?? "admin") === "student" ? "nlq_student" : "nlq_admin";
if (!question) {
  console.error('Usage: npm run ask -- [--role=student|admin] [--as-user=<uuid>] [--no-cache] [--no-log] "question"');
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const short = (s, n = 150) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

// Clarification answers: typed at a prompt, or read up front when piped in (printf '1\n' | npm run ask ...)
let piped = null;
if (!process.stdin.isTTY) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  piped = text.split(/\r?\n/).filter(Boolean);
}
async function prompt() {
  if (piped) return piped.shift() ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const line = await rl.question("> ");
  rl.close();
  return line;
}

console.log(dim(`role ${role} · model ${process.env.TEACHER_MODEL}${flag("as-user") ? ` · as student ${flag("as-user")}` : ""}`));
console.log(`Q: ${question}\n`);

const clarifications = [];
let run;
for (;;) {
  run = await runAgent({
    question,
    clarifications,
    role,
    userId: flag("as-user") ?? null,
    source: "cli",
    log: !args.includes("--no-log"),
    useCache: !args.includes("--no-cache"),
    onEvent(e) {
      if (e.status === "start") return;
      const mark = e.status === "error" ? "✗" : e.status === "hit" ? "⚡" : "✓";
      console.log(`  ${mark} ${e.node.padEnd(8)} ${dim(short(e.detail ?? e.status))}`);
    },
  });
  if (run.status !== "clarify") break;
  console.log(`\n? ${run.clarification.question}`);
  run.clarification.options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  const reply = (await prompt()).trim();
  if (!reply) break; // no answer given (e.g. nothing piped in): stop at the question
  const answer = run.clarification.options[Number(reply) - 1] ?? reply;
  console.log(`> ${answer}\n`);
  clarifications.push({ question: run.clarification.question, answer });
}

console.log(`\nStatus: ${run.status}${run.cacheHit ? " (from cache)" : ""}${run.grounded === false ? " (answer not grounded in the result)" : ""}`);
if (run.resolvedQuestion && run.resolvedQuestion !== question) console.log(`Resolved question: ${run.resolvedQuestion}`);
console.log(`Answer: ${run.answer ?? "(none)"}`);
if (run.finalSql) console.log(`\nSQL:\n${run.finalSql}`);
if (run.status === "answered" && run.result?.ok && run.result.rows.length) console.table(run.result.rows.slice(0, 10));
if (run.error) console.log(`Error: ${run.error}`);
console.log(
  dim(
    `\n${run.nodes.map((n) => `${n.node} ${n.ms}ms`).join(" → ")}\n` +
      `${run.calls.length} model call(s) · ${run.sqlErrors} failed SQL · ${run.promptTokens}+${run.completionTokens} tokens · ` +
      `${(run.latencyMs / 1000).toFixed(1)} s${run.runId ? ` · run ${run.runId}` : ""}`,
  ),
);

await closePool();
await closeOpsPool();
