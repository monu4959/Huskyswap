"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { Check, FileQuestion, MapPin, MessageSquare, Star } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { dealRole, dealTone } from "@/components/DealRow";
import { ItemArt } from "@/components/ItemArt";
import { ReportButton } from "@/components/ReportDialog";
import { Button, Card, EmptyState, Field, Seg, StatusPill, TopBar, inputClass, roundClass, useAction } from "@/components/ui";
import { DEAL_STATUS_LABEL, RETURN_CONDITION_LABEL, formatPrice } from "@/lib/constants";
import { shortDate, timeAgo } from "@/lib/format";
import { MEETUP_SPOTS } from "@/lib/reference";
import { useStore } from "@/lib/store";
import type { ReturnCondition, Transaction, TransactionStatus } from "@/lib/types";

const SALE_STEPS: { status: TransactionStatus; label: string }[] = [
  { status: "requested", label: "Requested" },
  { status: "accepted", label: "Accepted" },
  { status: "handed_over", label: "Handed over" },
  { status: "completed", label: "Done" },
];
const RENTAL_STEPS: { status: TransactionStatus; label: string }[] = [
  { status: "requested", label: "Requested" },
  { status: "accepted", label: "Accepted" },
  { status: "handed_over", label: "Picked up" },
  { status: "returned", label: "Returned" },
  { status: "completed", label: "Closed" },
];

export function DealDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const store = useStore();
  const router = useRouter();
  const act = useAction();
  const deal = store.db.transactions.find((t) => t.transaction_id === Number(id));
  const item = deal && store.item(deal.item_id);

  if (!deal || !item || (deal.buyer_id !== store.me && item.owner_id !== store.me)) {
    return (
      <>
        <TopBar back="/deals" />
        <EmptyState icon={<FileQuestion className="size-7" strokeWidth={1.6} />} title="Deal not found" />
      </>
    );
  }

  const mine = item.owner_id === store.me;
  const otherId = mine ? deal.buyer_id : item.owner_id;
  const other = store.profile(otherId);
  const spot = MEETUP_SPOTS.find((s) => s.spot_id === item.meetup_spot_id)?.name;
  const steps = deal.type === "sale" ? SALE_STEPS : RENTAL_STEPS;
  const ended = deal.status === "declined" || deal.status === "cancelled";
  const current = steps.findIndex((s) => s.status === deal.status);
  const overdue = deal.status === "handed_over" && deal.rental && deal.rental.due_date < new Date().toISOString().slice(0, 10);

  const message = async () => {
    const convId = await act(() => store.openConversation(item.item_id, deal.buyer_id));
    if (convId) router.push(`/inbox/${convId}`);
  };

  return (
    <>
      <TopBar back="/deals" title={dealRole(deal, mine)} />
      <main className="space-y-4 px-5 pt-1 pb-32">
        <Link href={`/item/${item.item_id}`} className="flex items-center gap-3 rounded-[20px] bg-surface p-2.5 shadow-raise">
          <span className="size-[60px] shrink-0 overflow-hidden rounded-[14px]">
            <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-11" />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13.5px] font-semibold">{item.title}</b>
            <span className="font-display my-0.5 block text-[17px] font-semibold">
              {formatPrice(deal.agreed_price)}
              {deal.type === "rental" && <small className="font-sans text-[12px] font-medium text-muted"> for one week</small>}
            </span>
            <StatusPill tone={dealTone(deal.status)}>{DEAL_STATUS_LABEL[deal.status]}</StatusPill>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <Avatar name={other?.name ?? "?"} />
          <div className="min-w-0 flex-1">
            <b className="block text-[14px] font-semibold">{other?.name}</b>
            <span className="text-[12px] text-muted">{mine ? (deal.type === "sale" ? "Buyer" : "Borrower") : "Owner"}</span>
          </div>
          <button type="button" onClick={message} className={roundClass} aria-label={`Message ${other?.name}`}>
            <MessageSquare className="size-5" />
          </button>
        </div>

        {ended ? (
          <Card className="p-4">
            <StatusPill tone="muted">{DEAL_STATUS_LABEL[deal.status]}</StatusPill>
            <p className="mt-2 text-[13.5px] text-muted">
              {deal.status === "declined"
                ? mine
                  ? "You declined this request."
                  : `${other?.name} declined this request. The item may still be available to others.`
                : "This deal was cancelled."}
            </p>
          </Card>
        ) : (
          <ol className="flex py-1" aria-label="Progress">
            {steps.map((s, i) => {
              const done = i < current || deal.status === "completed";
              const now = i === current && deal.status !== "completed";
              return (
                <li key={s.status} className="flex flex-1 flex-col items-center text-center">
                  <span className="flex w-full items-center">
                    <span className={`h-0.5 flex-1 ${i === 0 ? "invisible" : done || now ? "bg-cyan" : "bg-field"}`} />
                    <span
                      className={`grid size-7 place-items-center rounded-full text-[12px] font-bold ${
                        done ? "bg-grad" : now ? "bg-surface text-cyan shadow-raise ring-[1.5px] ring-cyan" : "bg-field text-muted shadow-inset"
                      }`}
                      aria-current={now ? "step" : undefined}
                    >
                      {done ? <Check className="size-4" aria-hidden /> : i + 1}
                    </span>
                    <span className={`h-0.5 flex-1 ${i === steps.length - 1 ? "invisible" : done ? "bg-cyan" : "bg-field"}`} />
                  </span>
                  <span className={`mt-1.5 text-[11px] ${now ? "font-semibold text-fg" : "text-muted"}`}>{s.label}</span>
                </li>
              );
            })}
          </ol>
        )}

        {!ended && deal.status !== "completed" && (
          <Card className="space-y-3 p-4">
            <NextStep deal={deal} mine={mine} otherName={other?.name ?? "The other student"} />
          </Card>
        )}

        {deal.rental && (
          <Card className="p-4">
            <h2 className="mb-2 text-[14px] font-semibold">Rental week</h2>
            <dl className="grid grid-cols-2 gap-y-1 text-[13px]">
              <dt className="text-muted">Picked up</dt>
              <dd className="font-semibold">{shortDate(deal.rental.start_date)}</dd>
              <dt className="text-muted">Due back</dt>
              <dd className={`font-semibold ${overdue ? "text-coral" : ""}`}>
                {shortDate(deal.rental.due_date)}
                {overdue ? " (overdue)" : ""}
              </dd>
              <dt className="text-muted">Deposit</dt>
              <dd className="font-semibold">{formatPrice(deal.rental.deposit_agreed)}</dd>
              {deal.rental.return_condition && (
                <>
                  <dt className="text-muted">Came back</dt>
                  <dd className="font-semibold">{RETURN_CONDITION_LABEL[deal.rental.return_condition]}</dd>
                </>
              )}
            </dl>
          </Card>
        )}

        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <MapPin className="size-4 text-cyan" aria-hidden />
          Meet at {spot}. Requested {timeAgo(deal.created_at)}.
        </p>

        {deal.status === "completed" && <Reviews deal={deal} otherName={other?.name ?? ""} />}

        <ReportButton target={{ item_id: null, transaction_id: deal.transaction_id, reported_user_id: null }} label="Report a problem with this deal" />
      </main>
    </>
  );
}

// The step the signed-in user can take, or what they're waiting for.
function NextStep({ deal, mine, otherName }: { deal: Transaction; mine: boolean; otherName: string }) {
  const store = useStore();
  const act = useAction();
  const [condition, setCondition] = useState<ReturnCondition>("as_lent");
  const rental = deal.type === "rental";
  const tid = deal.transaction_id;

  const wait = (text: string) => <p className="text-[13.5px] text-muted">{text}</p>;
  const cancel = (
    <Button variant="ghost" className="w-full !text-coral" onClick={() => act(() => store.cancelDeal(tid), "Deal cancelled")}>
      Cancel deal
    </Button>
  );

  if (mine) {
    switch (deal.status) {
      case "requested":
        return (
          <>
            <p className="font-semibold">
              {otherName} wants to {rental ? "rent this for a week" : "buy this"}.
            </p>
            <p className="text-[13px] text-muted">Accepting reserves the item and declines any other requests for it.</p>
            <div className="grid grid-cols-2 gap-2.5">
              <Button variant="soft" onClick={() => act(() => store.declineDeal(tid), "Request declined")}>
                Decline
              </Button>
              <Button onClick={() => act(() => store.acceptDeal(tid), "Request accepted")}>Accept</Button>
            </div>
          </>
        );
      case "accepted":
        return (
          <>
            <p className="font-semibold">Meet up and hand it over.</p>
            <p className="text-[13px] text-muted">
              {rental
                ? "Tap this once they have it. The rental week starts today and the deposit is collected in person."
                : "Tap this once they have it and you've been paid."}
            </p>
            <Button className="w-full" onClick={() => act(() => store.handOver(tid), "Marked as handed over")}>
              I handed it over
            </Button>
            {cancel}
          </>
        );
      case "handed_over":
        if (!rental) return wait(`Waiting for ${otherName} to confirm they got it.`);
        return (
          <>
            <p className="font-semibold">When it comes back, record its condition.</p>
            <Seg<ReturnCondition>
              label="Condition on return"
              value={condition}
              onChange={setCondition}
              options={(Object.keys(RETURN_CONDITION_LABEL) as ReturnCondition[]).map((c) => ({ value: c, label: RETURN_CONDITION_LABEL[c] }))}
            />
            <Button className="w-full" onClick={() => act(() => store.markReturned(tid, condition), "Return recorded")}>
              It&apos;s back
            </Button>
          </>
        );
      case "returned":
        return (
          <>
            <p className="font-semibold">Settle the deposit to close the rental.</p>
            <p className="text-[13px] text-muted">
              Give back the {formatPrice(deal.rental?.deposit_agreed ?? 0)} deposit, minus anything you agreed on for damage.
            </p>
            <Button className="w-full" onClick={() => act(() => store.closeRental(tid), "Rental closed")}>
              Deposit settled, close rental
            </Button>
          </>
        );
    }
  } else {
    switch (deal.status) {
      case "requested":
        return (
          <>
            {wait(`Waiting for ${otherName} to accept. You'll see it here and in your chats.`)}
            {cancel}
          </>
        );
      case "accepted":
        return (
          <>
            {wait(
              `${otherName} accepted. Agree on a time in chat and bring ${
                rental ? `${formatPrice(deal.agreed_price)} plus the deposit` : formatPrice(deal.agreed_price)
              }.`,
            )}
            {cancel}
          </>
        );
      case "handed_over":
        if (rental) return wait(`Enjoy it. Return it to ${otherName} by ${shortDate(deal.rental!.due_date)} to get your deposit back.`);
        return (
          <>
            <p className="font-semibold">Got the item?</p>
            <Button className="w-full" onClick={() => act(() => store.confirmReceived(tid), "Purchase complete")}>
              Yes, I have it
            </Button>
          </>
        );
      case "returned":
        return wait(`${otherName} has it back and is settling your deposit.`);
    }
  }
  return null;
}

function Reviews({ deal, otherName }: { deal: Transaction; otherName: string }) {
  const store = useStore();
  const act = useAction();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const reviews = store.db.reviews.filter((r) => r.transaction_id === deal.transaction_id);
  const mineReview = reviews.find((r) => r.reviewer_id === store.me);
  const theirs = reviews.find((r) => r.reviewer_id !== store.me);

  return (
    <section className="space-y-3">
      <h2 className="text-[16px] font-semibold">Reviews</h2>
      {mineReview ? (
        <ReviewCard who="You" rating={mineReview.rating} comment={mineReview.comment} />
      ) : (
        <Card className="space-y-3 p-4">
          <p className="font-semibold">How was it with {otherName}?</p>
          <div role="radiogroup" aria-label="Rating" className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
                onClick={() => setRating(n)}
                className="grid size-11 cursor-pointer place-items-center"
              >
                <Star className={`size-8 ${n <= rating ? "fill-[#F7B955] text-[#F7B955]" : "text-muted/50"}`} aria-hidden />
              </button>
            ))}
          </div>
          <Field label="Comment (optional)">
            <textarea rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} className={`${inputClass} resize-none`} />
          </Field>
          <Button className="w-full" disabled={!rating} onClick={() => act(() => store.leaveReview(deal.transaction_id, rating, comment), "Review posted")}>
            Post review
          </Button>
        </Card>
      )}
      {theirs && <ReviewCard who={otherName} rating={theirs.rating} comment={theirs.comment} />}
    </section>
  );
}

function ReviewCard({ who, rating, comment }: { who: string; rating: number; comment: string | null }) {
  return (
    <Card className="p-3.5">
      <p className="flex items-center gap-2 text-[13px]">
        <span className="font-semibold">{who}</span>
        <span className="flex" aria-label={`${rating} out of 5 stars`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Star key={n} className={`size-3.5 ${n <= rating ? "fill-[#F7B955] text-[#F7B955]" : "text-muted/50"}`} aria-hidden />
          ))}
        </span>
      </p>
      {comment && <p className="mt-1 text-[13px] text-muted">{comment}</p>}
    </Card>
  );
}
