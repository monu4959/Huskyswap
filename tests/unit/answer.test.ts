// Answer node: the grounding check (every number in the answer must come from the
// result or the question) and the one-retry loop, with a scripted fake model.

import { describe, expect, it, vi } from "vitest";
import { ungroundedNumbers, writeAnswer } from "@/lib/agent/answer.ts";
import type { ChatResult } from "@/lib/agent/llm.ts";
import type { ChatMessage, SqlResult } from "@/lib/agent/types.ts";

type Ok = Extract<SqlResult, { ok: true }>;
const result = (rows: Record<string, unknown>[], truncated = false): Ok => ({ ok: true, columns: Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, truncated });
const check = (answer: string, rows: Record<string, unknown>[], question = "") => ungroundedNumbers(answer, result(rows), question);

describe("ungroundedNumbers", () => {
  it("accepts numbers that are in the result, as numbers or numeric strings", () => {
    expect(check("There are 7 bikes averaging $64.73.", [{ n: 7, avg: "64.73" }])).toEqual([]);
  });

  it("flags numbers the result can't account for", () => {
    expect(check("There are 8 bikes.", [{ n: 7 }])).toEqual([8]);
    expect(check("About 12 and 13.", [{ n: 7 }])).toEqual([12, 13]);
  });

  it("reports each missing number once", () => {
    expect(check("8, 8 and 8", [{ n: 7 }])).toEqual([8]);
  });

  it("accounts for the row count", () => {
    expect(check("Found 3 listings.", [{ t: "a" }, { t: "b" }, { t: "c" }])).toEqual([]);
  });

  it("accounts for numbers in the question", () => {
    expect(check("The top 5 spots are listed.", [{ name: "Curry" }], "top 5 meetup spots")).toEqual([]);
  });

  it("reads thousands separators", () => {
    expect(check("Revenue was $12,345.50.", [{ sum: "12345.50" }])).toEqual([]);
    expect(check("1,234 listings", [{ n: 1234 }])).toEqual([]);
  });

  it("accepts the result rounded to 0, 1 or 2 decimals, but not made up", () => {
    const rows = [{ avg: "64.7349" }];
    expect(check("about 65", rows)).toEqual([]);
    expect(check("about 64.7", rows)).toEqual([]);
    expect(check("about 64.73", rows)).toEqual([]);
    expect(check("about 64.8", rows)).toEqual([64.8]);
  });

  it("accepts a fraction written as a percentage", () => {
    expect(check("61.61% of deals", [{ share: 0.6161 }])).toEqual([]);
    expect(check("61.6% of deals", [{ share: "0.6161" }])).toEqual([]);
    expect(check("70% of deals", [{ share: 0.6161 }])).toEqual([70]);
  });

  it("finds digits inside text cells: titles and academic years", () => {
    expect(check("The iPhone 13 was listed.", [{ title: "iPhone 13 Pro" }])).toEqual([]);
    expect(check("In 2024-25 there were 4.", [{ year: "2024-25", n: 4 }])).toEqual([]);
  });

  it("handles negative numbers", () => {
    expect(check("a change of -5", [{ d: -5 }])).toEqual([]);
  });

  it("ignores non-numeric cells", () => {
    expect(check("No numbers here.", [{ x: null, y: true, z: { a: 1 } }])).toEqual([]);
  });

  // Fixed: digits inside a date cell were read with the dash as a minus sign:
  // "2025-04-21" -> [2025, -4, -21]. An answer that said "April 21, 2025" then had an
  // "ungrounded" 21, and was usually replaced by the neutral text.
  it("the day of a date in the result is grounded", () => {
    expect(check("The last listing was posted on April 21, 2025.", [{ listed_on: "2025-04-21" }])).toEqual([]);
  });
  it("reads a dash between digits as a separator, in cells and answers alike", () => {
    expect(check("On 4/21 at 15:30.", [{ at: "2025-04-21 15:30:00-04" }])).toEqual([]);
    expect(check("Prices ranged 10-20 dollars.", [{ lo: 10, hi: 20 }])).toEqual([]);
    expect(check("In 2024-25 there were 4.", [{ year: "2024-25", n: 4 }])).toEqual([]);
    expect(check("It dropped by -3 this week.", [{ d: -3 }])).toEqual([]);
    expect(check("Change: -4.", [{ day: "2025-04-21" }])).toEqual([-4]); // a date's month is not a negative number
  });
  it("still flags a day the date doesn't have", () => {
    expect(check("Posted on April 22, 2025.", [{ listed_on: "2025-04-21" }])).toEqual([22]);
  });

  // Fixed: a fraction could be written as a percentage only at the fraction's own
  // precision (|v*100 - n| < 0.051); a whole percent, which the prompt allows
  // ("at most 2 decimals"), was flagged.
  it("0.6161 written as 62% is grounded", () => {
    expect(check("About 62% of deals were sales.", [{ share: 0.6161 }])).toEqual([]);
  });
  it("accepts a fraction as a percentage rounded to 0, 1 or 2 decimals, and nothing else", () => {
    const rows = [{ share: "0.61657" }];
    expect(check("62%", rows)).toEqual([]);
    expect(check("61.7%", rows)).toEqual([]);
    expect(check("61.66%", rows)).toEqual([]);
    expect(check("61%", rows)).toEqual([61]);
    expect(check("61.6%", rows)).toEqual([61.6]);
    expect(check("63%", rows)).toEqual([63]);
  });
});

describe("writeAnswer", () => {
  const ok = result([{ n: 7 }]);
  const scripted = (...contents: (string | null)[]) => {
    const seen: ChatMessage[][] = [];
    const call = vi.fn(async (messages: ChatMessage[], opts: { json?: boolean }): Promise<ChatResult> => {
      expect(opts).toEqual({ json: true });
      seen.push([...messages]);
      return { content: contents.shift() ?? null, toolCalls: [], reasoning: null, promptTokens: 0, completionTokens: 0, waitedMs: 0 };
    });
    return { call, seen };
  };
  const write = (call: ReturnType<typeof scripted>["call"], r: Ok = ok) =>
    writeAnswer({ question: "how many bikes?", sql: "select count(*) as n from nlq.listings", result: r, today: "Wednesday, 2026-11-18", call });

  it("returns a grounded answer from JSON on the first try", async () => {
    const { call, seen } = scripted('{"answer": "There are 7 bikes listed."}');
    expect(await write(call)).toEqual({ answer: "There are 7 bikes listed.", grounded: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(seen[0][0]).toMatchObject({ role: "system", content: expect.stringContaining("Wednesday, 2026-11-18") });
    expect(seen[0][1].content).toContain("how many bikes?");
  });

  it("accepts JSON inside a code fence, or plain text", async () => {
    expect(await write(scripted('```json\n{"answer": "7 bikes."}\n```').call)).toEqual({ answer: "7 bikes.", grounded: true });
    expect(await write(scripted("There are 7 bikes.").call)).toEqual({ answer: "There are 7 bikes.", grounded: true });
  });

  it("masks contact details in the answer", async () => {
    const { call } = scripted('{"answer": "7 bikes; the seller is @bikeguy or bob@x.edu"}');
    expect((await write(call)).answer).toBe("7 bikes; the seller is [handle removed] or [email removed]");
  });

  it("retries once, naming the numbers that aren't in the result", async () => {
    const { call, seen } = scripted('{"answer": "There are 9 bikes."}', '{"answer": "There are 7 bikes."}');
    expect(await write(call)).toEqual({ answer: "There are 7 bikes.", grounded: true });
    expect(seen[1].slice(-2)).toEqual([
      { role: "assistant", content: '{"answer": "There are 9 bikes."}' },
      { role: "user", content: "These numbers are not in the result: 9. Rewrite the answer using only numbers from the result." },
    ]);
  });

  it("asks for JSON again after an empty reply", async () => {
    const { call, seen } = scripted(null, '{"answer": "7."}');
    expect(await write(call)).toEqual({ answer: "7.", grounded: true });
    expect(seen[1].at(-1)).toEqual({ role: "user", content: 'Reply with JSON only: {"answer": "..."}' });
  });

  it("gives a neutral, ungrounded answer after two failures", async () => {
    const { call } = scripted('{"answer": "9 bikes"}', '{"answer": "10 bikes"}');
    expect(await write(call)).toEqual({ answer: "Here is what the data shows (1 row).", grounded: false });
    expect(call).toHaveBeenCalledTimes(2);
  });

  // Red team: a rogue model wrote numbers as fullwidth digits ("４３２１.０９"), which the
  // grounding check didn't read as numbers
  it("reads fullwidth digits as numbers, so they can't dodge the grounding check", async () => {
    const { call } = scripted('{"answer": "There are ９ bikes."}', '{"answer": "There are ９ bikes."}');
    expect(await write(call)).toEqual({ answer: "Here is what the data shows (1 row).", grounded: false });
    expect((await write(scripted('{"answer": "There are ７ bikes."}').call)).answer).toBe("There are 7 bikes.");
  });

  it("says rows, plural, and 'more than 200' for a truncated result", async () => {
    expect((await write(scripted("99", "99").call, result([{ n: 1 }, { n: 2 }]))).answer).toBe("Here is what the data shows (2 rows).");
    expect((await write(scripted("999", "999").call, result([{ n: 1 }], true))).answer).toBe("Here is what the data shows (more than 200 rows).");
  });
});
