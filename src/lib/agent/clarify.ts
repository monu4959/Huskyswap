// Ambiguity check (graph node 2). Runs after retrieval, so it can see what the
// data offers: ask only when plausible readings would give materially
// different answers. Returns either one clarifying question with options, or
// the resolved question (any clarification answers folded in), which is what
// the SQL node answers and the cache stores.

import type { ChatResult } from "./llm.ts";
import { ambiguitySystem, ambiguityUser } from "./prompt.ts";
import type { Retrieved } from "./retrieve.ts";
import { SCHEMA_CARD } from "./schema-card.ts";
import type { ChatMessage, Clarification, ClarificationTurn, DbRole } from "./types.ts";

export const MAX_CLARIFY_ROUNDS = 2;

// Requests for someone's contact details or identity are never clarified (a
// model will helpfully offer "the email in the listing?"): they go straight to
// the SQL node, which refuses them.
const PERSONAL_INFO =
  /\b(e-?mails?|phone|cell|number to (call|text)|contact (info|details)|address|insta(gram)?|snap(chat)?|whatsapp|venmo|social media|handle|full name|last name|real name|who('s| is| are)? (selling|buying|the (seller|buyer|lender|borrower))|(chat |the |their )?messages?( text)?|what (they|buyers|sellers|students) (said|wrote|sent))\b/i;

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

// A student asking about someone else's activity ("the seller of the cheapest bike")
// gets a refusal, not a clarifying question offering alternatives
const OTHER_PEOPLE =
  /\b(?:the|that|this|whose|other|another)\s+(?:seller|buyer|lender|borrower|student|person|user|owner)s?\b|\bsomeone(?: else)?'?s?\b|\bother (?:students|people|users)\b/i;

// "the payments table", "view transactions_archive", "the table called orders": a table or
// view name that isn't in the schema. A name counts when it looks like an identifier
// (underscore, digit or schema dot), follows "called"/"named", or sits between a
// determiner and the keyword ("the payments table"); furniture ("which coffee tables",
// "the coffee table", "table lamp") and the verb "view" ("view bikes for sale") don't.
const IDENTIFIER = /[_\d.]/;
const NOT_A_NAME = new Set(["the", "a", "an", "this", "that", "these", "those", "of", "my", "your", "our", "its", "their", "data", "any", "which", "what", "each", "every", "same", "other"]);
const FURNITURE = new Set([
  "coffee", "dining", "kitchen", "side", "end", "folding", "foldable", "picnic", "bedside", "night", "study", "desk", "computer", "card",
  "pool", "tennis", "work", "accent", "console", "patio", "outdoor", "glass", "wood", "wooden", "round", "square", "small", "big", "ikea",
]);
function namesMissingTable(question: string) {
  const q = question.toLowerCase();
  const names: string[] = [];
  // "<determiner> <name> table(s)/view(s)", or an identifier-looking name before the keyword
  for (const m of q.matchAll(/(?:\b(the|a|an|this|that|my|your|our|its)\s+)?\b([a-z_][a-z0-9_.]*)\s+(?:table|view)s?\b/g)) {
    const [, determiner, name] = m;
    if (NOT_A_NAME.has(name)) continue;
    if (IDENTIFIER.test(name) || (determiner && !FURNITURE.has(name))) names.push(name);
  }
  // "table/view called <name>", or an identifier-looking name after the keyword
  for (const m of q.matchAll(/\b(?:table|view)s?\s+(called\s+|named\s+)?([a-z_][a-z0-9_.]*)/g)) {
    const [, called, name] = m;
    if (NOT_A_NAME.has(name)) continue;
    if (called || IDENTIFIER.test(name)) names.push(name);
  }
  return names
    .map((n) => n.replace(/\.+$/, "").replace(/^nlq\./, ""))
    .some((n) => n && !SCHEMA_CARD.some((v) => v.name === n));
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
  // After two rounds, answer with what we have; never clarify a request for personal
  // information, for another student's activity (students), or for a table or view
  // that doesn't exist: the SQL node refuses or explains those
  if (
    input.clarifications.length >= MAX_CLARIFY_ROUNDS ||
    PERSONAL_INFO.test(input.question) ||
    (input.role === "nlq_student" && OTHER_PEOPLE.test(input.question)) ||
    namesMissingTable(input.question)
  ) {
    return { clarify: null, resolved: fallback };
  }

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
