// Generate training data for the student from the teacher (Phase 3).
//
//   npm run datagen -- --stage=all [--fills=4] [--variants=4] [--parallel=6] [--limit=N] [--seed=1]
//   npm run datagen -- --stage=fill | reword | reference | traces | export
//   npm run datagen -- --stage=traces --max-minutes=8     work in chunks; rerun to continue
//
// Stages (each resumable; work files in ml/datasets/work/):
//   fill       templates (ml/datagen/templates.mjs) -> original questions
//   reword     the teacher writes student-style variants of each original
//   reference  the teacher answers each original 3 times; 2 of 3 agreeing results
//              set the reference answer (refuse / clarify items expect that behavior)
//   traces     the teacher runs the full agent on every question; runs that reach
//              the reference (or the expected refuse / clarify) are kept
//   export     ml/datasets/stage1.jsonl  question -> SQL (the SQL node's first turn)
//              ml/datasets/stage2.jsonl  every model call of the kept runs
// Every training target comes from the teacher. Questions too close to the eval
// set are dropped. Uses the teacher in .env.local (self-hosted recommended).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJson } from "../src/lib/agent/clarify.ts";
import { compareResults } from "../src/lib/agent/compare.ts";
import { closePool } from "../src/lib/agent/db.ts";
import { embed } from "../src/lib/agent/embed.ts";
import { runAgent } from "../src/lib/agent/graph.ts";
import { chat, teacherConfig } from "../src/lib/agent/llm.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";
import { PROMPT_VERSION, bostonToday, sqlSystem, sqlUser } from "../src/lib/agent/prompt.ts";
import { retrieve } from "../src/lib/agent/retrieve.ts";
import { SEMANTIC_VERSION } from "../src/lib/agent/semantic-layer.ts";
import { SQL_TOOLS } from "../src/lib/agent/sql-node.ts";
import { SLOTS, TEMPLATES } from "../ml/datagen/templates.mjs";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const stage = flag("stage", "all");
const FILLS = Number(flag("fills", 4));
const VARIANTS = Number(flag("variants", 4));
const PARALLEL = Number(flag("parallel", 6));
const LIMIT = Number(flag("limit", Infinity));
const SEED = Number(flag("seed", 1));
const TOO_CLOSE_TO_EVAL = 0.92;

const OUT = new URL("../ml/datasets/", import.meta.url);
const WORK = new URL("work/", OUT);
mkdirSync(WORK, { recursive: true });
const file = (name) => fileURLToPath(new URL(name, WORK));
const readJsonl = (name) => (existsSync(file(name)) ? readFileSync(file(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const append = (name, row) => appendFileSync(file(name), JSON.stringify(row) + "\n");
const role = (q) => (q.role === "admin" ? "nlq_admin" : "nlq_student");

// Fixed for the whole dataset so every prompt says the same "today"
const configPath = file("config.json");
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8"))
  : { today: bostonToday(), seed: SEED, promptVersion: `${PROMPT_VERSION}/${SEMANTIC_VERSION}`, createdAt: new Date().toISOString() };
writeFileSync(configPath, JSON.stringify(config, null, 2));
if (config.promptVersion !== `${PROMPT_VERSION}/${SEMANTIC_VERSION}`) {
  throw new Error(`Work files were made with ${config.promptVersion}, the agent is now ${PROMPT_VERSION}/${SEMANTIC_VERSION}: start a fresh ml/datasets/work/`);
}

// --max-minutes: stop taking new items after that long (items in progress finish); rerun to continue
const DEADLINE = flag("max-minutes") ? Date.now() + Number(flag("max-minutes")) * 60_000 : Infinity;

async function pool(items, fn) {
  let i = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (i < items.length && Date.now() < DEADLINE) {
      const item = items[i++];
      await fn(item);
      if (++done % 10 === 0 || done === items.length) console.log(`  ${done}/${items.length}`);
    }
  }));
}

// Results agree when each contains the other's answer
const sameResult = (a, b) => compareResults(a, b).match && compareResults(b, a).match;

// ---------------------------------------------------------------------------
// fill
// ---------------------------------------------------------------------------
async function fill() {
  if (readJsonl("questions.jsonl").length) return console.log("fill: already done");
  let state = SEED;
  const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const { rows: students } = await opsPool().query(
    `with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals)
     select u.id::text from u join public.profiles p on p.id = u.id where p.role = 'student' and p.account_status = 'active'
     group by u.id order by count(*) desc limit 10`,
  );
  const evalSet = JSON.parse(readFileSync(new URL("../eval/eval-set.json", import.meta.url), "utf8"));
  const evalVecs = await embed(evalSet.items.map((i) => i.question));

  const questions = [];
  for (const t of TEMPLATES) {
    const slotNames = [...t.question.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const seen = new Set();
    for (let k = 0; k < (slotNames.length ? FILLS * 3 : 1) && seen.size < (slotNames.length ? FILLS : 1); k++) {
      const text = t.question.replace(/\{(\w+)\}/g, (_, s) => SLOTS[s][Math.floor(rand() * SLOTS[s].length)].say);
      if (seen.has(text)) continue;
      seen.add(text);
      questions.push({
        qid: `${t.id}#${seen.size}`, template: t.id, role: t.role, expect: t.expect, question: text,
        userId: t.me ? students[questions.length % students.length].id : null,
      });
    }
  }
  const vecs = await embed(questions.map((q) => q.question));
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  let dropped = 0;
  for (const [i, q] of questions.entries()) {
    if (evalVecs.some((e) => cos(vecs[i], e) >= TOO_CLOSE_TO_EVAL)) { dropped++; continue; }
    append("questions.jsonl", q);
  }
  console.log(`fill: ${questions.length - dropped} original questions from ${TEMPLATES.length} templates (${dropped} dropped: too close to an eval question)`);
}

// ---------------------------------------------------------------------------
// reword
// ---------------------------------------------------------------------------
const REWORD_SYSTEM = `You rewrite questions about HuskySwap, Northeastern University's student marketplace, the way students would actually type them into a search box.

Keep the meaning exactly:
- the same numbers, years, semesters, places and items
- the same thing being counted or measured: "posted" stays posted (not "available" or "up right now"), "sold" stays sold, "completed" stays completed
- the same time: never add time words that aren't in the original ("rn", "now", "this", "currently", "lately"), and never change which date is meant
- no added or dropped conditions
Vary the wording, word order and casing; use abbreviations and slang students use (orgo, calc, iv for International Village, "the library" for Snell, "rn" only when the original says right now), and put a small typo in some of them.

Reply with JSON only: {"variants": ["...", "..."]}`;

async function reword() {
  const questions = readJsonl("questions.jsonl").slice(0, LIMIT);
  const done = new Set(readJsonl("variants.jsonl").map((v) => v.parent));
  const todo = questions.filter((q) => !done.has(q.qid));
  console.log(`reword: ${todo.length} questions to rephrase (${VARIANTS} variants each)`);
  const evalSet = JSON.parse(readFileSync(new URL("../eval/eval-set.json", import.meta.url), "utf8"));
  const evalVecs = await embed(evalSet.items.map((i) => i.question));
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const teacher = teacherConfig();
  await pool(todo, async (q) => {
    let variants = [];
    try {
      const reply = await chat(teacher, [
        { role: "system", content: REWORD_SYSTEM },
        { role: "user", content: `Write ${VARIANTS} variants of: ${q.question}` },
      ], { json: true });
      variants = (parseJson(reply.content)?.variants ?? []).filter((x) => typeof x === "string");
    } catch (e) {
      console.log(`  ${q.qid}: reword failed (${e.message.slice(0, 80)})`);
    }
    // Numbers must survive; no duplicates of the original or each other
    const digits = q.question.match(/\d+/g) ?? [];
    const seen = new Set([q.question.toLowerCase().trim()]);
    variants = variants.map((x) => x.trim()).filter((x) => {
      const key = x.toLowerCase();
      if (!x || x.length > 240 || seen.has(key) || !digits.every((d) => x.includes(d))) return false;
      seen.add(key);
      return true;
    });
    const vecs = await embed(variants);
    let n = 0;
    for (const [i, text] of variants.entries()) {
      if (evalVecs.some((e) => cos(vecs[i], e) >= TOO_CLOSE_TO_EVAL)) continue;
      append("variants.jsonl", { ...q, qid: `${q.qid}~${++n}`, parent: q.qid, question: text });
    }
    if (!n) append("variants.jsonl", { parent: q.qid, qid: null, empty: true });
  });
}

// ---------------------------------------------------------------------------
// reference
// ---------------------------------------------------------------------------
async function reference() {
  const questions = readJsonl("questions.jsonl").slice(0, LIMIT);
  // Questions whose runs all errored (teacher unreachable) are retried; later lines win when read back
  const failedOnErrors = (r) => r.ok === false && r.statuses?.every((s) => s === "error");
  const done = new Set(readJsonl("references.jsonl").filter((r) => !failedOnErrors(r)).map((r) => r.qid));
  const todo = questions.filter((q) => !done.has(q.qid));
  console.log(`reference: ${todo.length} questions (answer items: 3 teacher runs each)`);
  await pool(todo, async (q) => {
    if (q.expect !== "answer") {
      append("references.jsonl", { qid: q.qid, expect: q.expect, ok: true });
      return;
    }
    const runs = [];
    for (let k = 0; k < 3; k++) {
      runs.push(await runAgent({ question: q.question, role: role(q), userId: q.userId, source: "datagen", useCache: false, today: config.today, log: false }));
    }
    const answered = runs.filter((r) => r.status === "answered" && r.result?.ok);
    // Largest group of runs with the same result; it needs at least 2 of the 3
    let best = [];
    for (const r of answered) {
      const group = answered.filter((o) => sameResult(r.result, o.result));
      if (group.length > best.length) best = group;
    }
    if (best.length >= 2) {
      const ref = best[0];
      append("references.jsonl", { qid: q.qid, expect: "answer", ok: true, votes: best.length, sql: ref.finalSql, result: ref.result });
      // The agreeing runs are good traces already
      for (const r of best) saveTrace(q, r, true, `reference (${best.length}/3 agree)`);
    } else {
      append("references.jsonl", { qid: q.qid, expect: "answer", ok: false, votes: best.length, statuses: runs.map((r) => r.status) });
    }
  });
}

function saveTrace(q, run, kept, reason) {
  append("traces.jsonl", {
    qid: q.qid, parent: q.parent ?? null, template: q.template, role: q.role, userId: q.userId, expect: q.expect,
    question: q.question, kept, reason, status: run.status, finalSql: run.finalSql, calls: run.calls, messages: run.messages,
    tokens: run.promptTokens + run.completionTokens, latencyMs: run.latencyMs,
  });
}

// ---------------------------------------------------------------------------
// traces
// ---------------------------------------------------------------------------
async function traces() {
  const refs = new Map(readJsonl("references.jsonl").map((r) => [r.qid, r]));
  // The first LIMIT originals and their variants
  const originals = readJsonl("questions.jsonl").slice(0, LIMIT);
  const chosen = new Set(originals.map((q) => q.qid));
  const questions = [...originals, ...readJsonl("variants.jsonl").filter((v) => v.qid && chosen.has(v.parent))];
  // A run that errored (teacher unreachable) doesn't count: those questions are run again
  const done = new Set(readJsonl("traces.jsonl").filter((t) => t.status !== "error").map((t) => t.qid));
  const todo = questions.filter((q) => !done.has(q.qid) && refs.get(q.parent ?? q.qid)?.ok);
  console.log(`traces: ${todo.length} questions to run`);
  await pool(todo, async (q) => {
    const ref = refs.get(q.parent ?? q.qid);
    const run = await runAgent({ question: q.question, role: role(q), userId: q.userId, source: "datagen", useCache: false, today: config.today, log: false });
    if (q.expect === "answer") {
      const ok = run.status === "answered" && run.result?.ok && sameResult(ref.result, run.result);
      saveTrace(q, run, ok, ok ? "matches reference" : run.status !== "answered" ? `got ${run.status}` : "different result");
    } else {
      const wanted = q.expect === "refuse" ? "refused" : "clarify";
      saveTrace(q, run, run.status === wanted, run.status === wanted ? q.expect : `expected ${q.expect}, got ${run.status}`);
    }
  });
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
async function exportData() {
  const refs = new Map(readJsonl("references.jsonl").map((r) => [r.qid, r]));
  const kept = readJsonl("traces.jsonl").filter((t) => t.kept);
  // One trace per question (the reference stage can keep several for an original)
  const byQuestion = new Map();
  for (const t of kept) if (!byQuestion.has(t.qid)) byQuestion.set(t.qid, t);

  const stage1 = [];
  const stage2 = [];
  for (const t of byQuestion.values()) {
    const ref = refs.get(t.parent ?? t.qid);
    const meta = { qid: t.qid, template: t.template, expect: t.expect, role: t.role, today: config.today, promptVersion: config.promptVersion };

    // Stage 1: the SQL node's first turn -> the final submit_sql (the teacher's)
    const firstSql = t.calls.find((c) => c.node === "sql");
    if (firstSql) {
      const submit = t.expect === "answer"
        ? { sql: ref.sql, reason: null }
        : JSON.parse([...t.messages].reverse().find((m) => m.tool_calls?.some((c) => c.function.name === "submit_sql"))?.tool_calls.find((c) => c.function.name === "submit_sql").function.arguments ?? "null");
      if (submit) {
        const ctx = await retrieve(t.question, role(t));
        stage1.push({
          messages: [
            { role: "system", content: sqlSystem(role(t), config.today) },
            { role: "user", content: sqlUser(t.question, ctx) },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "submit_sql", arguments: JSON.stringify(submit) } }] },
          ],
          tools: SQL_TOOLS, meta,
        });
      }
    }

    // Stage 2: every node of the kept run, as the teacher did it
    const clarify = t.calls.find((c) => c.node === "clarify");
    if (clarify) stage2.push({ node: "clarify", messages: [...clarify.messages, { role: "assistant", content: clarify.reply.content }], meta });
    if (t.messages?.length) stage2.push({ node: "sql", messages: t.messages, tools: SQL_TOOLS, meta });
    const answer = t.calls.filter((c) => c.node === "answer").at(-1);
    if (answer) stage2.push({ node: "answer", messages: [...answer.messages, { role: "assistant", content: answer.reply.content }], meta });
  }

  const write = (name, rows) => writeFileSync(fileURLToPath(new URL(name, OUT)), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  write("stage1.jsonl", stage1);
  write("stage2.jsonl", stage2);

  const questions = readJsonl("questions.jsonl");
  const variants = readJsonl("variants.jsonl").filter((v) => v.qid);
  const allRefs = [...refs.values()].filter((r) => r.expect === "answer");
  const traced = readJsonl("traces.jsonl");
  const byExpect = Object.fromEntries(["answer", "refuse", "clarify"].map((e) => {
    const ts = [...new Map(traced.filter((t) => t.expect === e).map((t) => [t.qid, t])).values()];
    return [e, { questions: ts.length, kept: ts.filter((t) => byQuestion.has(t.qid)).length }];
  }));
  const stats = {
    config, originals: questions.length, variants: variants.length,
    references: { answerItems: allRefs.length, agreed: allRefs.filter((r) => r.ok).length },
    keptQuestions: byQuestion.size, byExpect,
    stage1Examples: stage1.length, stage2Examples: stage2.length,
    stage2ByNode: Object.fromEntries(["clarify", "sql", "answer"].map((n) => [n, stage2.filter((s) => s.node === n).length])),
  };
  writeFileSync(fileURLToPath(new URL("stats.json", OUT)), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

// ---------------------------------------------------------------------------
const t0 = Date.now();
const teacher = teacherConfig();
if (!/trycloudflare|localhost|127\.0\.0\.1/.test(teacher.baseUrl)) console.log(`note: teacher at ${teacher.baseUrl} (rate-limited hosted APIs make this slow)`);
for (const s of stage === "all" ? ["fill", "reword", "reference", "traces", "export"] : [stage]) {
  console.log(`\n== ${s}`);
  await { fill, reword, reference, traces, export: exportData }[s]();
}
console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)} s`);
await closePool();
await closeOpsPool();
