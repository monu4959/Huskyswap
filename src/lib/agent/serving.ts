// Which model answers a question in the app, per ml/registry.json:
//
//   * the production model, or, for canaryPercent of students (a stable hash of
//     their id, so each student keeps the same model), the candidate
//   * the fallback (the teacher) when that model's server isn't up: the student
//     runs on Colab on demand, so it is often offline
//   * a candidate in ops.serving_kills is skipped at once (the canary off switch)
//
// Runs are logged with the registry id as model_version, so the canary check can
// compare the two models on real traffic.

import { createHash } from "node:crypto";
import registry from "../../../ml/registry.json" with { type: "json" };
import { teacherConfig, type ModelConfig } from "./llm.ts";
import { opsPool } from "./ops-db.ts";

type Entry = (typeof registry.models)[number];
export type Route = { arm: "production" | "candidate" | "fallback"; modelId: string; model: ModelConfig; reason: string | null };

const TTL_MS = 30_000; // how long a health probe or the kill list is trusted
const PROBE_MS = 2_500;

const entry = (id: string) => {
  const found = registry.models.find((m) => m.id === id);
  if (!found) throw new Error(`ml/registry.json has no model ${id}`);
  return found;
};

// 0-99, the same for a student every time
export const bucket = (userId: string) => createHash("sha256").update(userId).digest().readUInt32BE(0) % 100;

function configFor(m: Entry): ModelConfig | null {
  if (m.kind === "teacher") return { ...teacherConfig(), version: m.id };
  const { STUDENT_BASE_URL, STUDENT_API_KEY } = process.env;
  if (!STUDENT_BASE_URL) return null;
  return { label: m.served, version: m.id, baseUrl: STUDENT_BASE_URL, apiKeys: [STUDENT_API_KEY ?? "none"], model: m.served };
}

// Is the server up and serving this model (adapter)? One probe per 30 s
let health: { at: number; baseUrl: string; models: string[] } | null = null;
async function serves(cfg: ModelConfig): Promise<boolean> {
  if (!health || health.baseUrl !== cfg.baseUrl || Date.now() - health.at > TTL_MS) {
    let models: string[] = [];
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${cfg.apiKeys[0]}` },
        signal: AbortSignal.timeout(PROBE_MS),
      });
      if (res.ok) models = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    } catch {}
    health = { at: Date.now(), baseUrl: cfg.baseUrl, models };
  }
  return health.models.includes(cfg.model);
}

// After a run fails on the student server: treat it as down until the next probe
export function markDown(cfg: ModelConfig) {
  health = { at: Date.now(), baseUrl: cfg.baseUrl, models: [] };
}

let kills: { at: number; ids: Set<string> } | null = null;
async function killed(id: string): Promise<boolean> {
  if (!kills || Date.now() - kills.at > TTL_MS) {
    const { rows } = await opsPool().query<{ model_id: string }>("select model_id from ops.serving_kills");
    kills = { at: Date.now(), ids: new Set(rows.map((r) => r.model_id)) };
  }
  return kills.ids.has(id);
}

export async function route(userId: string | null): Promise<Route> {
  const { serving } = registry;
  let arm: Route["arm"] = "production";
  let chosen = entry(serving.production);
  if (serving.candidate && userId && bucket(userId) < serving.canaryPercent && !(await killed(serving.candidate))) {
    arm = "candidate";
    chosen = entry(serving.candidate);
  }
  const cfg = configFor(chosen);
  if (cfg && (chosen.kind === "teacher" || (await serves(cfg)))) return { arm, modelId: chosen.id, model: cfg, reason: null };
  return fallback(`${chosen.id} unavailable`);
}

export function fallback(reason: string): Route {
  const m = entry(registry.serving.fallback);
  return { arm: "fallback", modelId: m.id, model: configFor(m)!, reason };
}
