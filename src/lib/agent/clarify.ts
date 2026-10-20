// Ambiguity check (graph node 2). Runs after retrieval, so it can see what the
// data offers: ask only when plausible readings would give materially
// different answers. Returns either one clarifying question with options, or
// the resolved question (any clarification answers folded in), which is what
// the SQL node answers and the cache stores.

import type { ChatResult } from "./llm.ts";
import { ambiguitySystem, ambiguityUser } from "./prompt.ts";
import type { Retrieved } from "./retrieve.ts";
import type { ChatMessage, Clarification, ClarificationTurn, DbRole } from "./types.ts";

export const MAX_CLARIFY_ROUNDS = 2;

// Requests for someone's contact details or identity are never clarified (a
// model will helpfully offer "the email in the listing?"): they go straight to
// the SQL node, which refuses them.
const PERSONAL_INFO =
  /\b(e-?mails?|phone|cell|number to (call|text)|contact (info|details)|address|insta(gram)?|snap(chat)?|whatsapp|venmo|social media|handle|full name|last name|real name|who('s| is| are)? (selling|buying|the (seller|buyer|lender|borrower)))\b/i;

type Call = (messages: ChatMessage[], opts: { json?: boolean }) => Promise<ChatResult>;

// Parse a JSON object out of a model reply (tolerates code fences and stray text)
export function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

function fallbackResolved(question: string, clarifications: ClarificationTurn[]) {
  return clarifications.length ? `${question} (${clarifications.map((c) => c.answer).join("; ")})` : question;
}

export async function checkAmbiguity(input: {
  question: string;
  clarifications: ClarificationTurn[];
  ctx: Retrieved;
  role: DbRole;
  today: string;
  call: Call;
}): Promise<{ clarify: Clarification | null; resolved: string }> {
  const fallback = fallbackResolved(input.question, input.clarifications);
  // After two rounds, answer with what we have; never clarify a request for personal information
  if (input.clarifications.length >= MAX_CLARIFY_ROUNDS || PERSONAL_INFO.test(input.question)) return { clarify: null, resolved: fallback };

  const reply = await input.call(
    [
      { role: "system", content: ambiguitySystem(input.role, input.today) },
      { role: "user", content: ambiguityUser(input.question, input.clarifications, input.ctx) },
    ],
    { json: true },
  );
  const parsed = parseJson(reply.content);
  const options = Array.isArray(parsed?.options) ? parsed.options.filter((o): o is string => typeof o === "string" && !!o.trim()).slice(0, 4) : [];
  if (parsed?.clarify === true && typeof parsed.question === "string" && options.length >= 2) {
    return { clarify: { question: parsed.question.trim(), options }, resolved: fallback };
  }
  const resolved = typeof parsed?.resolved_question === "string" && parsed.resolved_question.trim() ? parsed.resolved_question.trim() : fallback;
  return { clarify: null, resolved };
}
