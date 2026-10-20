// Verify the eval set (eval/eval-set.json) before using it. No model calls.
//
//   npm run eval:verify
//
// For every "answer" item: gold_sql and alt_sql (written independently) must
// both run, return 1-200 rows, and give the same result under the same
// comparison the eval uses. Contamination: a question close to a verified
// example fails (examples are handed to the agent, so it would see a near
// answer); close to a smoke question or another eval item is a warning (those
// never reach the agent, and shared wording isn't a shared answer).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareResults } from "../src/lib/agent/compare.ts";
import { closePool, runSelect } from "../src/lib/agent/db.ts";
import { embed } from "../src/lib/agent/embed.ts";
import { EXAMPLES } from "../src/lib/agent/examples.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";
import { QUESTIONS as SMOKE } from "./smoke-questions.mjs";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const set = JSON.parse(readFileSync(new URL("../eval/eval-set.json", import.meta.url), "utf8"));
const TOO_CLOSE = 0.92; // to a verified example (gte-small cosine; paraphrases score ~0.95+)
const WARN_CLOSE = 0.95; // to a smoke question or another eval item

const { rows: [topStudent] } = await opsPool().query(
  "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text from u group by id order by count(*) desc limit 1",
);
const userFor = (item) => (item.as_user === "top_student" ? topStudent.id : null);
const roleFor = (item) => (item.role === "admin" ? "nlq_admin" : "nlq_student");

let problems = 0;
const fail = (id, msg) => {
  problems++;
  console.log(`FAIL  ${id}  ${msg}`);
};

// 1. Shape
const ids = new Set();
for (const item of set.items) {
  if (ids.has(item.id)) fail(item.id, "duplicate id");
  ids.add(item.id);
  if (!["answer", "refuse", "clarify"].includes(item.expect)) fail(item.id, `bad expect ${item.expect}`);
  if (item.expect === "answer" && (!item.gold_sql || !item.alt_sql)) fail(item.id, "answer item needs gold_sql and alt_sql");
}

// 2. Gold queries
for (const item of set.items.filter((i) => i.expect === "answer")) {
  const opts = { userId: userFor(item) };
  const [gold, alt] = [await runSelect(item.gold_sql, roleFor(item), [], opts), await runSelect(item.alt_sql, roleFor(item), [], opts)];
  if (!gold.ok) { fail(item.id, `gold_sql failed: ${gold.error}`); continue; }
  if (!alt.ok) { fail(item.id, `alt_sql failed: ${alt.error}`); continue; }
  if (gold.rowCount === 0) { fail(item.id, "gold returns no rows"); continue; }
  if (gold.truncated) { fail(item.id, "gold returns more than 200 rows"); continue; }
  for (const [i, sql] of (item.accept_sql ?? []).entries()) {
    const r = await runSelect(sql, roleFor(item), [], opts);
    if (!r.ok || r.rowCount === 0) fail(item.id, `accept_sql ${i + 1} ${r.ok ? "returns no rows" : `failed: ${r.error}`}`);
  }
  if (item.compare_columns?.some((c) => !gold.columns.includes(c))) fail(item.id, `compare_columns not in gold: ${item.compare_columns.join(", ")}`);
  const c = compareResults(gold, alt, item.order_matters ?? false);
  if (!c.match) {
    fail(item.id, `gold and alt disagree (${c.reason})\n        gold: ${JSON.stringify(gold.rows.slice(0, 3))}\n        alt:  ${JSON.stringify(alt.rows.slice(0, 3))}`);
    continue;
  }
  console.log(`ok    ${item.id}  ${gold.rowCount} row${gold.rowCount === 1 ? "" : "s"}  ${JSON.stringify(gold.rows[0]).slice(0, 80)}`);
}

// 3. Contamination: close paraphrases of examples (fail), smoke questions or each other (warn)
const others = [...EXAMPLES.map((e) => ({ src: "example", q: e.question })), ...SMOKE.map((s) => ({ src: "smoke", q: s[2] }))];
const evalVecs = await embed(set.items.map((i) => i.question));
const otherVecs = await embed(others.map((o) => o.q));
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
for (const [i, item] of set.items.entries()) {
  for (const [j, o] of others.entries()) {
    const s = cos(evalVecs[i], otherVecs[j]);
    if (o.src === "example" && s >= TOO_CLOSE) fail(item.id, `too close to a verified example (${s.toFixed(3)}): "${o.q}"`);
    else if (o.src === "smoke" && s >= WARN_CLOSE) console.log(`WARN  ${item.id}  close to smoke question (${s.toFixed(3)}): "${o.q}"`);
  }
  for (let k = i + 1; k < set.items.length; k++) {
    const s = cos(evalVecs[i], evalVecs[k]);
    if (s >= WARN_CLOSE) console.log(`WARN  ${item.id}  close to ${set.items[k].id} (${s.toFixed(3)})`);
  }
}

await closePool();
await closeOpsPool();
const counts = Object.groupBy(set.items, (i) => i.expect);
console.log(
  `\n${set.items.length} items (${counts.answer?.length ?? 0} answer, ${counts.refuse?.length ?? 0} refuse, ${counts.clarify?.length ?? 0} clarify) · ` +
    (problems ? `${problems} problem(s)` : "all verified"),
);
process.exitCode = problems ? 1 : 0;
