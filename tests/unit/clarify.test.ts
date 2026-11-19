// Ambiguity check: when it asks the model, when it never does, and how the
// model's JSON reply is read.

import { describe, expect, it, vi } from "vitest";
import { MAX_CLARIFY_ROUNDS, checkAmbiguity, parseJson } from "@/lib/agent/clarify.ts";
import type { ChatResult } from "@/lib/agent/llm.ts";
import type { Retrieved } from "@/lib/agent/retrieve.ts";
import type { ClarificationTurn, DbRole } from "@/lib/agent/types.ts";

const CTX: Retrieved = { views: [], values: [], titles: [], glossary: [], examples: [], joins: [], ms: 0 };

function ambiguity(question: string, content: string | null = '{"clarify": false}', opts: { role?: DbRole; clarifications?: ClarificationTurn[] } = {}) {
  const call = vi.fn(async (): Promise<ChatResult> => ({ content, toolCalls: [], reasoning: null, promptTokens: 0, completionTokens: 0, waitedMs: 0 }));
  const done = checkAmbiguity({ question, clarifications: opts.clarifications ?? [], ctx: CTX, role: opts.role ?? "nlq_admin", today: "Wednesday, 2026-11-18", call });
  return { call, done };
}

describe("parseJson", () => {
  it.each([
    ['{"a": 1}', { a: 1 }],
    ['```json\n{"a": 1}\n```', { a: 1 }],
    ['Sure! {"a": {"b": 2}} hope that helps', { a: { b: 2 } }],
  ])("reads %j", (text, expected) => {
    expect(parseJson(text)).toEqual(expected);
  });

  it.each([null, "", "no json here", "{not: valid}", "[1, 2]"])("returns null for %j", (text) => {
    expect(parseJson(text)).toBeNull();
  });
});

describe("checkAmbiguity: never asks", () => {
  it.each([
    "what is the seller's email",
    "give me the phone number of whoever listed the desk",
    "who is selling the cheapest bike",
    "what did buyers say in their messages",
    "find their instagram",
  ])("for personal information: %j", async (question) => {
    const { call, done } = ambiguity(question);
    expect(await done).toEqual({ clarify: null, resolved: question });
    expect(call).not.toHaveBeenCalled();
  });

  it("for a student asking about another student's activity, but does for an admin", async () => {
    const student = ambiguity("what else has the seller of the cheapest bike sold", undefined, { role: "nlq_student" });
    await student.done;
    expect(student.call).not.toHaveBeenCalled();
    const admin = ambiguity("what else has the seller of the cheapest bike sold", undefined, { role: "nlq_admin" });
    await admin.done;
    expect(admin.call).toHaveBeenCalledTimes(1);
  });

  it.each(["what's in the payments table", "query view transactions_archive", "list the orders views", "table called orders"])(
    "for a table or view that doesn't exist: %j",
    async (question) => {
      const { call, done } = ambiguity(question);
      await done;
      expect(call).not.toHaveBeenCalled();
    },
  );

  // Fixed (low): in namesMissingTable the first alternative ("<word> table") consumed the
  // keyword, so "the view X" / "the table called X" matched only "the" and the missing
  // name X was never seen.
  it.each([
    "query the view transactions_archive", "show the table called orders", "select from the view named audit_log",
    "what's in nlq.payments table", "rows of the orders_2024 table", "count the rows in public.profiles view",
  ])("%j is recognised as naming a missing table", async (question) => {
    const { call, done } = ambiguity(question);
    await done;
    expect(call).not.toHaveBeenCalled();
  });

  it("does ask about a question naming a real view", async () => {
    const { call, done } = ambiguity("top categories in the deals table");
    await done;
    expect(call).toHaveBeenCalledTimes(1);
  });

  it(`after ${MAX_CLARIFY_ROUNDS} rounds, answering with the clarifications folded in`, async () => {
    const clarifications = [{ question: "By?", answer: "revenue" }, { question: "When?", answer: "this year" }];
    const { call, done } = ambiguity("best sellers", undefined, { clarifications });
    expect(await done).toEqual({ clarify: null, resolved: "best sellers (revenue; this year)" });
    expect(call).not.toHaveBeenCalled();
  });

  // Fixed (low): any "<word> table" counted as a missing database table, so furniture
  // questions ("coffee table", "table lamp") skipped the ambiguity check entirely.
  it.each([
    "which coffee tables are the best sellers", "is the coffee table still for sale", "cheapest table lamp",
    "best desk or dining table", "view bikes for sale", "what tables are there", "the deals table by category", "top sellers in the nlq.deals view",
  ])("%j does not name a missing database table, so the model is asked", async (question) => {
    const { call, done } = ambiguity(question);
    await done;
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("checkAmbiguity: reading the model's reply", () => {
  it("returns a clarifying question with 2-4 trimmed, non-empty options", async () => {
    const { done } = ambiguity("best sellers", JSON.stringify({ clarify: true, question: "  By count or revenue? ", options: ["count", " ", 5, "revenue", "a", "b", "c"] }));
    expect(await done).toEqual({ clarify: { question: "By count or revenue?", options: ["count", "revenue", "a", "b"] }, resolved: "best sellers" });
  });

  it("does not clarify with fewer than two options", async () => {
    const { done } = ambiguity("best sellers", JSON.stringify({ clarify: true, question: "By?", options: ["count"] }));
    expect(await done).toEqual({ clarify: null, resolved: "best sellers" });
  });

  it("uses the model's resolved question, trimmed", async () => {
    const { done } = ambiguity("best sellers", JSON.stringify({ clarify: false, resolved_question: "  Top sellers by number of completed sales. " }));
    expect((await done).resolved).toBe("Top sellers by number of completed sales.");
  });

  it("falls back to the question (plus answers) on unusable replies", async () => {
    for (const reply of [null, "not json", '{"clarify": false, "resolved_question": "   "}', '{"clarify": true}']) {
      const { done } = ambiguity("best sellers", reply, { clarifications: [{ question: "By?", answer: "revenue" }] });
      expect(await done).toEqual({ clarify: null, resolved: "best sellers (revenue)" });
    }
  });

  it("sends the role, today's date and earlier clarifications to the model", async () => {
    const { call, done } = ambiguity("best sellers", undefined, { role: "nlq_student", clarifications: [{ question: "By?", answer: "revenue" }] });
    await done;
    const [messages, opts] = call.mock.calls[0] as unknown as [{ role: string; content: string }[], object];
    expect(opts).toEqual({ json: true });
    expect(messages[0].content).toContain("Wednesday, 2026-11-18");
    expect(messages[0].content).toContain("The person asking is a student.");
    expect(messages[1].content).toContain("Asked: By? Answer: revenue");
  });
});
