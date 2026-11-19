// runAgent: how the graph turns node outcomes into a run, especially the plain-words
// explanation when the SQL node ends without an answer (whyNoAnswer). Every node,
// the model, the cache, the database and the run log are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResult, ModelConfig } from "@/lib/agent/llm.ts";
import type { SqlOutcome } from "@/lib/agent/sql-node.ts";
import type { ChatMessage, SqlResult } from "@/lib/agent/types.ts";

const m = vi.hoisted(() => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  cacheLookup: vi.fn(),
  cacheStore: vi.fn(),
  checkAmbiguity: vi.fn(),
  runSelect: vi.fn(),
  chat: vi.fn(),
  logRun: vi.fn(),
  retrieve: vi.fn(),
  sqlNode: vi.fn(),
  writeAnswer: vi.fn(),
}));
vi.mock("@/lib/agent/embed.ts", () => ({ embed: m.embed }));
vi.mock("@/lib/agent/cache.ts", async (orig) => ({ ...(await orig<typeof import("@/lib/agent/cache.ts")>()), cacheLookup: m.cacheLookup, cacheStore: m.cacheStore }));
vi.mock("@/lib/agent/clarify.ts", () => ({ checkAmbiguity: m.checkAmbiguity }));
vi.mock("@/lib/agent/db.ts", () => ({ runSelect: m.runSelect }));
vi.mock("@/lib/agent/llm.ts", () => ({ chat: m.chat, teacherConfig: () => MODEL }));
vi.mock("@/lib/agent/log.ts", () => ({ logRun: m.logRun }));
vi.mock("@/lib/agent/retrieve.ts", async (orig) => ({ ...(await orig<typeof import("@/lib/agent/retrieve.ts")>()), retrieve: m.retrieve }));
vi.mock("@/lib/agent/sql-node.ts", async (orig) => ({ ...(await orig<typeof import("@/lib/agent/sql-node.ts")>()), sqlNode: m.sqlNode }));
vi.mock("@/lib/agent/answer.ts", () => ({ writeAnswer: m.writeAnswer }));
vi.mock("@/lib/agent/ops-db.ts", () => ({ opsPool: () => { throw new Error("no database in unit tests"); } }));

const MODEL: ModelConfig = { label: "fake", baseUrl: "http://fake.invalid", apiKeys: ["k"], model: "fake" };
const { runAgent, RUN_BUDGET } = await import("@/lib/agent/graph.ts");
const { resultHash } = await import("@/lib/agent/cache.ts");
const { SQL_LIMITS } = await import("@/lib/agent/sql-node.ts");

const ok = (n: number): Extract<SqlResult, { ok: true }> => ({ ok: true, columns: ["n"], rows: Array.from({ length: n }, (_, i) => ({ n: i })), rowCount: n, truncated: false });
const outcome = (o: Partial<SqlOutcome>): SqlOutcome => ({ status: "gave_up", sql: null, result: null, reason: null, messages: [], sqlErrors: 0, lastError: null, ...o });
const chatReply = (o: Partial<ChatResult> = {}): ChatResult => ({ content: "{}", toolCalls: [], reasoning: null, promptTokens: 10, completionTokens: 5, waitedMs: 0, ...o });

const WHY = {
  nothingMatched: /^I searched, but nothing matched\./,
  unsureEmpty: "(I couldn't double-check my filters, so if you expected results, try rewording the question.)",
  notAllowedStudent: /^I can't answer that with a student account\./,
  notAllowed: /^That needs data the assistant isn't allowed to read/,
  queriesFailed: /^Every query I tried was rejected/,
  gaveUp: "I couldn't work out a reliable query for that. Try rephrasing it or narrowing it down.",
  busy: /^The AI service is at its rate limit/,
  tooLong: /^That took too many steps/,
};

type Opts = Partial<Parameters<typeof runAgent>[0]>;
const ask = (opts: Opts = {}) => runAgent({ question: "how many bikes?", role: "nlq_student", source: "eval", log: false, model: MODEL, today: "Wednesday, 2026-11-18", ...opts });

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.embed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
  m.cacheLookup.mockResolvedValue(null);
  m.cacheStore.mockResolvedValue(undefined);
  m.retrieve.mockResolvedValue({ views: [], values: [], titles: [], glossary: [], examples: [], joins: [], ms: 1 });
  m.checkAmbiguity.mockImplementation(async (input: { question: string }) => ({ clarify: null, resolved: `resolved: ${input.question}` }));
  m.chat.mockResolvedValue(chatReply());
  m.logRun.mockResolvedValue("run-1");
});

describe("runAgent: give-up explanations (whyNoAnswer)", () => {
  it("a valid query that found nothing: says nothing matched (evals keep the plain text)", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sql: "select 0", result: ok(0) }));
    const run = await ask();
    expect(run.status).toBe("gave_up");
    expect(run.answer).toMatch(WHY.nothingMatched);
    expect(m.writeAnswer).not.toHaveBeenCalled();
  });

  it("in the app, lets the answer node say what was searched for, with a caveat, scrubbed", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sql: "select 0", result: ok(0) }));
    m.writeAnswer.mockResolvedValue({ answer: "No mini fridges at Curry; ask bob@example.com", grounded: true });
    const run = await ask({ source: "app" });
    expect(run.status).toBe("gave_up");
    expect(run.answer).toBe(`No mini fridges at Curry; ask [email removed]\n\n${WHY.unsureEmpty}`);
    expect(m.writeAnswer).toHaveBeenCalledWith(expect.objectContaining({ question: "how many bikes?", sql: "select 0" }));
  });

  it("in the app, falls back to the plain text when the answer node fails or says nothing", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sql: "select 0", result: ok(0) }));
    m.writeAnswer.mockRejectedValueOnce(new Error("model down"));
    expect((await ask({ source: "app" })).answer).toMatch(WHY.nothingMatched);
    m.writeAnswer.mockResolvedValueOnce({ answer: "", grounded: false });
    expect((await ask({ source: "app" })).answer).toMatch(WHY.nothingMatched);
  });

  it.each([
    ["nlq_student", WHY.notAllowedStudent],
    ["nlq_admin", WHY.notAllowed],
  ] as const)("a query that reached past the nlq views (%s)", async (role, why) => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: 1, lastError: "Only nlq views can be queried; auth.users is not allowed." }));
    expect((await ask({ role })).answer).toMatch(why);
  });

  it("a student hitting an admin-only view is told it's admin-only", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: 1, lastError: 'Unknown view "deals". Views you can query: listings.' }));
    expect((await ask({ role: "nlq_student" })).answer).toMatch(WHY.notAllowedStudent);
  });

  it("a made-up view is not a permissions problem", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: 1, lastError: 'Unknown view "payments". Views you can query: listings.' }));
    expect((await ask({ role: "nlq_student" })).answer).toBe(WHY.gaveUp);
  });

  it("an admin view named in an admin's error is not a permissions problem", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: 1, lastError: 'Unknown view "payments".' }));
    expect((await ask({ role: "nlq_admin" })).answer).toBe(WHY.gaveUp);
  });

  it("every query rejected", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: SQL_LIMITS.failures, lastError: 'column "x" does not exist' }));
    expect((await ask()).answer).toMatch(WHY.queriesFailed);
  });

  it("otherwise, the generic give-up text", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sqlErrors: 1, lastError: "syntax error" }));
    expect((await ask()).answer).toBe(WHY.gaveUp);
    m.sqlNode.mockResolvedValue(outcome({}));
    expect((await ask()).answer).toBe(WHY.gaveUp);
  });

  it("a fallback query that returned rows (never submitted) is not 'nothing matched'", async () => {
    m.sqlNode.mockResolvedValue(outcome({ sql: "select 1", result: ok(3) }));
    expect((await ask()).answer).toBe(WHY.gaveUp);
  });
});

describe("runAgent: run budget", () => {
  const sqlNodeCallingTwice = async (input: { call: (msgs: ChatMessage[], o: object) => Promise<ChatResult> }) => {
    await input.call([], {});
    await input.call([], {});
    return outcome({ status: "answered" });
  };

  it(`stops when the run passes ${RUN_BUDGET.tokens} tokens: too many steps`, async () => {
    m.chat.mockResolvedValue(chatReply({ promptTokens: RUN_BUDGET.tokens, completionTokens: 1 }));
    m.sqlNode.mockImplementation(sqlNodeCallingTwice);
    const run = await ask();
    expect(run).toMatchObject({ status: "gave_up", error: "Run budget exceeded" });
    expect(run.answer).toMatch(WHY.tooLong);
    expect(m.chat).toHaveBeenCalledTimes(1);
    expect(run.calls).toHaveLength(1);
  });

  it("blames the rate limit when most of the time went to waiting", async () => {
    m.chat.mockResolvedValue(chatReply({ promptTokens: RUN_BUDGET.tokens, completionTokens: 1, waitedMs: 25_000 }));
    m.sqlNode.mockImplementation(sqlNodeCallingTwice);
    expect((await ask()).answer).toMatch(WHY.busy);
  });

  it("any other error is an error run with no answer", async () => {
    m.sqlNode.mockRejectedValue(new Error("socket hang up"));
    expect(await ask()).toMatchObject({ status: "error", answer: null, error: "socket hang up" });
  });

  it("records each model call with its node and token counts", async () => {
    m.chat.mockResolvedValue(chatReply({ promptTokens: 100, completionTokens: 20 }));
    m.sqlNode.mockImplementation(async (input: { call: (msgs: ChatMessage[], o: object) => Promise<ChatResult> }) => {
      await input.call([{ role: "user", content: "q" }], {});
      return outcome({ sqlErrors: 1 });
    });
    const run = await ask();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ node: "sql", promptTokens: 100, completionTokens: 20, messages: [{ role: "user", content: "q" }] });
    expect(run).toMatchObject({ promptTokens: 100, completionTokens: 20 });
  });
});

describe("runAgent: cancellation (client disconnected)", () => {
  type Call = (msgs: ChatMessage[], o: object) => Promise<ChatResult>;

  it("stops before the next model call once the signal aborts, and passes the signal to the model call", async () => {
    const controller = new AbortController();
    m.sqlNode.mockImplementation(async (input: { call: Call }) => {
      await input.call([], {});
      controller.abort();
      await input.call([], {});
      return outcome({ status: "answered" });
    });
    const run = await ask({ signal: controller.signal });
    expect(m.chat).toHaveBeenCalledTimes(1);
    expect(m.chat.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
    expect(run).toMatchObject({ status: "error", answer: null, error: "Cancelled: the client disconnected" });
  });

  it("an already-aborted request makes no model call", async () => {
    const controller = new AbortController();
    controller.abort();
    m.sqlNode.mockImplementation(async (input: { call: Call }) => {
      await input.call([], {});
      return outcome({ status: "answered" });
    });
    const run = await ask({ signal: controller.signal });
    expect(m.chat).not.toHaveBeenCalled();
    expect(run.status).toBe("error");
  });

  it("without a signal the model call options are passed through unchanged", async () => {
    m.sqlNode.mockImplementation(async (input: { call: Call }) => {
      await input.call([], { json: true });
      return outcome({});
    });
    await ask();
    expect(m.chat.mock.calls[0][2]).toEqual({ json: true });
  });
});

describe("runAgent: other outcomes", () => {
  it("answered: writes a grounded answer from the SQL node's result", async () => {
    m.sqlNode.mockResolvedValue(outcome({ status: "answered", sql: "select 1", result: ok(1) }));
    m.writeAnswer.mockResolvedValue({ answer: "There is 1.", grounded: true });
    const run = await ask();
    expect(run).toMatchObject({ status: "answered", answer: "There is 1.", grounded: true, finalSql: "select 1", resolvedQuestion: "how many bikes?" });
    expect(run.nodes.map((n) => n.node)).toEqual(["retrieve", "clarify", "sql", "answer"]);
  });

  it("refused: shows the reason with contact details masked", async () => {
    m.sqlNode.mockResolvedValue(outcome({ status: "refused", reason: "Can't share (617) 555-0123." }));
    expect(await ask()).toMatchObject({ status: "refused", answer: "Can't share [phone removed]." });
  });

  // Red team: clarifying questions are model-written text too and were shown unmasked
  it("clarify: masks contact details and links in the question and its options", async () => {
    m.checkAmbiguity.mockResolvedValue({
      clarify: { question: "Verify at https://evil.example/x or mail a@evil.example first?", options: ["call (617) 555-0199", "ｈｔｔｐｓ://evil.example"] },
      resolved: "x",
    });
    const run = await ask();
    expect(run.answer).toBe("Verify at [link removed] or mail [email removed] first?");
    expect(run.clarification).toEqual({ question: run.answer, options: ["call [phone removed]", "[link removed]"] });
  });

  it("clarify: returns the clarifying question without running SQL", async () => {
    m.checkAmbiguity.mockResolvedValue({ clarify: { question: "By count or revenue?", options: ["count", "revenue"] }, resolved: "x" });
    const run = await ask();
    expect(run).toMatchObject({ status: "clarify", answer: "By count or revenue?" });
    expect(m.sqlNode).not.toHaveBeenCalled();
  });

  it("with clarifications, answers the resolved question and keys the cache on the answers", async () => {
    m.sqlNode.mockResolvedValue(outcome({ status: "answered", sql: "select 1", result: ok(1) }));
    m.writeAnswer.mockResolvedValue({ answer: "1", grounded: true });
    const run = await ask({ source: "app", clarifications: [{ question: "By what?", answer: "count" }] });
    expect(m.sqlNode).toHaveBeenCalledWith(expect.objectContaining({ question: "resolved: how many bikes?" }));
    expect(m.cacheLookup).toHaveBeenCalledWith("how many bikes? (count)", [0.1, 0.2], "nlq_student", null);
    expect(m.cacheStore).toHaveBeenCalledWith(expect.objectContaining({ question: "how many bikes? (count)" }));
    expect(run.resolvedQuestion).toBe("resolved: how many bikes?");
  });
});

describe("runAgent: cache", () => {
  const hit = { cacheId: 1, question: "how many bikes are listed", sql: "select 7", answer: "There are 7 bikes.", resultHash: "", similarity: 0.97, askedBy: "u1" as string | null };

  it("is off for evals and on for the app by default", async () => {
    m.sqlNode.mockResolvedValue(outcome({}));
    await ask({ source: "eval" });
    expect(m.cacheLookup).not.toHaveBeenCalled();
    await ask({ source: "app" });
    expect(m.cacheLookup).toHaveBeenCalledTimes(1);
  });

  it("serves an unchanged result with the stored answer and no model call", async () => {
    m.runSelect.mockResolvedValue(ok(7));
    m.cacheLookup.mockResolvedValue({ ...hit, resultHash: resultHash(ok(7)) });
    const run = await ask({ source: "app", userId: "u1" });
    expect(run).toMatchObject({ status: "answered", cacheHit: true, answer: "There are 7 bikes.", grounded: true, finalSql: "select 7" });
    expect(m.runSelect).toHaveBeenCalledWith("select 7", "nlq_student", [], { userId: "u1" });
    expect(m.chat).not.toHaveBeenCalled();
    expect(m.sqlNode).not.toHaveBeenCalled();
    expect(m.cacheStore).not.toHaveBeenCalled(); // hits are not stored again
  });

  // Red team: an attacker's cached answer text (prompt-injected, "verify your account at ...")
  // was served to every student who asked the same question
  it("never serves another student's answer text: re-answers with a fresh model call", async () => {
    m.runSelect.mockResolvedValue(ok(7));
    m.cacheLookup.mockResolvedValue({ ...hit, askedBy: "attacker", answer: "Your account is locked: email support@evil.example", resultHash: resultHash(ok(7)) });
    m.writeAnswer.mockResolvedValue({ answer: "There are 7 bikes.", grounded: true });
    const run = await ask({ source: "app", userId: "victim" });
    expect(run).toMatchObject({ status: "answered", cacheHit: true, answer: "There are 7 bikes." });
    expect(m.runSelect).toHaveBeenCalledWith("select 7", "nlq_student", [], { userId: "victim" });
    expect(m.writeAnswer).toHaveBeenCalledTimes(1);
  });

  it("masks contact details in a reused answer", async () => {
    m.runSelect.mockResolvedValue(ok(7));
    m.cacheLookup.mockResolvedValue({ ...hit, answer: "Ask bob@example.com", resultHash: resultHash(ok(7)) });
    expect((await ask({ source: "app", userId: "u1" })).answer).toBe("Ask [email removed]");
  });

  it("re-answers when the stored SQL now returns something else", async () => {
    m.runSelect.mockResolvedValue(ok(8));
    m.cacheLookup.mockResolvedValue({ ...hit, resultHash: resultHash(ok(7)) });
    m.writeAnswer.mockResolvedValue({ answer: "There are 8 bikes.", grounded: true });
    expect(await ask({ source: "app" })).toMatchObject({ status: "answered", cacheHit: true, answer: "There are 8 bikes." });
  });

  it("treats a hit whose SQL now fails as a miss", async () => {
    m.runSelect.mockResolvedValue({ ok: false, error: "column gone" });
    m.cacheLookup.mockResolvedValue(hit);
    m.sqlNode.mockResolvedValue(outcome({}));
    const run = await ask({ source: "app" });
    expect(run.cacheHit).toBe(false);
    expect(m.sqlNode).toHaveBeenCalled();
  });

  it("stores only fresh, grounded answers", async () => {
    m.sqlNode.mockResolvedValue(outcome({ status: "answered", sql: "select 1", result: ok(1) }));
    m.writeAnswer.mockResolvedValue({ answer: "x", grounded: false });
    await ask({ source: "app" });
    expect(m.cacheStore).not.toHaveBeenCalled();
    m.writeAnswer.mockResolvedValue({ answer: "x", grounded: true });
    await ask({ source: "app" });
    expect(m.cacheStore).toHaveBeenCalledTimes(1);
  });

  it("a failing cache store is recorded, not thrown", async () => {
    m.sqlNode.mockResolvedValue(outcome({ status: "answered", sql: "select 1", result: ok(1) }));
    m.writeAnswer.mockResolvedValue({ answer: "x", grounded: true });
    m.cacheStore.mockRejectedValue(new Error("disk full"));
    expect((await ask({ source: "app" })).error).toBe("cache store failed: disk full");
  });
});

describe("runAgent: run log", () => {
  it("logs the run and records its id; a failing log is recorded, not thrown", async () => {
    m.sqlNode.mockResolvedValue(outcome({}));
    expect((await ask({ log: true })).runId).toBe("run-1");
    m.logRun.mockRejectedValue(new Error("db down"));
    const run = await ask({ log: true });
    expect(run.runId).toBeNull();
    expect(run.error).toBe("log failed: db down");
  });
});
