// Re-score an eval report after changing the gold queries or the comparison,
// without calling a model: each answered item's saved SQL is run again and
// compared with the current gold. The report is rewritten in place.
//
//   npm run eval:rescore -- eval/reports/2026-10-20-teacher-gpt-oss-120b-v3.json
//   npm run eval:rescore -- <report.json> --set=eval/test-set.json     a report on the test set

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareResults, projectColumns } from "../src/lib/agent/compare.ts";
import { closePool, runSelect } from "../src/lib/agent/db.ts";
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const path = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!path) throw new Error("Usage: npm run eval:rescore -- <report.json>");
const report = JSON.parse(readFileSync(path, "utf8"));
const setPath = process.argv.find((a) => a.startsWith("--set="))?.slice(6) ?? "eval/eval-set.json";
const set = JSON.parse(readFileSync(new URL(`../${setPath}`, import.meta.url), "utf8"));
if (report.summary.evalSet !== set.version) throw new Error(`Report is on ${report.summary.evalSet}, not ${set.version}: pass --set`);
const { rows: [topStudent] } = await opsPool().query(
  "with u as (select buyer_id as id from nlq.deals union all select seller_id from nlq.deals) select id::text from u group by id order by count(*) desc limit 1",
);

let changed = 0;
for (const r of report.results.filter((x) => x.expect === "answer" && x.status === "answered" && x.sql)) {
  const item = set.items.find((i) => i.id === r.id);
  const role = item.role === "admin" ? "nlq_admin" : "nlq_student";
  const userId = item.as_user === "top_student" ? topStudent.id : null;
  const pred = await runSelect(r.sql, role, [], { userId });
  let correct = false;
  let reason = pred.ok ? "" : `prediction failed: ${pred.error}`;
  for (const [i, sql] of [item.gold_sql, ...(item.accept_sql ?? [])].entries()) {
    if (!pred.ok) break;
    const gold = await runSelect(sql, role, [], { userId });
    const c = gold.ok ? compareResults(i === 0 ? projectColumns(gold, item.compare_columns) : gold, pred, item.order_matters ?? false) : { match: false, reason: "gold failed" };
    if (i === 0) reason = c.reason;
    if (c.match) {
      correct = true;
      reason = i === 0 ? c.reason : `matches accepted reading ${i}`;
      break;
    }
  }
  if (correct !== r.correct) {
    changed++;
    console.log(`${r.id}: ${r.correct ? "✓" : "✗"} -> ${correct ? "✓" : "✗"}  (${reason})`);
  }
  Object.assign(r, { correct, reason });
}

const pct = (rs) => (rs.length ? Math.round((1000 * rs.filter((x) => x.correct).length) / rs.length) / 10 : null);
const s = report.summary;
s.executionAccuracy = pct(report.results.filter((x) => x.expect === "answer"));
s.overall = pct(report.results);
const byDiff = Object.groupBy(report.results, (x) => x.difficulty);
s.byDifficulty = Object.fromEntries(Object.entries(byDiff).map(([k, rs]) => [k, { n: rs.length, accuracy: pct(rs) }]));
s.rescoredAt = new Date().toISOString();
writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
console.log(`${changed} item(s) changed · execution accuracy ${s.executionAccuracy}% · overall ${s.overall}%`);

await closePool();
await closeOpsPool();
