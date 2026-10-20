// Checks the semantic cache without calling a model: near-miss questions must
// not hit, paraphrases must, and entries stay inside their role and (for my_*
// SQL) their student. Writes a few test entries and deletes them.
//
//   npm run test:cache

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cacheForgetRun, cacheLookup, cacheStore } from "../src/lib/agent/cache.ts";
import { embed } from "../src/lib/agent/embed.ts";
import { closeOpsPool } from "../src/lib/agent/ops-db.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

let failures = 0;
function report(pass, label, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ->  ${detail}` : ""}`);
}

const runId = randomUUID(); // tags this test's entries for cleanup
const [studentA, studentB] = [randomUUID(), randomUUID()];
const ok = { ok: true, columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
const store = async (question, role, sql, userId = null) => {
  const [vector] = await embed([question]);
  await cacheStore({ question, vector, role, userId, sql, answer: "test", result: ok, runId });
};
const lookup = async (question, role, userId = null) => {
  const [vector] = await embed([question]);
  return cacheLookup(question, vector, role, userId);
};

try {
  await store("how many bikes are listed", "nlq_student", "select count(*) from nlq.listings where category = 'bikes_transport'");
  await store("cheapest bike for sale", "nlq_student", "select title, sale_price from nlq.listings order by sale_price limit 1");
  await store("top 5 meetup spots by completed deals", "nlq_admin", "select 1");
  await store("listings posted this week", "nlq_admin", "select 1");
  await store("bikes that sold in fall 2024", "nlq_admin", "select 1");
  await store("how much have I earned from selling", "nlq_student", "select sum(agreed_price) from nlq.my_deals", studentA);

  console.log("Should hit");
  for (const [q, role, user] of [
    ["number of bike listings", "nlq_student"],
    ["How many bikes are listed?", "nlq_student"],
    ["how much have i earned from selling", "nlq_student", studentA],
  ]) {
    const hit = await lookup(q, role, user ?? null);
    report(!!hit, `"${q}"`, hit ? `hit "${hit.question}" (${hit.similarity.toFixed(3)})` : "miss");
  }

  console.log("\nShould miss");
  for (const [q, role, user, why] of [
    ["most expensive bike for sale", "nlq_student", null, "cheapest vs most expensive"],
    ["top 3 meetup spots by completed deals", "nlq_admin", null, "5 vs 3"],
    ["listings posted last week", "nlq_admin", null, "this week vs last week"],
    ["bikes that did not sell in fall 2024", "nlq_admin", null, "sold vs not sold"],
    ["how many bikes are listed", "nlq_admin", null, "student entry, admin asking"],
    ["how much have I earned from selling", "nlq_student", studentB, "another student's my_* entry"],
    ["how much have I earned from selling", "nlq_student", null, "my_* entry, nobody signed in"],
  ]) {
    const hit = await lookup(q, role, user);
    report(!hit, `"${q}" (${why})`, hit ? `HIT "${hit.question}" (${hit.similarity.toFixed(3)})` : "miss");
  }
} finally {
  await cacheForgetRun(runId);
  await closeOpsPool();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll cache checks passed");
process.exitCode = failures ? 1 : 0;
