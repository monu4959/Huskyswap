// Minimal client for OpenAI-compatible chat APIs: the teacher on Groq now, the
// fine-tuned student on vLLM later. Switching models means switching config.

import type { ChatMessage, ToolCall } from "./types.ts";

export type ModelConfig = {
  label: string; // recorded on each run, e.g. "openai/gpt-oss-120b"
  version?: string; // adapter tag for fine-tuned students
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  maxTokens?: number;
};

export function teacherConfig(): ModelConfig {
  const { TEACHER_BASE_URL, TEACHER_API_KEY, TEACHER_MODEL, TEACHER_REASONING_EFFORT } = process.env;
  if (!TEACHER_BASE_URL || !TEACHER_API_KEY || !TEACHER_MODEL) {
    throw new Error("Missing TEACHER_BASE_URL, TEACHER_API_KEY or TEACHER_MODEL in .env.local");
  }
  return {
    label: TEACHER_MODEL,
    baseUrl: TEACHER_BASE_URL,
    apiKey: TEACHER_API_KEY,
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
};

const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait before retrying: the server's retry-after if given, else exponential backoff
function retryDelayMs(response: Response | null, attempt: number) {
  const header = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000 + 250;
  return Math.min(2 ** attempt * 1000, 30_000);
}

// requireTool: the model must call one of the tools (used on the last step, with only submit_answer offered)
export async function chat(cfg: ModelConfig, messages: ChatMessage[], tools: readonly unknown[], requireTool = false): Promise<ChatResult> {
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    tools,
    tool_choice: requireTool ? "required" : "auto",
    max_tokens: cfg.maxTokens ?? 4096,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
  });

  let lastError = "";
  let badToolCalls = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      lastError = `network: ${(e as Error).message}`;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }

    const json = await response.json().catch(() => null);
    if (response.ok && json?.choices?.[0]) {
      const message = json.choices[0].message ?? {};
      return {
        content: message.content || null,
        toolCalls: message.tool_calls ?? [],
        reasoning: message.reasoning ?? message.reasoning_content ?? null,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      };
    }

    lastError = `${response.status}: ${json?.error?.message ?? response.statusText}`;
    // Rate limits and server errors are worth retrying; a malformed tool call (Groq: tool_use_failed) only once
    const badToolCall = json?.error?.code === "tool_use_failed" && ++badToolCalls <= 1;
    // A daily quota (Groq: "tokens per day") won't clear in seconds: fail now instead of waiting minutes
    const dailyQuota = response.status === 429 && /per day|\bTPD\b|\bRPD\b/i.test(lastError);
    const retryable = (response.status === 429 && !dailyQuota) || response.status >= 500 || badToolCall;
    if (!retryable) break;
    await sleep(retryDelayMs(response, attempt));
  }
  throw new Error(`Model call failed after retries (${lastError})`);
}
