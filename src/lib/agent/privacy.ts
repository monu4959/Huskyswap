// Masks contact details in anything the agent shows: query results (before the
// model sees them) and final answers. The nlq views hold no names, emails or
// messages, but listing and review text is typed by students and could.

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const HANDLE = /(^|[\s(])@[A-Za-z0-9_.]{3,30}\b/g;

export function scrubText(text: string) {
  return text.replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]").replace(HANDLE, "$1[handle removed]");
}

export function scrubRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === "string" ? scrubText(value) : value;
  return out;
}
