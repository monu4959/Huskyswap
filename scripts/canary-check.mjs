// Is the canary model doing as well as production on real questions? Compares
// app runs (ops.agent_runs, source 'app') of the two since the canary started.
//
//   npm run canary:check              report only
//   npm run canary:check -- --apply   on failure: switch the candidate off now (ops.serving_kills,
//                                     the app stops routing to it within 30 s) and roll back the
//                                     registry; commit ml/registry.json afterwards. In CI (the
//                                     nightly monitor) only the switch flips: a person rolls back
//
// Fails when, with enough runs to tell:
//   failures     the candidate's errors + give-ups exceed production's by more than 10 points (≥ 10 runs)
//   thumbs-down  its share of thumbs-down ratings exceeds production's by more than 15 points (≥ 5 ratings)
//   latency      its p95 latency is over 2x production's (≥ 10 runs)
// With 30+ candidate runs and no failure, it's ready to promote.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const apply = process.argv.includes("--apply");
const registry = JSON.parse(readFileSync(new URL("../ml/registry.json", import.meta.url), "utf8"));
const { production, candidate } = registry.serving;
if (!candidate) {
  console.log(`no canary running (production: ${production})`);
  process.exit(0);
}
const since = registry.history.filter((h) => h.action === "canary" && h.model === candidate).at(-1).at;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(
  `select model_version,
          count(*)::int as runs,
          count(*) filter (where status in ('error', 'gave_up'))::int as failures,
          count(feedback)::int as ratings,
          count(*) filter (where feedback = -1)::int as thumbs_down,
          percentile_disc(0.95) within group (order by latency_ms) as p95_ms
   from ops.agent_runs
   where source = 'app' and created_at >= $1::date and model_version = any($2)
   group by model_version`,
  [since, [production, candidate]],
);
const stats = (id) => rows.find((r) => r.model_version === id) ?? { runs: 0, failures: 0, ratings: 0, thumbs_down: 0, p95_ms: null };
const [c, p] = [stats(candidate), stats(production)];
const rate = (n, d) => (d ? (100 * n) / d : 0);

const problems = [];
if (c.runs >= 10 && rate(c.failures, c.runs) > rate(p.failures, p.runs) + 10) problems.push("failures");
if (c.ratings >= 5 && rate(c.thumbs_down, c.ratings) > rate(p.thumbs_down, p.ratings) + 15) problems.push("thumbs-down");
if (c.runs >= 10 && p.p95_ms && c.p95_ms > 2 * p.p95_ms) problems.push("latency");

console.log(`canary ${candidate} (${registry.serving.canaryPercent}%) vs production ${production}, app runs since ${since}\n`);
console.log("model            runs   errors+give-ups   thumbs-down        p95");
for (const [id, s] of [[candidate, c], [production, p]]) {
  console.log(`${id.padEnd(16)} ${String(s.runs).padStart(4)}   ${rate(s.failures, s.runs).toFixed(1).padStart(14)}%   ${`${s.thumbs_down}/${s.ratings}`.padStart(11)}   ${s.p95_ms ? `${(s.p95_ms / 1000).toFixed(1)} s` : "-"}`);
}

if (problems.length) {
  console.log(`\nFAIL: ${problems.join(", ")}`);
  if (apply) {
    await db.query(
      "insert into ops.serving_kills (model_id, reason) values ($1, $2) on conflict (model_id) do update set killed_at = now(), reason = excluded.reason",
      [candidate, `canary check failed: ${problems.join(", ")}`],
    );
    console.log(`${candidate} switched off (ops.serving_kills); the app stops routing to it within 30 s`);
    if (process.env.CI) console.log("roll back the registry too: npm run registry -- rollback --reason=...");
    else execFileSync(process.execPath, ["scripts/registry.mjs", "rollback", `--reason=canary check failed: ${problems.join(", ")}`], { stdio: "inherit" });
  } else {
    console.log("rerun with --apply to switch it off and roll back");
  }
} else if (c.runs >= 30) {
  console.log(`\nhealthy after ${c.runs} runs: ready to promote (npm run registry -- promote ${candidate} --gate=<its gate> --reason="...")`);
} else {
  console.log(`\nno problems yet; ${30 - c.runs} more candidate run(s) before it can be judged ready`);
}
await db.end();
process.exitCode = problems.length ? 1 : 0;
