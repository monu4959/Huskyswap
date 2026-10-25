// Drift monitor: are students asking the kind of questions the production model
// was trained on, and is it still coping?
//
//   npm run drift -- index                   embed the production model's training questions into
//                                            ops.training_questions (needs ml/datasets, not in git)
//   npm run drift                            app questions from the last 7 days
//   npm run drift -- --days=30
//   npm run drift -- --set=eval/test-set.json   treat an eval set (or any {items: [{id, question}]}) as the traffic
//
// Shift: each question's cosine similarity to the nearest training question
// (gte-small), against the same measure on the held-out test set, which was
// written to look like real questions. About 10% of test questions fall below
// its 10th percentile, so normal traffic should too; a much larger share means
// students ask things the model never trained on. (Similarity alone predicts
// accuracy only weakly: on the test set r2 scores 87.5% at >= 0.92 and 70-81%
// everywhere below, so this flags new kinds of questions, not wrong answers.)
//
// Retraining is recommended when, with 20+ questions, over 25% fall below that
// line; or over 15% of runs error or give up; or thumbs-down passes 20% (10+
// ratings); or over 10% of runs used an older schema. Writes
// eval/drift/<date>-<source>.json; app question text stays in the database (the
// report lists run ids), as it's students' words.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { embed } from "../src/lib/agent/embed.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";
import { SCHEMA_HASH } from "../src/lib/agent/schema-card.ts";
import { toVector } from "../src/lib/agent/vector.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const jsonl = (path) => read(path).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const registry = JSON.parse(read("ml/registry.json"));
const production = registry.models.find((m) => m.id === registry.serving.production);
const dataset = production.training?.data.stage2Sha256;
if (!dataset) throw new Error(`${production.id} has no training data hash in the registry`);

async function nearest(questions) {
  const vectors = [];
  for (let i = 0; i < questions.length; i += 64) vectors.push(...(await embed(questions.slice(i, i + 64))));
  const out = [];
  for (const v of vectors) {
    const { rows } = await opsPool().query(
      `select 1 - (embedding operator(extensions.<=>) $1::extensions.vector) as sim
       from ops.training_questions where dataset = $2
       order by embedding operator(extensions.<=>) $1::extensions.vector limit 1`,
      [toVector(v), dataset],
    );
    out.push(Number(rows[0]?.sim ?? 0));
  }
  return out;
}

if (args[0] === "index") {
  const local = createHash("sha256").update(read("ml/datasets/stage2.jsonl")).digest("hex");
  if (local !== dataset) throw new Error(`ml/datasets/stage2.jsonl (${local.slice(0, 12)}) isn't ${production.id}'s training data (${dataset.slice(0, 12)})`);
  const trained = new Set(["stage1", "stage2"].flatMap((f) => jsonl(`ml/datasets/${f}.jsonl`).map((e) => e.meta.qid)));
  const questions = [...jsonl("ml/datasets/work/questions.jsonl"), ...jsonl("ml/datasets/work/variants.jsonl")].filter((q) => trained.has(q.qid));
  console.log(`embedding ${questions.length} training questions of ${production.id}...`);
  const pool = opsPool();
  await pool.query("delete from ops.training_questions where dataset = $1", [dataset]);
  for (let i = 0; i < questions.length; i += 64) {
    const batch = questions.slice(i, i + 64);
    const vectors = await embed(batch.map((q) => q.question));
    await pool.query(
      `insert into ops.training_questions (dataset, qid, question, expect, embedding)
       select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::extensions.vector[])`,
      [dataset, batch.map((q) => q.qid), batch.map((q) => q.question), batch.map((q) => q.expect), vectors.map(toVector)],
    );
  }
  console.log(`indexed ${questions.length} questions for dataset ${dataset.slice(0, 12)}`);
  await closeOpsPool();
  process.exit(0);
}

const { rows: [{ n }] } = await opsPool().query("select count(*)::int as n from ops.training_questions where dataset = $1", [dataset]);
if (!n) throw new Error(`no training questions indexed for ${production.id}: run npm run drift -- index`);

// Reference: the held-out test set
const testSet = JSON.parse(read("eval/test-set.json"));
const testSims = (await nearest(testSet.items.map((i) => i.question))).sort((a, b) => a - b);
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const line = quantile(testSims, 0.1);

// The traffic
const setPath = flag("set");
const days = Number(flag("days") ?? 7);
let traffic;
let outcomes = null;
if (setPath) {
  const set = JSON.parse(readFileSync(setPath, "utf8"));
  traffic = set.items.map((i) => ({ id: i.id, question: i.question }));
} else {
  const { rows } = await opsPool().query(
    `select run_id::text as id, question, status, feedback, schema_hash from ops.agent_runs
     where source = 'app' and created_at > now() - make_interval(days => $1) order by created_at`,
    [days],
  );
  traffic = rows;
  const count = (f) => rows.filter(f).length;
  outcomes = {
    runs: rows.length,
    error: count((r) => r.status === "error"),
    gaveUp: count((r) => r.status === "gave_up"),
    refused: count((r) => r.status === "refused"),
    clarify: count((r) => r.status === "clarify"),
    ratings: count((r) => r.feedback !== null),
    thumbsDown: count((r) => r.feedback === -1),
    olderSchema: count((r) => r.schema_hash !== SCHEMA_HASH),
  };
}
if (!traffic.length) {
  console.log(`no app questions in the last ${days} days`);
  await closeOpsPool();
  process.exit(0);
}
const sims = await nearest(traffic.map((t) => t.question));
const below = sims.filter((x) => x < line).length / sims.length;

const reasons = [];
if (sims.length >= 20 && below > 0.25) reasons.push(`${(100 * below).toFixed(0)}% of questions are farther from training than 90% of the test set (expected ~10%)`);
if (outcomes && outcomes.runs >= 20 && outcomes.error + outcomes.gaveUp > 0.15 * outcomes.runs) reasons.push(`${outcomes.error + outcomes.gaveUp} of ${outcomes.runs} runs errored or gave up`);
if (outcomes && outcomes.ratings >= 10 && outcomes.thumbsDown > 0.2 * outcomes.ratings) reasons.push(`${outcomes.thumbsDown} of ${outcomes.ratings} ratings are thumbs-down`);
if (outcomes && outcomes.olderSchema > 0.1 * outcomes.runs) reasons.push(`${outcomes.olderSchema} of ${outcomes.runs} runs used an older schema`);

const source = setPath ? setPath.split("/").pop().replace(/\.json$/, "") : `app-${days}d`;
const report = {
  model: production.id, dataset: dataset.slice(0, 12), source, ranAt: new Date().toISOString(), questions: traffic.length,
  similarity: { line, testMedian: quantile(testSims, 0.5), median: quantile([...sims].sort((a, b) => a - b), 0.5) }, belowLine: below, outcomes,
  retrain: reasons.length > 0, reasons,
  // Farthest from training first: the queue for the next round of training data
  farthest: traffic.map((t, k) => ({ id: t.id, sim: Math.round(1000 * sims[k]) / 1000, ...(setPath ? { question: t.question } : {}) }))
    .sort((a, b) => a.sim - b.sim).slice(0, 25),
};
const dir = new URL("../eval/drift/", import.meta.url);
mkdirSync(dir, { recursive: true });
const name = `${report.ranAt.slice(0, 10)}-${source}.json`;
writeFileSync(new URL(name, dir), JSON.stringify(report, null, 2) + "\n");

const pct = (x) => `${(100 * x).toFixed(1)}%`;
console.log(`=== drift: ${traffic.length} ${setPath ? `questions from ${setPath}` : `app questions, last ${days} days`} vs ${production.id}'s ${n} training questions ===
`);
console.log(`similarity to the nearest training question: median ${report.similarity.median.toFixed(3)} (test set ${report.similarity.testMedian.toFixed(3)})`);
console.log(`farther than 90% of the test set (< ${line.toFixed(3)}): ${pct(below)} of questions (expected ~10%, alarm over 25%)`);
if (outcomes) console.log(`outcomes: ${outcomes.error} errors, ${outcomes.gaveUp} give-ups, ${outcomes.refused} refused, ${outcomes.clarify} clarifications, ${outcomes.thumbsDown}/${outcomes.ratings} thumbs-down, ${outcomes.olderSchema} on an older schema`);
console.log(reasons.length ? `\nRETRAIN RECOMMENDED:\n  ${reasons.join("\n  ")}` : "\nno drift");
console.log(`report: eval/drift/${name}`);
await closeOpsPool();
process.exitCode = reasons.length ? 1 : 0;
