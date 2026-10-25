// The model registry (ml/registry.json): which model versions exist, how each was
// trained, its eval reports, and which one serves.
//
//   npm run registry                                  every model with scores computed from its reports
//   npm run registry -- check                         verify the registry (run by CI)
//   npm run registry -- promote stage2-r3 --gate=eval/gates/<gate>.json --reason="..."
//   npm run registry -- canary stage2-r3 10 --gate=eval/gates/<gate>.json --reason="..."
//   npm run registry -- rollback --reason="..."       end the canary, or else go back to the previous production model
//
// Promoting a model or starting a canary needs a passing gate report for that model
// against the current production model (npm run gate). Rolling back needs no gate:
// it has to be fast. Every change is appended to the registry's history.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const REGISTRY = new URL("../ml/registry.json", import.meta.url);
const REPORTS = new URL("../eval/reports/", import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const [command = "list", ...rest] = args.filter((a) => !a.startsWith("--"));

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const setVersion = (file) => JSON.parse(readFileSync(new URL(`../eval/${file}`, import.meta.url), "utf8")).version;
const SETS = { dev: setVersion("eval-set.json"), test: setVersion("test-set.json") };
const model = (id) => registry.models.find((m) => m.id === id);
const report = (file) => JSON.parse(readFileSync(new URL(file, REPORTS), "utf8")).summary;
const readGate = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

// Mean of each score over a model's dev runs, and its test scores
const KEYS = ["executionAccuracy", "refuseAccuracy", "clarifyAccuracy", "overall"];
function scores(m) {
  const dev = m.evals.dev.map(report);
  const mean = (k) => (dev.length ? Math.round((10 * dev.reduce((s, r) => s + r[k], 0)) / dev.length) / 10 : null);
  const test = m.evals.test ? report(m.evals.test) : null;
  return { devRuns: dev.length, dev: Object.fromEntries(KEYS.map((k) => [k, mean(k)])), test: test && Object.fromEntries(KEYS.map((k) => [k, test[k]])) };
}

// Everything that must hold; returns a list of problems
function problems() {
  const out = [];
  const { serving, models, history } = registry;
  const ids = new Set();
  for (const m of models) {
    if (ids.has(m.id)) out.push(`duplicate model id ${m.id}`);
    ids.add(m.id);
    for (const [kind, files] of [["dev", m.evals.dev], ["test", m.evals.test ? [m.evals.test] : []]]) {
      for (const file of files) {
        if (!existsSync(new URL(file, REPORTS))) {
          out.push(`${m.id}: report ${file} is missing`);
          continue;
        }
        const s = report(file);
        if (s.model !== m.served) out.push(`${m.id}: ${file} is a report on ${s.model}, not ${m.served}`);
        if (s.promptVersion !== m.prompt) out.push(`${m.id}: ${file} used prompt ${s.promptVersion}, not ${m.prompt}`);
        if (s.evalSet !== SETS[kind]) out.push(`${m.id}: ${file} is on ${s.evalSet}, but ${kind} reports must be on ${SETS[kind]}`);
        if (s.errors) out.push(`${m.id}: ${file} has ${s.errors} errored item(s); rerun them with npm run eval -- --update=`);
      }
    }
  }
  for (const role of ["production", "fallback"]) if (!model(serving[role])) out.push(`serving.${role} ${serving[role]} isn't a registered model`);
  const withStatus = (s) => models.filter((m) => m.status === s).map((m) => m.id);
  if (withStatus("production").join() !== serving.production) out.push(`exactly one model, ${serving.production}, should have status production (have: ${withStatus("production").join(", ") || "none"})`);
  if (withStatus("candidate").join() !== (serving.candidate ?? "")) out.push(`status candidate should match serving.candidate (${serving.candidate})`);
  if (model(serving.fallback)?.status !== "fallback") out.push(`the fallback model ${serving.fallback} should have status fallback`);
  if (serving.candidate && !model(serving.candidate)) out.push(`serving.candidate ${serving.candidate} isn't a registered model`);
  if (!Number.isInteger(serving.canaryPercent) || serving.canaryPercent < 0 || serving.canaryPercent > 50) out.push("canaryPercent must be a whole number from 0 to 50");
  if (!serving.candidate && serving.canaryPercent) out.push("canaryPercent must be 0 without a candidate");
  if (serving.candidate && !serving.canaryPercent) out.push("a candidate needs a canaryPercent above 0");

  // The history must explain the current state, and every gated change must have its passing gate
  const lastProduction = history.filter((h) => h.action === "promote" || h.action === "rollback").at(-1);
  if (lastProduction?.model !== serving.production) out.push(`the last promote/rollback in history is ${lastProduction?.model}, but production is ${serving.production}`);
  const lastCanary = history.filter((h) => h.action === "canary" || h.action === "end-canary" || h.action === "promote").at(-1);
  if (serving.candidate && (lastCanary?.action !== "canary" || lastCanary.model !== serving.candidate)) out.push(`no canary entry in history for ${serving.candidate}`);
  for (const h of history) {
    if (!h.gate) {
      // The CLI never writes gateWaived, so a waiver is a hand edit that shows up in review
      if ((h.action === "promote" || h.action === "canary") && !h.gateWaived) out.push(`history: ${h.action} ${h.model} on ${h.at} has no gate`);
      continue;
    }
    if (!existsSync(new URL(`../${h.gate}`, import.meta.url))) {
      out.push(`history: gate ${h.gate} is missing`);
      continue;
    }
    const g = readGate(h.gate);
    if (!g.passed) out.push(`history: ${h.action} ${h.model} used gate ${h.gate}, which failed`);
    if (g.candidate !== h.model) out.push(`history: ${h.action} ${h.model} used gate ${h.gate}, which tested ${g.candidate}`);
  }
  return out;
}

// A passing gate for this candidate against the current production model
function requireGate(id) {
  const path = flag("gate");
  if (!path) throw new Error("--gate=eval/gates/<file>.json is required (npm run gate)");
  const g = readGate(path);
  if (g.candidate !== id) throw new Error(`${path} tested ${g.candidate}, not ${id}`);
  if (g.baseline !== registry.serving.production) throw new Error(`${path} compared against ${g.baseline}, but production is now ${registry.serving.production}: rerun the gate`);
  if (!g.passed) throw new Error(`${path} failed: ${g.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`);
  return path;
}

function save(entry) {
  const reason = flag("reason");
  if (!reason) throw new Error('--reason="..." is required: it goes in the history');
  let by = null;
  try {
    by = execSync("git config user.name", { encoding: "utf8" }).trim() || null;
  } catch {}
  registry.history.push({ at: new Date().toISOString().slice(0, 10), ...entry, by, reason });
  const found = problems();
  if (found.length) throw new Error(`refusing to save a broken registry:\n  ${found.join("\n  ")}`);
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
  console.log(`${entry.action} ${entry.model}: saved ml/registry.json. Commit it to make the change take effect.`);
}

const pct = (v) => (v === null || v === undefined ? "   -" : v.toFixed(1).padStart(5));

if (command === "list") {
  const { serving } = registry;
  console.log(`production: ${serving.production} · fallback: ${serving.fallback} · canary: ${serving.candidate ? `${serving.candidate} at ${serving.canaryPercent}%` : "none"}\n`);
  console.log("model        status       dev EX / overall (runs)    test EX / refuse / clarify / overall");
  for (const m of registry.models) {
    const s = scores(m);
    const dev = `${pct(s.dev.executionAccuracy)} / ${pct(s.dev.overall)} (${s.devRuns})`;
    const test = s.test ? `${pct(s.test.executionAccuracy)} / ${pct(s.test.refuseAccuracy)} / ${pct(s.test.clarifyAccuracy)} / ${pct(s.test.overall)}` : "   not run";
    console.log(`${m.id.padEnd(12)} ${m.status.padEnd(12)} ${dev.padEnd(26)} ${test}`);
  }
} else if (command === "check") {
  const found = problems();
  for (const p of found) console.log(`FAIL  ${p}`);
  console.log(found.length ? `\n${found.length} registry problem(s)` : `registry ok: ${registry.models.length} models, production ${registry.serving.production}`);
  process.exitCode = found.length ? 1 : 0;
} else if (command === "promote") {
  const [id] = rest;
  const m = model(id);
  if (!m) throw new Error(`no model ${id} in the registry`);
  if (id === registry.serving.production) throw new Error(`${id} is already production`);
  const gate = requireGate(id);
  const from = registry.serving.production;
  model(from).status = "retired";
  m.status = "production";
  Object.assign(registry.serving, { production: id, candidate: null, canaryPercent: 0 });
  save({ action: "promote", model: id, from, gate });
} else if (command === "canary") {
  const [id, percent] = rest;
  const m = model(id);
  if (!m) throw new Error(`no model ${id} in the registry`);
  if (registry.serving.candidate && registry.serving.candidate !== id) throw new Error(`${registry.serving.candidate} is already in canary: roll it back or promote it first`);
  const gate = requireGate(id);
  m.status = "candidate";
  Object.assign(registry.serving, { candidate: id, canaryPercent: Number(percent) });
  save({ action: "canary", model: id, percent: Number(percent), gate });
} else if (command === "rollback") {
  const { serving } = registry;
  if (serving.candidate) {
    const id = serving.candidate;
    model(id).status = "retired";
    Object.assign(serving, { candidate: null, canaryPercent: 0 });
    save({ action: "end-canary", model: id });
  } else {
    const last = registry.history.filter((h) => h.action === "promote" || h.action === "rollback").at(-1);
    if (!last?.from) throw new Error("no earlier production model to go back to");
    const to = last.from;
    model(serving.production).status = "retired";
    model(to).status = "production";
    const from = serving.production;
    serving.production = to;
    save({ action: "rollback", model: to, from });
  }
} else {
  throw new Error(`unknown command ${command}: use list, check, promote, canary or rollback`);
}
