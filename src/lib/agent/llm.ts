// Minimal client for OpenAI-compatible chat APIs: the teacher on Groq now, the
// fine-tuned student on vLLM later. Switching models means switching config.
//
// Several API keys can share the load (TEACHER_API_KEYS): requests go round-robin,
// and a key that hits a rate limit is parked for as long as the server says,
// while the request moves on to the next free key.

import type { ChatMessage, ToolCall } from "./types.ts";

export type ModelConfig = {
  label: string; // recorded on each run, e.g. "openai/gpt-oss-120b"
  version?: string; // adapter tag for fine-tuned students
  baseUrl: string;
  apiKeys: string[];
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  maxTokens?: number;
};

export function teacherConfig(): ModelConfig {
  const { TEACHER_BASE_URL, TEACHER_API_KEY, TEACHER_API_KEYS, TEACHER_MODEL, TEACHER_REASONING_EFFORT } = process.env;
  const apiKeys = [...new Set([TEACHER_API_KEY, ...(TEACHER_API_KEYS ?? "").split(",")].map((k) => k?.trim()).filter((k): k is string => !!k))];
  if (!TEACHER_BASE_URL || !apiKeys.length || !TEACHER_MODEL) {
    throw new Error("Missing TEACHER_BASE_URL, TEACHER_API_KEY(S) or TEACHER_MODEL in .env.local");
  }
  return {
    label: TEACHER_MODEL,
    baseUrl: TEACHER_BASE_URL,
    apiKeys,
    model: TEACHER_MODEL,
    reasoningEffort: (TEACHER_REASONING_EFFORT as ModelConfig["reasoningEffort"]) ?? "medium",
  };
}

export type ChatResult = {
  content: string | null;
  toolCalls: ToolCall[];
  reasoning: string | null;
  promptTokens: number;
  completionTokens: number;
  waitedMs: number; // time spent waiting out rate limits and retries
};

const MAX_ATTEMPTS = 6; // network and server errors
const MAX_RATE_LIMITS = 30; // 429s across all keys in one call
const MAX_WAIT_MS = 65_000; // longer than this for every key = out of quota for now
const MAX_TOTAL_WAIT_MS = 90_000; // give up on one call after this much waiting in total
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Key pool
// ---------------------------------------------------------------------------
type KeyState = { key: string; parkedUntil: number };
const pools = new Map<string, { keys: KeyState[]; next: number }>();

function poolFor(cfg: ModelConfig) {
  const id = `${cfg.baseUrl}|${cfg.apiKeys.join(",")}`;
  let pool = pools.get(id);
  if (!pool) {
    pool = { keys: cfg.apiKeys.map((key) => ({ key, parkedUntil: 0 })), next: 0 };
    pools.set(id, pool);
  }
  return pool;
}

// The next free key (round-robin), or how long until one frees up
function pick(pool: { keys: KeyState[]; next: number }): KeyState | { waitMs: number } {
  const now = Date.now();
  for (let i = 0; i < pool.keys.length; i++) {
    const index = (pool.next + i) % pool.keys.length;
    if (pool.keys[index].parkedUntil <= now) {
      pool.next = (index + 1) % pool.keys.length;
      return pool.keys[index];
    }
  }
  return { waitMs: Math.min(...pool.keys.map((k) => k.parkedUntil)) - now };
}

// How long a rate-limited key must rest: Groq says "try again in 2m33.36s" or "in 510ms";
// else retry-after; else 10 s
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
function restMs(response: Response, message: string) {
  const phrase = message.match(/try again in ((?:[\d.]+(?:ms|h|m|s))+)/i)?.[1];
  if (phrase) {
    const ms = [...phrase.matchAll(/([\d.]+)(ms|h|m|s)/gi)].reduce((sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit.toLowerCase()], 0);
    return ms + 250;
  }
  const header = Number(response.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 + 250 : 10_000;
}

const backoffMs = (attempt: number) => Math.min(2 ** attempt * 1000, 30_000);

// tools: offered tools (none for plain replies). requireTool: the model must call one.
// json: the reply must be a JSON object (nodes that return a decision, not a tool call).
export async function chat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  { tools = [], requireTool = false, json = false }: { tools?: readonly unknown[]; requireTool?: boolean; json?: boolean } = {},
): Promise<ChatResult> {
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    ...(tools.length ? { tools, tool_choice: requireTool ? "required" : "auto" } : {}),
    ...(json ? { response_format: { type: "json_object" } } : {}),
    max_tokens: cfg.maxTokens ?? 4096,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
  });
  const pool = poolFor(cfg);

  let lastError = "";
  let attempts = 0;
  let rateLimits = 0;
  let badToolCalls = 0;
  let waitedMs = 0;
  const wait = async (ms: number) => {
    await sleep(ms);
    waitedMs += ms;
  };
  while (attempts < MAX_ATTEMPTS && rateLimits < MAX_RATE_LIMITS) {
    const picked = pick(pool);
    if ("waitMs" in picked) {
      if (picked.waitMs > MAX_WAIT_MS) {
        const minutes = Math.ceil(picked.waitMs / 60_000);
        throw new Error(`All ${pool.keys.length} API key(s) are rate-limited; the first frees up in about ${minutes} min (${lastError || "limit hit by an earlier call"})`);
      }
      if (waitedMs + picked.waitMs > MAX_TOTAL_WAIT_MS) {
        throw new Error(`Rate-limited for too long (${Math.round(waitedMs / 1000)} s waited; ${lastError || "limit hit by an earlier call"})`);
      }
      await wait(picked.waitMs);
      continue;
    }

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${picked.key}` },
        body,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      lastError = `network: ${(e as Error).message}`;
      await wait(backoffMs(attempts++));
      continue;
    }

    const reply = await response.json().catch(() => null);
    if (response.ok && reply?.choices?.[0]) {
      const message = reply.choices[0].message ?? {};
      return {
        content: message.content || null,
        toolCalls: message.tool_calls ?? [],
        reasoning: message.reasoning ?? message.reasoning_content ?? null,
        promptTokens: reply.usage?.prompt_tokens ?? 0,
        completionTokens: reply.usage?.completion_tokens ?? 0,
        waitedMs,
      };
    }

    lastError = `${response.status}: ${reply?.error?.message ?? response.statusText}`;
    if (response.status === 429) {
      // Park this key (minutes for a daily quota, seconds for a per-minute one) and try the next
      picked.parkedUntil = Date.now() + restMs(response, lastError);
      rateLimits++;
      continue;
    }
    if (response.status >= 500) {
      await wait(backoffMs(attempts++));
      continue;
    }
    // A malformed tool call (Groq: tool_use_failed) is retried once; other errors are final
    if (reply?.error?.code === "tool_use_failed" && ++badToolCalls <= 1) continue;
    break;
  }
  throw new Error(`Model call failed after retries (${lastError})`);
}
