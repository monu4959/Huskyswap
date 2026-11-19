// Answer node (graph node 7): turns the final result into one to three
// sentences, then checks that every number in the answer appears in the
// result (or the question). One retry with the offending numbers named; if it
// still doesn't hold, the run is marked ungrounded and a neutral answer is
// shown with the result table. Contact details are masked either way.

import { parseJson } from "./clarify.ts";
import type { ChatResult } from "./llm.ts";
import { scrubText } from "./privacy.ts";
import { answerSystem, answerUser } from "./prompt.ts";
import type { ChatMessage, SqlResult } from "./types.ts";

type Call = (messages: ChatMessage[], opts: { json?: boolean }) => Promise<ChatResult>;
type OkResult = Extract<SqlResult, { ok: true }>;

// A dash is a minus sign only when it doesn't follow a word character or another dash:
// "2025-04-21" is 2025, 4 and 21 (not -4, -21), "2024-25" is 2024 and 25, "-5" is -5
const NUMBER = /(?:(?<![\w-])-)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const numbersIn = (text: string) => (text.match(NUMBER) ?? []).map((n) => Number(n.replace(/,/g, "")));

// Numbers in the answer that the result can't account for
export function ungroundedNumbers(answer: string, result: OkResult, question: string): number[] {
  const values: number[] = [result.rowCount, result.rows.length];
  for (const row of result.rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "number") values.push(cell);
      else if (typeof cell === "string") {
        if (/^-?\d+(\.\d+)?$/.test(cell.trim())) values.push(Number(cell));
        else values.push(...numbersIn(cell)); // digits inside dates, titles, academic years
      }
    }
  }
  const fromQuestion = new Set(numbersIn(question));
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  // The value itself or as a percentage (a fraction times 100), either rounded to 0-2 decimals
  const accounted = (n: number) =>
    fromQuestion.has(n) ||
    values.some((v) => [v, v * 100].some((x) => close(x, n) || [0, 1, 2].some((k) => close(Number(x.toFixed(k)), n))) || Math.abs(v * 100 - n) < 0.051);
  return [...new Set(numbersIn(answer))].filter((n) => !accounted(n));
}

export async function writeAnswer(input: { question: string; sql: string; result: OkResult; today: string; call: Call }) {
  const messages: ChatMessage[] = [
    { role: "system", content: answerSystem(input.today) },
    { role: "user", content: answerUser(input.question, input.sql, input.result) },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await input.call(messages, { json: true });
    // Folded to ASCII first (NFKC), so fullwidth digits can't slip numbers past the grounding check
    const text = String(parseJson(reply.content)?.answer ?? reply.content ?? "").normalize("NFKC").trim();
    const missing = ungroundedNumbers(text, input.result, input.question);
    if (text && !missing.length) return { answer: scrubText(text), grounded: true };
    messages.push({ role: "assistant", content: reply.content });
    messages.push({
      role: "user",
      content: missing.length
        ? `These numbers are not in the result: ${missing.join(", ")}. Rewrite the answer using only numbers from the result.`
        : "Reply with JSON only: {\"answer\": \"...\"}",
    });
  }
  const n = input.result.truncated ? "more than 200" : String(input.result.rowCount);
  return { answer: `Here is what the data shows (${n} row${n === "1" ? "" : "s"}).`, grounded: false };
}
