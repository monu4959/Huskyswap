// Pure helpers the store uses to fold a single Realtime row into its local copy,
// instead of reloading every conversation, message and deal on each event.
// No Supabase client here, so they can be unit-tested (tests/unit/realtime-merge.test.ts).
//
// postgres_changes payloads respect row-level security, so a payload row is one
// the signed-in student may see. They carry the table's own columns only (no
// embeds), which is why a rental deal sometimes still needs a one-row fetch.

import type { Conversation, Item, Message, Profile, Transaction } from "./types";

// Embedded one-to-one rows may come back as an object or a one-element array
export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export interface TransactionRow extends Omit<Transaction, "rental" | "agreed_price"> {
  agreed_price: number | string;
  rentals: Transaction["rental"] | NonNullable<Transaction["rental"]>[] | null;
}

export const toTransaction = (r: TransactionRow): Transaction => {
  const rental = one(r.rentals);
  return {
    transaction_id: r.transaction_id,
    item_id: r.item_id,
    buyer_id: r.buyer_id,
    type: r.type,
    agreed_price: Number(r.agreed_price),
    status: r.status,
    created_at: r.created_at,
    completed_at: r.completed_at,
    rental: rental ? { ...rental, deposit_agreed: Number(rental.deposit_agreed) } : null,
  };
};

// Drop keys whose value is undefined, so a partial row never blanks a known field
function defined<T extends object>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function shallowEqual(a: object, b: object) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * Insert or replace `row` in a list kept in ascending `key` order (the order the
 * loaders fetch in). Returns the same array when nothing changed.
 */
export function upsertSorted<T extends object>(rows: T[], row: T, key: (r: T) => number): T[] {
  const id = key(row);
  const idx = rows.findIndex((r) => key(r) === id);
  if (idx !== -1) {
    if (shallowEqual(rows[idx], row)) return rows;
    const out = rows.slice();
    out[idx] = row;
    return out;
  }
  // usually the newest row: append
  if (!rows.length || key(rows[rows.length - 1]) < id) return [...rows, row];
  const at = rows.findIndex((r) => key(r) > id);
  return [...rows.slice(0, at), row, ...rows.slice(at)];
}

// ---------- messages ----------

const hasMessageKeys = (row: Partial<Message> | null | undefined): row is Partial<Message> & Pick<Message, "message_id" | "conversation_id"> =>
  !!row && row.message_id != null && row.conversation_id != null;

/**
 * Fold a messages INSERT or UPDATE row into the list: dedupes by message_id,
 * keeps message_id order, and never clears a read_at (it only goes null -> time).
 */
export function mergeMessage(messages: Message[], row: Partial<Message> | null | undefined): Message[] {
  if (!hasMessageKeys(row)) return messages;
  const prev = messages.find((m) => m.message_id === row.message_id);
  const next = prev
    ? { ...prev, ...defined(row), read_at: row.read_at ?? prev.read_at }
    : ({ read_at: null, ...defined(row) } as Message);
  return upsertSorted(messages, next, (m) => m.message_id);
}

/** The conversation to fetch for a message in a chat this store doesn't know yet, else null. */
export function conversationToFetch(conversations: Pick<Conversation, "conversation_id">[], row: Partial<Message> | null | undefined): number | null {
  if (!hasMessageKeys(row)) return null;
  return conversations.some((c) => c.conversation_id === row.conversation_id) ? null : row.conversation_id;
}

// ---------- deals ----------

export interface TransactionEvent {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Partial<TransactionRow> | Record<string, never> | null;
  old: Partial<TransactionRow> | Record<string, never> | null;
}

/**
 * Whether the rentals embed of `next` may be out of date. The rentals row is
 * created at hand-over and updated on return (supabase/migrations/0002_app_access.sql),
 * so only those steps need a refetch; sales never have one.
 */
export function rentalEmbedStale(prev: Transaction | undefined, next: Transaction): boolean {
  if (next.type !== "rental") return false;
  if (!["handed_over", "returned", "completed"].includes(next.status)) return false;
  if (!prev?.rental) return true;
  return next.status !== "handed_over" && prev.rental.returned_at == null;
}

export interface TransactionMerge {
  transactions: Transaction[];
  /** fetch this deal (with its rentals embed) to finish the merge */
  fetchId: number | null;
  /** the listing the deal is about; its status may have changed too */
  itemId: number | null;
  /** the deal's buyer, so the store can fetch an unknown profile */
  buyerId: string | null;
}

/** Fold one transactions change into the list (replace the row in place, insert in order, or remove). */
export function applyTransactionEvent(transactions: Transaction[], event: TransactionEvent): TransactionMerge {
  const none = { transactions, fetchId: null, itemId: null, buyerId: null };
  if (event.eventType === "DELETE") {
    const id = (event.old as Partial<TransactionRow> | null)?.transaction_id;
    if (id == null) return none;
    const gone = transactions.find((t) => t.transaction_id === id);
    if (!gone) return none;
    return { transactions: transactions.filter((t) => t.transaction_id !== id), fetchId: null, itemId: gone.item_id, buyerId: null };
  }
  const row = event.new as Partial<TransactionRow> | null;
  if (!row || row.transaction_id == null) return none;
  const prev = transactions.find((t) => t.transaction_id === row.transaction_id);
  const { rental: prevRental, ...prevCols } = prev ?? ({} as Partial<Transaction>);
  const merged = { ...prevCols, ...defined(row), rentals: prevRental ?? null } as TransactionRow;
  if (merged.item_id == null || merged.buyer_id == null || merged.status == null || merged.type == null) {
    // not enough to show the deal: fetch the whole row instead
    return { ...none, fetchId: row.transaction_id, itemId: merged.item_id ?? null };
  }
  const next = toTransaction(merged);
  // A rental that was just handed over or returned has new rental terms (created
  // or updated in the same change) that the event doesn't carry. Showing the new
  // status with the old (or no) terms breaks the deal screen, so keep the
  // previous state until the fetched row replaces it.
  if (rentalEmbedStale(prev, next)) {
    return { transactions, fetchId: next.transaction_id, itemId: next.item_id, buyerId: next.buyer_id };
  }
  return {
    transactions: upsertSorted(transactions, next, (t) => t.transaction_id),
    fetchId: null,
    itemId: next.item_id,
    buyerId: next.buyer_id,
  };
}

/**
 * After a full refresh: listings whose status may have moved because one of
 * their deals is new or changed, plus listings a new chat or deal points at
 * that the store doesn't have. Same set the per-event path would have refreshed.
 */
export function resyncItemIds(
  prev: { transactions: Transaction[]; items: Pick<Item, "item_id">[] },
  next: { transactions: Transaction[]; conversations: Pick<Conversation, "item_id">[] },
): number[] {
  const before = new Map(prev.transactions.map((t) => [t.transaction_id, t]));
  const have = new Set(prev.items.map((i) => i.item_id));
  const ids = new Set<number>();
  for (const t of next.transactions) {
    const old = before.get(t.transaction_id);
    if (!old || old.status !== t.status || old.completed_at !== t.completed_at || !have.has(t.item_id)) ids.add(t.item_id);
  }
  for (const c of next.conversations) if (!have.has(c.item_id)) ids.add(c.item_id);
  return [...ids].sort((a, b) => a - b);
}

// ---------- profiles ----------

/** User ids referenced by new rows that the store has no profile for (deduped, blanks dropped). */
export function missingProfileIds(profiles: Pick<Profile, "id">[], ids: (string | null | undefined)[]): string[] {
  const have = new Set(profiles.map((p) => p.id));
  return [...new Set(ids.filter((id): id is string => !!id && !have.has(id)))];
}

/** Add freshly fetched profiles; other students' emails stay blank, as in the initial load. */
export function mergeProfiles(profiles: Profile[], fresh: Omit<Profile, "email">[]): Profile[] {
  const have = new Set(profiles.map((p) => p.id));
  const add = fresh.filter((p) => !have.has(p.id)).map((p) => ({ ...p, email: "" }));
  return add.length ? [...profiles, ...add] : profiles;
}

// ---------- full refresh ----------

/**
 * Fold a full reload of chats into the local copy without losing rows that
 * arrived over Realtime while the reload was in flight. Conversations and
 * messages are never deleted, so the union is safe; read_at stays set once set.
 */
export function unionChats(
  snapshot: { conversations: Conversation[]; messages: Message[] },
  local: { conversations: Conversation[]; messages: Message[] },
): { conversations: Conversation[]; messages: Message[] } {
  const convIds = new Set(snapshot.conversations.map((c) => c.conversation_id));
  const extraConvs = local.conversations.filter((c) => !convIds.has(c.conversation_id));
  const localMsgs = new Map(local.messages.map((m) => [m.message_id, m]));
  const snapIds = new Set<number>();
  const messages = snapshot.messages.map((m) => {
    snapIds.add(m.message_id);
    const mine = localMsgs.get(m.message_id);
    return mine?.read_at && !m.read_at ? { ...m, read_at: mine.read_at } : m;
  });
  const extraMsgs = local.messages.filter((m) => !snapIds.has(m.message_id));
  const byConv = (a: Conversation, b: Conversation) => a.conversation_id - b.conversation_id;
  const byMsg = (a: Message, b: Message) => a.message_id - b.message_id;
  return {
    conversations: extraConvs.length ? [...snapshot.conversations, ...extraConvs].sort(byConv) : snapshot.conversations,
    messages: extraMsgs.length ? [...messages, ...extraMsgs].sort(byMsg) : messages,
  };
}

/**
 * Take a full reload of deals, except deals that had a Realtime event while the
 * reload was in flight (`changedIds`): the local row is newer for those.
 */
export function mergeResyncDeals(snapshot: Transaction[], local: Transaction[], changedIds: Set<number>): Transaction[] {
  if (!changedIds.size) return snapshot;
  const localById = new Map(local.map((t) => [t.transaction_id, t]));
  const out = snapshot.map((t) => (changedIds.has(t.transaction_id) ? (localById.get(t.transaction_id) ?? t) : t));
  const have = new Set(out.map((t) => t.transaction_id));
  for (const id of changedIds) {
    const t = localById.get(id);
    if (t && !have.has(id)) out.push(t);
  }
  return out.sort((a, b) => a.transaction_id - b.transaction_id);
}
