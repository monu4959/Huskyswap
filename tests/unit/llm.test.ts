// chat(): the OpenAI-compatible client's request shape, key rotation, rate-limit
// parking and retries, against a stubbed fetch with fake timers. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat, teacherConfig, type ModelConfig } from "@/lib/agent/llm.ts";

let seq = 0;
// A fresh base URL per test: key pools are module-level and keyed by URL + keys
const cfg = (o: Partial<ModelConfig> = {}): ModelConfig => ({ label: "m", baseUrl: `https://llm-${++seq}.invalid/v1/`, apiKeys: ["k1"], model: "m", ...o });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const okBody = (message: Record<string, unknown> = { content: "hi" }, usage = { prompt_tokens: 11, completion_tokens: 3 }) => ({ choices: [{ message }], usage });
const rateLimited = (message: string, headers: Record<string, string> = {}) => json(429, { error: { message } }, headers);

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const keyOf = (i: number) => (fetchMock.mock.calls[i][1].headers as Record<string, string>).authorization;
const bodyOf = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body as string);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
});

// Run a chat call to completion, letting its sleeps elapse on the fake clock
async function settle<T>(p: Promise<T>): Promise<T> {
  const caught = p.then((v) => ({ v }), (e: unknown) => ({ e }));
  await vi.runAllTimersAsync();
  const r = await caught;
  if ("e" in r) throw r.e;
  return r.v;
}

describe("chat: request and reply", () => {
  it("posts to /chat/completions with the model, messages and defaults", async () => {
    fetchMock.mockResolvedValueOnce(json(200, okBody()));
    const c = cfg({ reasoningEffort: "low", temperature: 0 });
    const out = await settle(chat(c, [{ role: "user", content: "q" }]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(c.baseUrl.replace(/\/$/, "") + "/chat/completions");
    expect(init.method).toBe("POST");
    expect(keyOf(0)).toBe("Bearer k1");
    expect(bodyOf(0)).toEqual({ model: "m", messages: [{ role: "user", content: "q" }], max_tokens: 4096, temperature: 0, reasoning_effort: "low" });
    expect(out).toEqual({ content: "hi", toolCalls: [], reasoning: null, promptTokens: 11, completionTokens: 3, waitedMs: 0 });
  });

  it("offers tools (auto or required) and asks for JSON when told to", async () => {
    fetchMock.mockImplementation(async () => json(200, okBody()));
    const tools = [{ type: "function", function: { name: "f" } }];
    await settle(chat(cfg(), [], { tools }));
    expect(bodyOf(0)).toMatchObject({ tools, tool_choice: "auto" });
    await settle(chat(cfg({ maxTokens: 100 }), [], { tools, requireTool: true, json: true }));
    expect(bodyOf(1)).toMatchObject({ tool_choice: "required", response_format: { type: "json_object" }, max_tokens: 100 });
  });

  it("reads tool calls, reasoning (either field) and treats empty content as null", async () => {
    const toolCalls = [{ id: "c1", type: "function", function: { name: "submit_sql", arguments: "{}" } }];
    fetchMock.mockResolvedValueOnce(json(200, { choices: [{ message: { content: "", tool_calls: toolCalls, reasoning_content: "because" } }] }));
    expect(await settle(chat(cfg(), []))).toEqual({ content: null, toolCalls, reasoning: "because", promptTokens: 0, completionTokens: 0, waitedMs: 0 });
  });
});

describe("chat: keys and rate limits", () => {
  it("spreads requests over the keys round-robin", async () => {
    fetchMock.mockImplementation(async () => json(200, okBody()));
    const c = cfg({ apiKeys: ["k1", "k2", "k3"] });
    for (let i = 0; i < 4; i++) await settle(chat(c, []));
    expect([0, 1, 2, 3].map(keyOf)).toEqual(["Bearer k1", "Bearer k2", "Bearer k3", "Bearer k1"]);
  });

  it("parks a rate-limited key and moves on to the next one without waiting", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("Rate limit reached. Please try again in 2m33.36s.")).mockImplementation(async () => json(200, okBody()));
    const c = cfg({ apiKeys: ["k1", "k2"] });
    expect((await settle(chat(c, []))).waitedMs).toBe(0);
    await settle(chat(c, [])); // k1 still parked: k2 again
    expect([0, 1, 2].map(keyOf)).toEqual(["Bearer k1", "Bearer k2", "Bearer k2"]);
  });

  it("waits out a short limit on its only key (server's time + 250 ms)", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("try again in 510ms")).mockImplementation(async () => json(200, okBody()));
    expect((await settle(chat(cfg(), []))).waitedMs).toBe(760);
  });

  it("uses retry-after when the message gives no time, else 10 s", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("slow down", { "retry-after": "2" })).mockImplementation(async () => json(200, okBody()));
    expect((await settle(chat(cfg(), []))).waitedMs).toBe(2250);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(rateLimited("slow down")).mockImplementation(async () => json(200, okBody()));
    expect((await settle(chat(cfg(), []))).waitedMs).toBe(10_000);
  });

  it("gives up at once when every key is parked for more than 65 s", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited("Limit on tokens per day. Please try again in 1h2m."));
    await expect(settle(chat(cfg(), []))).rejects.toThrow(/^All 1 API key\(s\) are rate-limited; the first frees up in about 63 min/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 90 s of waiting in one call", async () => {
    fetchMock.mockImplementation(async () => rateLimited("try again in 40s"));
    await expect(settle(chat(cfg(), []))).rejects.toThrow(/^Rate-limited for too long \(81 s waited/);
  });
});

describe("chat: errors and retries", () => {
  it("backs off and retries server errors", async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: { message: "overloaded" } })).mockResolvedValueOnce(json(502, {})).mockImplementation(async () => json(200, okBody()));
    const out = await settle(chat(cfg(), []));
    expect(out.waitedMs).toBe(1000 + 2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after 6 network failures with the last error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(settle(chat(cfg(), []))).rejects.toThrow("Model call failed after retries (network: fetch failed)");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("does not retry a client error", async () => {
    fetchMock.mockImplementation(async () => json(401, { error: { message: "Invalid API key" } }));
    await expect(settle(chat(cfg(), []))).rejects.toThrow("Model call failed after retries (401: Invalid API key)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a malformed tool call once", async () => {
    const bad = () => json(400, { error: { code: "tool_use_failed", message: "Failed to call a function" } });
    fetchMock.mockResolvedValueOnce(bad()).mockResolvedValueOnce(json(200, okBody()));
    await expect(settle(chat(cfg(), []))).resolves.toMatchObject({ content: "hi" });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(bad()).mockResolvedValueOnce(bad()).mockImplementation(async () => json(200, okBody()));
    await expect(settle(chat(cfg(), []))).rejects.toThrow("400: Failed to call a function");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 without choices or a non-JSON body as a failure", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>gateway</html>", { status: 200, statusText: "OK" }));
    await expect(settle(chat(cfg(), []))).rejects.toThrow("Model call failed after retries (200: OK)");
  });
});

describe("teacherConfig", () => {
  it("reads the teacher from the environment, merging and de-duplicating keys", () => {
    vi.stubEnv("TEACHER_BASE_URL", "https://api.example.invalid/v1");
    vi.stubEnv("TEACHER_MODEL", "openai/gpt-oss-120b");
    vi.stubEnv("TEACHER_API_KEY", "a");
    vi.stubEnv("TEACHER_API_KEYS", " a, b,,c ");
    vi.stubEnv("TEACHER_REASONING_EFFORT", "");
    expect(teacherConfig()).toEqual({
      label: "openai/gpt-oss-120b", baseUrl: "https://api.example.invalid/v1", apiKeys: ["a", "b", "c"], model: "openai/gpt-oss-120b", reasoningEffort: "",
    });
  });

  it("defaults the reasoning effort to medium when unset", () => {
    vi.stubEnv("TEACHER_BASE_URL", "u");
    vi.stubEnv("TEACHER_MODEL", "m");
    vi.stubEnv("TEACHER_API_KEYS", "k");
    delete process.env.TEACHER_REASONING_EFFORT;
    expect(teacherConfig().reasoningEffort).toBe("medium");
  });

  it("throws when the base URL, model or every key is missing", () => {
    vi.stubEnv("TEACHER_BASE_URL", "u");
    vi.stubEnv("TEACHER_MODEL", "m");
    vi.stubEnv("TEACHER_API_KEY", "");
    vi.stubEnv("TEACHER_API_KEYS", " , ");
    expect(() => teacherConfig()).toThrow("Missing TEACHER_BASE_URL, TEACHER_API_KEY(S) or TEACHER_MODEL");
  });
});
