// The eval gate: may this model replace production? Runs the dev set (the pilot,
// eval/eval-set.json) against a registered candidate and compares it with the
// production model's dev runs in ml/registry.json. The held-out test set is never
// used here, so it stays a fair final measure.
//
//   npm run gate -- --candidate=stage2-r3                  3 dev runs (needs the candidate's server up)
//   npm run gate -- --candidate=stage2-r3 --runs=1
//   npm run gate -- --candidate=stage2-r1 --reports=a.json,b.json   judge existing dev reports, no new runs
//
// Checks (run-to-run noise on 50 questions is about ±4 points, hence the margins):
//   no errors        every item finished in every run (else rerun: it's the server, not the model)
//   overall          mean overall ≥ production − 3 points
//   SQL              mean execution accuracy ≥ production − 5 points
//   refusals         every refuse item production gets right (in most runs) the candidate gets right too
//   clarifications   the same for clarify items
//   tokens           mean tokens per question ≤ 1.5 × production
//
// Writes eval/gates/<date>-<candidate>-vs-<production>.json and adds the new run
// reports to the candidate's dev evals in the registry. Exit code 1 if it fails.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REGISTRY = new URL("../ml/registry.json", import.meta.url);
const REPORTS = new URL("../eval/reports/", import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const candidate = registry.models.find((m) => m.id === flag("candidate"));
if (!candidate) throw new Error("--candidate=<id> must be a model in ml/registry.json (add its entry first, with an empty evals.dev)");
const production = registry.models.find((m) => m.id === registry.serving.production);
if (candidate.id === production.id) throw new Error(`${candidate.id} is already production`);
const date = new Date().toISOString().slice(0, 10);

// The candidate's dev runs: given, or run now
let files = flag("reports")?.split(",");
if (!files) {
  files = [];
  const runs = Number(flag("runs") ?? 3);
  for (let i = 1; i <= runs; i++) {
    const label = `gate-${candidate.id}-run${i}`;
    const modelArgs = candidate.kind === "student" ? ["--model=student", `--student-model=${candidate.served}`] : [];
    console.log(`\n=== gate run ${i}/${runs}: ${candidate.id} on the dev set ===`);
    execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/eval.mjs", ...modelArgs, "--parallel=4", `--label=${label}`], { stdio: "inherit" });
    files.push(`${date}-${label}.json`);
  }
}

const load = (file) => JSON.parse(readFileSync(new URL(file, REPORTS), "utf8"));
const cand = files.map(load);
const base = production.evals.dev.map(load);
for (const r of cand) {
  if (r.summary.model !== candidate.served) throw new Error(`a report is on ${r.summary.model}, not ${candidate.served}`);
  if (r.summary.evalSet !== base[0].summary.evalSet) throw new Error(`a report is on ${r.summary.evalSet}, not the dev set ${base[0].summary.evalSet}`);
}

const mean = (reports, key) => Math.round((10 * reports.reduce((s, r) => s + r.summary[key], 0)) / reports.length) / 10;
// Items a model gets right in most of its runs
const mostlyRight = (reports, expect) => {
  const ids = reports[0].results.filter((r) => r.expect === expect).map((r) => r.id);
  return ids.filter((id) => reports.filter((rep) => rep.results.find((r) => r.id === id)?.correct).length * 2 > reports.length);
};
const lost = (expect) => {
  const kept = new Set(mostlyRight(cand, expect));
  return mostlyRight(base, expect).filter((id) => !kept.has(id));
};

const checks = [];
const check = (name, passed, detail) => checks.push({ name, passed, detail });
const errors = cand.reduce((s, r) => s + r.summary.errors, 0);
check("no errors", errors === 0, `${errors} errored item(s) across ${cand.length} run(s)`);
const [co, po] = [mean(cand, "overall"), mean(base, "overall")];
check("overall", co >= po - 3, `${co}% vs production ${po}% (margin 3)`);
const [ce, pe] = [mean(cand, "executionAccuracy"), mean(base, "executionAccuracy")];
check("SQL", ce >= pe - 5, `execution accuracy ${ce}% vs production ${pe}% (margin 5)`);
for (const [name, expect] of [["refusals", "refuse"], ["clarifications", "clarify"]]) {
  const ids = lost(expect);
  check(name, ids.length === 0, ids.length ? `production gets ${ids.join(", ")} right, the candidate doesn't` : `keeps all ${mostlyRight(base, expect).length} that production gets right`);
}
const [ct, pt] = [mean(cand, "avgTokens"), mean(base, "avgTokens")];
check("tokens", ct <= pt * 1.5, `${Math.round(ct)} tokens per question vs production ${Math.round(pt)} (limit 1.5x)`);

const passed = checks.every((c) => c.passed);
const gate = {
  candidate: candidate.id, baseline: production.id, evalSet: base[0].summary.evalSet, ranAt: new Date().toISOString(),
  runs: flag("reports") ? "existing reports" : "new runs", passed, checks,
  reports: { candidate: files, baseline: production.evals.dev },
};
const dir = new URL("../eval/gates/", import.meta.url);
mkdirSync(dir, { recursive: true });
const name = `${date}-${candidate.id}-vs-${production.id}.json`;
writeFileSync(new URL(name, dir), JSON.stringify(gate, null, 2) + "\n");

// Record the new runs under the candidate (only runs made here, so a --reports dry run changes nothing)
if (!flag("reports")) {
  candidate.evals.dev = [...new Set([...candidate.evals.dev, ...files])];
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
}

console.log(`\n=== gate: ${candidate.id} vs production ${production.id} on ${gate.evalSet} (${cand.length} run(s) vs ${base.length}) ===`);
for (const c of checks) console.log(`${c.passed ? "PASS" : "FAIL"}  ${c.name.padEnd(15)} ${c.detail}`);
console.log(`\n${passed ? "PASSED" : "FAILED"}: eval/gates/${name}`);
if (passed) console.log(`next: npm run registry -- canary ${candidate.id} 10 --gate=eval/gates/${name} --reason="..."   (or promote)`);
process.exitCode = passed ? 0 : 1;
