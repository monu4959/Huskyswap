"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, CircleDollarSign, MessageCircleOff, SendHorizontal } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { dealTone } from "@/components/DealRow";
import { ItemArt } from "@/components/ItemArt";
import { priceText } from "@/components/Price";
import { BackButton, Button, EmptyState, StatusPill, TopBar, narrowClass, useAction } from "@/components/ui";
import { DEAL_STATUS_LABEL, RENTAL_DAYS, formatPrice } from "@/lib/constants";
import { clockTime, shortDate } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Message, Transaction } from "@/lib/types";

// New messages arrive through the store's Realtime subscription.
export function Chat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const store = useStore();
  const { markRead } = store;
  const act = useAction();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLLIElement>(null);

  const conversationId = Number(id);
  const conv = store.db.conversations.find((c) => c.conversation_id === conversationId);
  const item = conv && store.item(conv.item_id);
  const allowed = conv && item && (conv.buyer_id === store.me || item.owner_id === store.me);
  const messages = store.db.messages.filter((m) => m.conversation_id === conversationId);
  // Requests between these two people show up inside the conversation
  const deals = conv ? store.db.transactions.filter((t) => t.item_id === conv.item_id && t.buyer_id === conv.buyer_id) : [];
  const timeline: ({ kind: "msg"; at: string; m: Message } | { kind: "deal"; at: string; t: Transaction })[] = [
    ...messages.map((m) => ({ kind: "msg" as const, at: m.sent_at, m })),
    ...deals.map((t) => ({ kind: "deal" as const, at: t.created_at, t })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  useEffect(() => {
    if (allowed) markRead(conversationId);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [allowed, conversationId, timeline.length, markRead]);

  if (!conv || !item || !allowed) {
    return (
      <div className={narrowClass}>
        <TopBar back="/inbox" />
        <EmptyState icon={<MessageCircleOff className="size-7" strokeWidth={1.6} />} title="Conversation not found" />
      </div>
    );
  }

  const selling = item.owner_id === store.me;
  const other = store.profile(selling ? conv.buyer_id : item.owner_id);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    const sent = await act(async () => {
      await store.sendMessage(conversationId, text);
      return true;
    });
    if (!sent) setDraft(text); // keep what they typed if it failed
  };

  return (
    <div className={`${narrowClass} flex min-h-dvh flex-col md:min-h-[calc(100dvh-64px)]`}>
      <header className="sticky top-0 z-20 -mx-4 bg-bg/90 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 backdrop-blur-md sm:-mx-6 sm:px-6 md:top-16 md:mx-0 md:px-0 md:pt-6">
        <div className="mb-3 flex items-center gap-3">
          <BackButton href="/inbox" />
          <Avatar name={other?.name ?? "?"} size={42} />
          <div className="min-w-0">
            <b className="block truncate text-body font-semibold">{other?.name}</b>
            <span className="text-micro text-muted">{selling ? "Interested in your listing" : "Seller"}</span>
          </div>
        </div>
        <Link
          href={`/item/${item.item_id}`}
          className="flex items-center gap-3 rounded-card bg-surface py-2 pr-4 pl-2 shadow-raise transition-shadow hover:shadow-lift"
        >
          <span className="size-12 shrink-0 overflow-hidden rounded-xl bg-field">
            <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-8" />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-small font-semibold">{item.title}</b>
            <span className="text-micro text-muted">
              {priceText(item)}
              {item.rental?.deposit ? `, ${formatPrice(item.rental.deposit)} deposit` : ""}
            </span>
          </span>
          <span className="text-small font-semibold text-accent-ink">View</span>
        </Link>
      </header>

      <ol className="flex flex-1 flex-col gap-2 pt-3 pb-4" aria-label="Messages">
        {timeline.map((entry, i) => {
          const prev = timeline[i - 1];
          const showTime = !prev || Date.parse(entry.at) - Date.parse(prev.at) > 15 * 60_000;
          return (
            <li key={entry.kind === "msg" ? `m${entry.m.message_id}` : `t${entry.t.transaction_id}`} className="flex flex-col gap-2">
              {showTime && <p className="my-1 text-center text-micro text-muted">{clockTime(entry.at)}</p>}
              {entry.kind === "msg" ? (
                <p
                  className={`max-w-[80%] rounded-[20px] px-4 py-2.5 text-small leading-snug whitespace-pre-line ${
                    entry.m.sender_id === store.me ? "bg-grad ml-auto rounded-br-md" : "rounded-bl-md bg-surface shadow-raise"
                  }`}
                >
                  <span className="sr-only">{entry.m.sender_id === store.me ? "You" : other?.name}: </span>
                  {entry.m.body}
                </p>
              ) : (
                <RequestCard deal={entry.t} selling={selling} otherName={other?.name ?? ""} act={act} />
              )}
            </li>
          );
        })}
        {timeline.length === 0 && (
          <li className="py-12 text-center text-small text-muted">Say hi and ask anything about the item. Agree on a time to meet here.</li>
        )}
        <li ref={endRef} aria-hidden />
      </ol>

      <form onSubmit={send} className="sticky bottom-0 -mx-4 flex items-end gap-2 bg-bg/95 px-4 pt-2 pb-[max(env(safe-area-inset-bottom),16px)] backdrop-blur-md sm:-mx-6 sm:px-6 md:mx-0 md:px-0 md:pb-6">
        <label className="flex-1">
          <span className="sr-only">Message</span>
          <textarea
            rows={1}
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message"
            className="block max-h-32 min-h-12 w-full resize-none rounded-[24px] bg-surface px-4.5 py-3 text-small text-fg shadow-raise outline-none placeholder:text-muted focus:ring-2 focus:ring-accent-ink"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
          className="bg-grad grid size-12 shrink-0 cursor-pointer place-items-center rounded-full transition-[background-color,scale] hover:bg-accent-press active:scale-95 disabled:cursor-not-allowed disabled:bg-field-strong disabled:text-muted"
        >
          <SendHorizontal className="size-5" />
        </button>
      </form>
    </div>
  );
}

function RequestCard({
  deal,
  selling,
  otherName,
  act,
}: {
  deal: Transaction;
  selling: boolean;
  otherName: string;
  act: ReturnType<typeof useAction>;
}) {
  const store = useStore();
  const rental = deal.type === "rental";
  const deposit = deal.rental?.deposit_agreed ?? store.item(deal.item_id)?.rental?.deposit ?? 0;
  return (
    <div className="mx-auto w-full max-w-[420px] rounded-card bg-surface p-4 shadow-raise">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h4 className="font-sans text-body leading-snug font-semibold">{rental ? "Rental request" : "Purchase request"}</h4>
        <StatusPill tone={dealTone(deal.status)}>{DEAL_STATUS_LABEL[deal.status]}</StatusPill>
      </div>
      <p className="mb-1.5 flex items-center gap-2 text-small">
        <CalendarDays className="size-4 text-muted" aria-hidden />
        {deal.rental
          ? `${shortDate(deal.rental.start_date)} to ${shortDate(deal.rental.due_date)}`
          : rental
            ? `${RENTAL_DAYS} days from pickup`
            : "Pick up at the meetup spot"}
      </p>
      <p className="flex items-center gap-2 text-small">
        <CircleDollarSign className="size-4 text-muted" aria-hidden />
        {formatPrice(deal.agreed_price)}
        {rental ? ` for the week${deposit ? `, ${formatPrice(deposit)} deposit in person` : ""}` : ", paid in person"}
      </p>
      {selling && deal.status === "requested" ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="soft" className="!h-10 text-small" onClick={() => act(() => store.declineDeal(deal.transaction_id), "Request declined")}>
            Decline
          </Button>
          <Button className="!h-10 text-small" onClick={() => act(() => store.acceptDeal(deal.transaction_id), `Accepted ${otherName}'s request`)}>
            Accept
          </Button>
        </div>
      ) : (
        <Link href={`/deals/${deal.transaction_id}`} className="mt-2.5 inline-block text-small font-semibold text-accent-ink">
          Open deal
        </Link>
      )}
    </div>
  );
}
