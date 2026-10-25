// Checks for the model router (src/lib/agent/serving.ts).
//
//   npm run test:serving
//
// Uses the real ops database (the kill switch) and, when STUDENT_BASE_URL is up,
// the real student server; adds and removes its own test row in ops.serving_kills.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import registry from "../ml/registry.json" with { type: "json" };
import { closeOpsPool, opsPool } from "../src/lib/agent/ops-db.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const studentUrl = process.env.STUDENT_BASE_URL;
// A fresh copy of the module (its own probe and kill caches) per scenario
let copies = 0;
const fresh = () => import(`../src/lib/agent/serving.ts?copy=${++copies}`);

let failures = 0;
const expect = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ->  ${detail}` : ""}`);
};

// Buckets: stable, and close to uniform
const { bucket } = await fresh();
const ids = Array.from({ length: 20_000 }, () => randomUUID());
const share = ids.filter((id) => bucket(id) < 10).length / ids.length;
expect("a student always gets the same bucket", ids.slice(0, 100).every((id) => bucket(id) === bucket(id)));
expect("10% canary takes about 10% of students", Math.abs(share - 0.1) < 0.01, `${(100 * share).toFixed(1)}%`);

// No student server configured: the teacher answers
delete process.env.STUDENT_BASE_URL;
let r = await (await fresh()).route(ids[0]);
expect("no student server: fallback to the teacher", r.arm === "fallback" && r.modelId === registry.serving.fallback, `${r.arm} ${r.modelId}`);

// A dead tunnel: fallback, quickly
process.env.STUDENT_BASE_URL = "https://no-such-tunnel-huskyswap.trycloudflare.com/v1";
let t0 = performance.now();
r = await (await fresh()).route(ids[0]);
expect("dead student server: fallback within 3 s", r.arm === "fallback" && performance.now() - t0 < 3000, `${r.arm} in ${Math.round(performance.now() - t0)} ms`);

// The live server (if it's up): production
process.env.STUDENT_BASE_URL = studentUrl;
const serving = await fresh();
r = await serving.route(ids[0]);
if (r.arm === "fallback") console.log(`SKIP  live student server checks (${r.reason})`);
else {
  expect("live student server: production model", r.arm === "production" && r.modelId === registry.serving.production && r.model.model.startsWith("huskyswap-student-"), `${r.arm} ${r.modelId}`);
  t0 = performance.now();
  await serving.route(ids[1]);
  expect("second request reuses the health probe", performance.now() - t0 < 50, `${Math.round(performance.now() - t0)} ms`);

  // A canary (in memory only): a student in the canary bucket gets the candidate, unless it's killed
  const id = ids.find((x) => bucket(x) < 50);
  const other = ids.find((x) => bucket(x) >= 50);
  const saved = { ...registry.serving };
  Object.assign(registry.serving, { candidate: "stage2-r1", canaryPercent: 50 });
  try {
    const canary = await fresh();
    r = await canary.route(id);
    expect("canary bucket: candidate", r.arm === "candidate" && r.modelId === "stage2-r1", `${r.arm} ${r.modelId}`);
    r = await canary.route(other);
    expect("outside the canary bucket: production", r.arm === "production", `${r.arm} ${r.modelId}`);
    r = await canary.route(null);
    expect("no user id: production", r.arm === "production", `${r.arm} ${r.modelId}`);
    await opsPool().query("insert into ops.serving_kills (model_id, reason) values ('stage2-r1', 'test-serving')");
    r = await (await fresh()).route(id);
    expect("killed candidate: production", r.arm === "production", `${r.arm} ${r.modelId}`);
  } finally {
    await opsPool().query("delete from ops.serving_kills where reason = 'test-serving'");
    Object.assign(registry.serving, saved);
  }
}

await closeOpsPool();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll serving checks passed");
process.exitCode = failures ? 1 : 0;
