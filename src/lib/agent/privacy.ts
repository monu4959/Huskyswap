// Masks contact details in anything the agent shows: query results (before the
// model sees them) and final answers. The nlq views hold no names, emails or
// messages, but listing and review text is typed by students and could.

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const HANDLE = /(^|[\s(])@[A-Za-z0-9_.]{3,30}\b/g;

// Links (http://, https://, www.): answers never carry a clickable or copyable URL
// (not inside an email address; trailing punctuation stays with the sentence)
const URL_TEXT = /(?<![\w@.-])(?:https?:\/\/|www\.)[^\s<>"'()]*[^\s<>"'().,;:!?]/gi;

function mask(text: string) {
  return text
    .replace(URL_TEXT, "[link removed]")
    .replace(EMAIL, "[email removed]")
    .replace(PHONE, "[phone removed]")
    .replace(HANDLE, "$1[handle removed]");
}

// Look-alikes count too: fullwidth or styled characters ("５５５", "＠", "ｈｔｔｐｓ") are folded
// to ASCII (NFKC) for matching, so a model or a listing can't dodge the patterns that way.
// Text is returned folded only when folding revealed something to mask.
export function scrubText(text: string) {
  const masked = mask(text);
  const folded = text.normalize("NFKC");
  if (folded === text) return masked;
  const maskedFolded = mask(folded);
  return maskedFolded === folded ? masked : maskedFolded;
}

// Progress details sent to the browser (guard and database messages): masked and cut short
export const DETAIL_CHARS = 300;
export function scrubDetail(text: string) {
  return scrubText(text).slice(0, DETAIL_CHARS);
}

export function scrubRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === "string" ? scrubText(value) : value;
  return out;
}
