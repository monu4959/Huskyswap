"use client";

import Link from "next/link";
import { ItemArt } from "./ItemArt";
import { StatusPill, type Tone } from "./ui";
import { DEAL_STATUS_LABEL } from "@/lib/constants";
import { shortDate } from "@/lib/format";
import { MEETUP_SPOTS } from "@/lib/reference";
import { useStore } from "@/lib/store";
import type { Transaction, TransactionStatus } from "@/lib/types";

export const dealTone = (s: TransactionStatus): Tone =>
  s === "completed"
    ? "green"
    : s === "requested"
      ? "amber"
      : s === "accepted"
        ? "cyan"
        : s === "handed_over" || s === "returned"
          ? "violet"
          : "muted";

export function dealRole(t: Transaction, mine: boolean) {
  if (t.type === "sale") return mine ? "Selling" : "Buying";
  return mine ? "Lending" : "Renting";
}

const daysUntil = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
};

// One line describing where the deal stands, per the design's deal cards
export function dealLine(t: Transaction, mine: boolean, otherName: string, spot: string | undefined) {
  switch (t.status) {
    case "requested":
      return mine ? `${otherName} sent a request` : `Waiting for ${otherName} to reply`;
    case "accepted":
      return `Meet at ${spot}`;
    case "handed_over":
      return t.rental ? `Rental, return by ${shortDate(t.rental.due_date)}` : mine ? `Waiting for ${otherName} to confirm` : "Confirm you got it";
    case "returned":
      return mine ? "Settle the deposit to close" : `${otherName} is settling your deposit`;
    case "completed":
      return t.rental ? `Picked up ${shortDate(t.rental.start_date)}` : "Done";
    case "declined":
      return mine ? "You declined" : `${otherName} declined`;
    case "cancelled":
      return "Cancelled";
  }
}

export function DealRow({ deal }: { deal: Transaction }) {
  const store = useStore();
  const item = store.item(deal.item_id);
  if (!item) return null;
  const mine = item.owner_id === store.me;
  const other = store.profile(mine ? deal.buyer_id : item.owner_id);
  const spot = MEETUP_SPOTS.find((s) => s.spot_id === item.meetup_spot_id)?.name;
  const reviewed = store.db.reviews.some((r) => r.transaction_id === deal.transaction_id && r.reviewer_id === store.me);

  let pill = DEAL_STATUS_LABEL[deal.status];
  if (deal.status === "handed_over" && deal.rental) {
    const left = daysUntil(deal.rental.due_date);
    pill = left < 0 ? "Overdue" : left === 0 ? "Due today" : `Due in ${left} day${left === 1 ? "" : "s"}`;
  }
  const overdue = pill === "Overdue";

  return (
    <Link href={`/deals/${deal.transaction_id}`} className="flex items-center gap-3 rounded-[20px] bg-surface p-2.5 shadow-raise">
      <span className="size-[60px] shrink-0 overflow-hidden rounded-[14px]">
        <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-11" />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13.5px] font-semibold">{item.title}</b>
        <span className="mt-0.5 mb-1.5 block truncate text-[12px] text-muted">
          {dealLine(deal, mine, other?.name ?? "them", spot)}
        </span>
        <span className="flex items-center">
          <StatusPill tone={overdue ? "coral" : dealTone(deal.status)}>{pill}</StatusPill>
          {deal.status === "completed" && !reviewed && (
            <span className="ml-2 text-[12px] font-semibold whitespace-nowrap text-cyan">Leave a review</span>
          )}
        </span>
      </span>
    </Link>
  );
}
