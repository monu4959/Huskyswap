// Realtime merges in the store: one payload row is folded into the local copy
// instead of reloading every chat and deal. Pure functions, no Supabase.

import { describe, expect, it } from "vitest";
import {
  applyTransactionEvent,
  conversationToFetch,
  mergeMessage,
  mergeProfiles,
  mergeResyncDeals,
  missingProfileIds,
  rentalEmbedStale,
  resyncItemIds,
  toTransaction,
  unionChats,
  upsertSorted,
  type TransactionEvent,
} from "@/lib/realtime-merge.ts";
import type { Conversation, Message, Profile, Transaction } from "@/lib/types.ts";

const ME = "u-me";
const BUYER = "u-buyer";

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  message_id: id,
  conversation_id: 1,
  sender_id: BUYER,
  body: `m${id}`,
  sent_at: `2026-11-19T10:00:0${id % 10}.000000+00:00`,
  read_at: null,
  ...over,
});
const conv = (id: number, over: Partial<Conversation> = {}): Conversation => ({
  conversation_id: id,
  item_id: 100 + id,
  buyer_id: BUYER,
  created_at: "2026-11-19T09:00:00+00:00",
  ...over,
});
const deal = (id: number, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id,
  item_id: 500 + id,
  buyer_id: BUYER,
  type: "sale",
  agreed_price: 20,
  status: "requested",
  created_at: "2026-11-19T09:00:00+00:00",
  completed_at: null,
  rental: null,
  ...over,
});
// A transactions payload row: the table's columns, no rentals embed, numeric may be a string
const payloadRow = (t: Transaction) => {
  const { rental: _rental, ...cols } = t;
  void _rental;
  return { ...cols, agreed_price: String(t.agreed_price) };
};
const rental = (over: Partial<NonNullable<Transaction["rental"]>> = {}): NonNullable<Transaction["rental"]> => ({
  start_date: "2026-11-19",
  due_date: "2026-11-26",
  deposit_agreed: 30,
  returned_at: null,
  return_condition: null,
  ...over,
});
const ev = (eventType: TransactionEvent["eventType"], row: object | null, old: object | null = {}): TransactionEvent =>
  ({ eventType, new: row ?? {}, old }) as TransactionEvent;

describe("mergeMessage", () => {
  it("inserts a new message", () => {
    const list = [msg(1), msg(2)];
    const out = mergeMessage(list, msg(3));
    expect(out.map((m) => m.message_id)).toEqual([1, 2, 3]);
    expect(list).toHaveLength(2); // input untouched
  });

  it("ignores a duplicate (the sender's own echo) and keeps the same array", () => {
    const list = [msg(1), msg(2)];
    expect(mergeMessage(list, msg(2))).toBe(list);
  });

  it("applies an UPDATE that sets read_at", () => {
    const list = [msg(1), msg(2)];
    const out = mergeMessage(list, { ...msg(2), read_at: "2026-11-19T11:00:00+00:00" });
    expect(out[1].read_at).toBe("2026-11-19T11:00:00+00:00");
    expect(out[0]).toBe(list[0]);
  });

  it("never clears a read_at it already has (stale or partial rows)", () => {
    const list = [msg(1, { read_at: "2026-11-19T11:00:00+00:00" })];
    expect(mergeMessage(list, msg(1))[0].read_at).toBe("2026-11-19T11:00:00+00:00");
    // an UPDATE row missing an unchanged column keeps the known value
    expect(mergeMessage(list, { message_id: 1, conversation_id: 1, read_at: null, body: undefined })[0].body).toBe("m1");
  });

  it("keeps message_id order when events arrive out of order", () => {
    const out = [msg(5)].reduce(mergeMessage, [msg(1), msg(9)]);
    expect(mergeMessage(out, msg(3)).map((m) => m.message_id)).toEqual([1, 3, 5, 9]);
  });

  it("ignores rows without ids", () => {
    const list = [msg(1)];
    expect(mergeMessage(list, {})).toBe(list);
    expect(mergeMessage(list, null)).toBe(list);
  });
});

describe("conversationToFetch", () => {
  it("asks for an unknown conversation", () => {
    expect(conversationToFetch([conv(1)], msg(7, { conversation_id: 42 }))).toBe(42);
  });
  it("asks for nothing when the conversation is known", () => {
    expect(conversationToFetch([conv(1), conv(42)], msg(7, { conversation_id: 42 }))).toBeNull();
  });
  it("asks for nothing on an empty row", () => {
    expect(conversationToFetch([], {})).toBeNull();
  });
});

describe("upsertSorted", () => {
  it("replaces in place, inserts in order, returns the same array when equal", () => {
    const list = [conv(1), conv(3)];
    expect(upsertSorted(list, conv(3), (c) => c.conversation_id)).toBe(list);
    expect(upsertSorted(list, conv(2), (c) => c.conversation_id).map((c) => c.conversation_id)).toEqual([1, 2, 3]);
    const out = upsertSorted(list, conv(1, { buyer_id: "x" }), (c) => c.conversation_id);
    expect(out.map((c) => c.buyer_id)).toEqual(["x", BUYER]);
  });
});

describe("applyTransactionEvent", () => {
  it("a status change replaces the row in place, no fetch for a sale", () => {
    const list = [deal(1), deal(2), deal(3)];
    const res = applyTransactionEvent(list, ev("UPDATE", payloadRow(deal(2, { status: "accepted" }))));
    expect(res.transactions.map((t) => t.transaction_id)).toEqual([1, 2, 3]);
    expect(res.transactions[1].status).toBe("accepted");
    expect(res.transactions[1].agreed_price).toBe(20); // numeric string -> number, as toTransaction does
    expect(res.transactions[0]).toBe(list[0]);
    expect(res).toMatchObject({ fetchId: null, itemId: 502, buyerId: BUYER });
  });

  it("a new request is inserted in transaction_id order", () => {
    const res = applyTransactionEvent([deal(1), deal(5)], ev("INSERT", payloadRow(deal(3))));
    expect(res.transactions.map((t) => t.transaction_id)).toEqual([1, 3, 5]);
    expect(res.itemId).toBe(503);
  });

  it("keeps a rental's known terms when they can't have changed", () => {
    const out = deal(1, { type: "rental", status: "returned", rental: rental({ returned_at: "2026-11-25T10:00:00+00:00" }) });
    const res = applyTransactionEvent([out], ev("UPDATE", payloadRow({ ...out, status: "completed", completed_at: "2026-11-25T11:00:00+00:00" })));
    expect(res.transactions[0].rental?.returned_at).toBe("2026-11-25T10:00:00+00:00");
    expect(res.transactions[0].status).toBe("completed");
    expect(res.fetchId).toBeNull();
  });

  it("fetches the deal when a rental is handed over or returned (the payload has no rentals embed)", () => {
    const accepted = deal(1, { type: "rental", status: "accepted" });
    expect(applyTransactionEvent([accepted], ev("UPDATE", payloadRow({ ...accepted, status: "handed_over" }))).fetchId).toBe(1);
    const out = deal(1, { type: "rental", status: "handed_over", rental: rental() });
    expect(applyTransactionEvent([out], ev("UPDATE", payloadRow({ ...out, status: "returned" }))).fetchId).toBe(1);
  });

  it("never shows a handed-over or returned rental without its rental terms (keeps the old state until the fetch)", () => {
    // Regression: the deal screen crashed when a rental flipped to handed_over with rental = null
    const accepted = deal(1, { type: "rental", status: "accepted" });
    const list = [accepted];
    const handed = applyTransactionEvent(list, ev("UPDATE", payloadRow({ ...accepted, status: "handed_over" })));
    expect(handed.transactions).toBe(list);
    expect(handed.transactions[0].status).toBe("accepted");
    const out = deal(1, { type: "rental", status: "handed_over", rental: rental() });
    const returned = applyTransactionEvent([out], ev("UPDATE", payloadRow({ ...out, status: "returned" })));
    expect(returned.transactions[0]).toEqual(out);
    for (const t of [...handed.transactions, ...returned.transactions]) {
      if (t.type === "rental" && ["handed_over", "returned", "completed"].includes(t.status)) expect(t.rental).not.toBeNull();
    }
  });

  it("removes a deleted deal", () => {
    const res = applyTransactionEvent([deal(1), deal(2)], ev("DELETE", null, { transaction_id: 1 }));
    expect(res.transactions.map((t) => t.transaction_id)).toEqual([2]);
  });

  it("asks for the whole row when the payload is too thin to show", () => {
    const res = applyTransactionEvent([], ev("UPDATE", { transaction_id: 9, status: "accepted" }));
    expect(res.transactions).toEqual([]);
    expect(res.fetchId).toBe(9);
  });

  it("does nothing for an empty payload", () => {
    const list = [deal(1)];
    expect(applyTransactionEvent(list, ev("UPDATE", {})).transactions).toBe(list);
  });
});

describe("rentalEmbedStale", () => {
  it("is false for sales and for rentals before the hand-off", () => {
    expect(rentalEmbedStale(undefined, deal(1, { status: "handed_over" }))).toBe(false);
    expect(rentalEmbedStale(undefined, deal(1, { type: "rental", status: "accepted" }))).toBe(false);
  });
  it("is true when the rentals row is new or was just updated", () => {
    expect(rentalEmbedStale(deal(1, { type: "rental" }), deal(1, { type: "rental", status: "handed_over" }))).toBe(true);
    expect(rentalEmbedStale(deal(1, { type: "rental", rental: rental() }), deal(1, { type: "rental", status: "returned" }))).toBe(true);
  });
});

describe("toTransaction", () => {
  it("flattens the rentals embed and coerces numerics", () => {
    const t = toTransaction({ ...payloadRow(deal(1, { type: "rental" })), rentals: [{ ...rental(), deposit_agreed: "30.00" as unknown as number }] });
    expect(t.rental?.deposit_agreed).toBe(30);
    expect(t.agreed_price).toBe(20);
  });
});

describe("resyncItemIds", () => {
  it("lists items of new or changed deals and of chats about unknown items", () => {
    const prev = { transactions: [deal(1), deal(2)], items: [{ item_id: 501 }, { item_id: 502 }, { item_id: 101 }] };
    const next = {
      transactions: [deal(1), deal(2, { status: "accepted" }), deal(3)],
      conversations: [conv(1), conv(7)],
    };
    expect(resyncItemIds(prev, next)).toEqual([107, 502, 503]);
  });
});

describe("profiles", () => {
  const profile = (id: string): Profile => ({ id, name: id, email: id === ME ? "me@x.edu" : "", role: "student", account_status: "active", created_at: "2026-01-01" }) as Profile;

  it("finds referenced students the store has no profile for", () => {
    expect(missingProfileIds([profile(ME)], [BUYER, ME, BUYER, null, undefined, ""])).toEqual([BUYER]);
    expect(missingProfileIds([profile(ME), profile(BUYER)], [BUYER])).toEqual([]);
  });

  it("adds fetched profiles with a blank email, never replacing known ones", () => {
    const list = [profile(ME)];
    const { email: _e, ...fresh } = profile(BUYER);
    void _e;
    const out = mergeProfiles(list, [fresh, { ...fresh, id: ME, name: "other" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toMatchObject({ id: BUYER, name: BUYER, email: "" });
    expect(mergeProfiles(list, [])).toBe(list);
  });

  it("a message from a brand-new student references a profile to fetch", () => {
    const m = msg(1, { sender_id: "u-new" });
    expect(missingProfileIds([profile(ME)], [m.sender_id])).toEqual(["u-new"]);
  });
});

describe("full refresh merges", () => {
  it("unionChats keeps rows that arrived during the reload and set read_at", () => {
    const snapshot = { conversations: [conv(1)], messages: [msg(1), msg(2)] };
    const local = { conversations: [conv(1), conv(2)], messages: [msg(1), msg(2, { read_at: "t" }), msg(3, { conversation_id: 2 })] };
    const out = unionChats(snapshot, local);
    expect(out.conversations.map((c) => c.conversation_id)).toEqual([1, 2]);
    expect(out.messages.map((m) => m.message_id)).toEqual([1, 2, 3]);
    expect(out.messages[1].read_at).toBe("t");
  });

  it("mergeResyncDeals prefers local rows changed during the reload", () => {
    const snapshot = [deal(1), deal(2)];
    const local = [deal(1), deal(2, { status: "accepted" }), deal(3)];
    expect(mergeResyncDeals(snapshot, local, new Set())).toBe(snapshot);
    const out = mergeResyncDeals(snapshot, local, new Set([2, 3]));
    expect(out.map((t) => [t.transaction_id, t.status])).toEqual([
      [1, "requested"],
      [2, "accepted"],
      [3, "requested"],
    ]);
  });
});
