"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, CircleDollarSign, MessageCircleOff, SendHorizontal } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { dealTone } from "@/components/DealRow";
import { ItemArt } from "@/components/ItemArt";
import { priceText } from "@/components/Price";
import { BackButton, Button, EmptyState, StatusPill, TopBar, useAction } from "@/components/ui";
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
      <>
        <TopBar back="/inbox" />
        <EmptyState icon={<MessageCircleOff className="size-7" strokeWidth={1.6} />} title="Conversation not found" />
      </>
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
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 bg-bg/95 px-5 pt-[max(env(safe-area-inset-top),12px)] pb-3 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2.5">
          <BackButton href="/inbox" />
          <Avatar name={other?.name ?? "?"} />
          <div className="min-w-0">
            <b className="font-display block truncate text-[15px] font-semibold">{other?.name}</b>
            <span className="text-[12px] text-muted">{selling ? "Interested in your listing" : "Seller"}</span>
          </div>
        </div>
        <Link href={`/item/${item.item_id}`} className="flex items-center gap-2.5 rounded-[18px] bg-surface py-2 pr-3 pl-2 shadow-raise">
          <span className="size-[46px] shrink-0 overflow-hidden rounded-xl">
            <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-[34px]" />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13px] font-semibold">{item.title}</b>
            <span className="text-[12px] text-muted">
              {priceText(item)}
              {item.rental?.deposit ? `, ${formatPrice(item.rental.deposit)} deposit` : ""}
            </span>
          </span>
          <span className="text-[12.5px] font-semibold text-cyan">View</span>
        </Link>
      </header>

      <ol className="flex flex-1 flex-col gap-2 px-5 pt-2 pb-4" aria-label="Messages">
        {timeline.map((entry, i) => {
          const prev = timeline[i - 1];
          const showTime = !prev || Date.parse(entry.at) - Date.parse(prev.at) > 15 * 60_000;
          return (
            <li key={entry.kind === "msg" ? `m${entry.m.message_id}` : `t${entry.t.transaction_id}`} className="flex flex-col gap-2">
              {showTime && <p className="my-0.5 text-center text-[11px] text-muted">{clockTime(entry.at)}</p>}
              {entry.kind === "msg" ? (
                <p
                  className={`max-w-[80%] rounded-[18px] px-[13px] py-[9px] text-[13.5px] leading-snug whitespace-pre-line ${
                    entry.m.sender_id === store.me ? "bg-grad ml-auto rounded-br-md" : "rounded-bl-md bg-surface"
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
          <li className="py-10 text-center text-[14px] text-muted">Say hi and ask anything about the item. Agree on a time to meet here.</li>
        )}
        <li ref={endRef} aria-hidden />
      </ol>

      <form onSubmit={send} className="sticky bottom-0 flex items-end gap-2 bg-bg px-4 pt-2 pb-[max(env(safe-area-inset-bottom),20px)]">
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
            className="block max-h-32 min-h-[46px] w-full resize-none rounded-[14px] bg-field px-3.5 py-3 text-[14px] text-fg shadow-inset outline-none placeholder:text-muted focus:ring-[1.5px] focus:ring-cyan"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
          className="bg-grad grid size-[46px] shrink-0 cursor-pointer place-items-center rounded-[14px] disabled:cursor-not-allowed disabled:opacity-45"
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
    <div className="rounded-[20px] bg-surface p-3.5 shadow-raise">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[14px] font-semibold">{rental ? "Rental request" : "Purchase request"}</h4>
        <StatusPill tone={dealTone(deal.status)}>{DEAL_STATUS_LABEL[deal.status]}</StatusPill>
      </div>
      <p className="mb-1.5 flex items-center gap-2 text-[12.5px]">
        <CalendarDays className="size-4 text-muted" aria-hidden />
        {deal.rental
          ? `${shortDate(deal.rental.start_date)} to ${shortDate(deal.rental.due_date)}`
          : rental
            ? `${RENTAL_DAYS} days from pickup`
            : "Pick up at the meetup spot"}
      </p>
      <p className="flex items-center gap-2 text-[12.5px]">
        <CircleDollarSign className="size-4 text-muted" aria-hidden />
        {formatPrice(deal.agreed_price)}
        {rental ? ` for the week${deposit ? `, ${formatPrice(deposit)} deposit in person` : ""}` : ", paid in person"}
      </p>
      {selling && deal.status === "requested" ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Button variant="soft" className="!h-9 rounded-xl text-[13px]" onClick={() => act(() => store.declineDeal(deal.transaction_id), "Request declined")}>
            Decline
          </Button>
          <Button className="!h-9 rounded-xl text-[13px]" onClick={() => act(() => store.acceptDeal(deal.transaction_id), `Accepted ${otherName}'s request`)}>
            Accept
          </Button>
        </div>
      ) : (
        <Link href={`/deals/${deal.transaction_id}`} className="mt-2 inline-block text-[12.5px] font-semibold text-cyan">
          Open deal
        </Link>
      )}
    </div>
  );
}
