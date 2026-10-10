"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { Heart, MapPin, PackageX } from "lucide-react";
import { Avatar, Rating } from "@/components/Avatar";
import { Illustration } from "@/components/ItemArt";
import { PhotoCreditLine } from "@/components/PhotoCredit";
import { ReportButton } from "@/components/ReportDialog";
import { BackButton, Button, EmptyState, StatusPill, TopBar, buttonClass, roundClass, useAction, type Tone } from "@/components/ui";
import { CATEGORY_LABEL, CONDITION_LABEL, ITEM_STATUS_LABEL, RENTAL_DAYS, formatPrice } from "@/lib/constants";
import { timeAgo } from "@/lib/format";
import { MEETUP_SPOTS } from "@/lib/reference";
import { useStore } from "@/lib/store";
import type { ItemCondition, TransactionType } from "@/lib/types";

const CONDITION_TONE: Record<ItemCondition, Tone> = { new: "cyan", like_new: "green", good: "violet", fair: "amber" };

export function ItemDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const store = useStore();
  const router = useRouter();
  const act = useAction();
  const item = store.item(Number(id));
  const [choice, setChoice] = useState<TransactionType | null>(null);
  const [photo, setPhoto] = useState(0);

  if (!item || (item.status === "removed" && item.owner_id !== store.me)) {
    return (
      <>
        <TopBar back="/" />
        <EmptyState icon={<PackageX className="size-7" strokeWidth={1.6} />} title="This listing is gone">
          It may have been sold or taken down.{" "}
          <Link href="/" className="font-semibold text-cyan">
            Keep browsing
          </Link>
        </EmptyState>
      </>
    );
  }

  const mine = item.owner_id === store.me;
  const owner = store.profile(item.owner_id);
  const spot = MEETUP_SPOTS.find((s) => s.spot_id === item.meetup_spot_id)?.name;
  const saved = store.isSaved(item.item_id);
  const selected: TransactionType = choice ?? (item.sale ? "sale" : "rental");
  const openDeal = store.myDeals.find(
    (t) => t.item_id === item.item_id && t.buyer_id === store.me && ["requested", "accepted", "handed_over"].includes(t.status),
  );
  const both = !!item.sale && !!item.rental;

  const message = async () => {
    const convId = await act(() => store.openConversation(item.item_id));
    if (convId) router.push(`/inbox/${convId}`);
  };
  const request = async () => {
    const txId = await act(
      () => store.requestDeal(item.item_id, selected),
      selected === "sale" ? "Request sent to the seller" : "Rental request sent",
    );
    if (txId) router.push(`/deals/${txId}`);
  };

  return (
    <>
      {/* hero */}
      <div className="relative h-[290px]">
        {item.images.length ? (
          <div
            className="scrollbar-none flex h-full snap-x snap-mandatory overflow-x-auto"
            onScroll={(e) => setPhoto(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
          >
            {item.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- local data URLs in the demo
              <img key={i} src={src} alt={`${item.title}, photo ${i + 1}`} className="h-full w-full shrink-0 snap-center object-cover" />
            ))}
          </div>
        ) : (
          <>
            <div className="plane absolute inset-x-[-10px] top-[56px] h-[200px]" />
            <Illustration category={item.category} onGrad className="absolute top-[60px] left-1/2 size-[190px] -translate-x-1/2" />
            <span className="sr-only">{item.title}</span>
          </>
        )}
        <div className="absolute inset-x-5 top-[max(env(safe-area-inset-top),12px)] z-10 flex justify-between">
          <BackButton />
          {!mine && (
            <button
              type="button"
              onClick={() => act(() => store.toggleSave(item.item_id))}
              aria-pressed={saved}
              aria-label={saved ? "Remove from saved" : "Save"}
              className={roundClass}
            >
              <Heart className={`size-5 ${saved ? "fill-[#FF7A7A] text-[#FF7A7A]" : ""}`} />
            </button>
          )}
        </div>
        {item.images.length > 1 && (
          <span className="absolute right-5 bottom-10 rounded-full bg-black/55 px-2.5 py-0.5 text-[12px] font-semibold text-white">
            {photo + 1} / {item.images.length}
          </span>
        )}
      </div>

      {/* sheet */}
      <main className="relative -mt-6 min-h-[calc(100dvh-266px)] rounded-t-[30px] bg-surface px-5 pt-[22px] pb-36 shadow-[0_-10px_30px_rgba(8,11,19,0.25)]">
        <div className="flex items-start justify-between gap-2.5">
          <h1 className="text-[19px] leading-tight font-bold">{item.title}</h1>
          <div className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
            <StatusPill tone={CONDITION_TONE[item.condition]}>{CONDITION_LABEL[item.condition]}</StatusPill>
            {item.status !== "available" && <StatusPill tone="amber">{ITEM_STATUS_LABEL[item.status]}</StatusPill>}
          </div>
        </div>

        {owner && (
          <div className="mt-3.5 mb-4 flex items-center gap-2.5">
            <Avatar name={owner.name} size={34} />
            <div>
              <b className="block text-[13.5px] font-semibold">{mine ? "You" : owner.name}</b>
              <Rating {...store.ratingFor(owner.id)} />
            </div>
          </div>
        )}

        <div className={`grid gap-2.5 ${both ? "grid-cols-2" : "grid-cols-1"}`} role={both && !mine ? "radiogroup" : undefined} aria-label="Buy or rent">
          {item.sale && (
            <Option
              interactive={both && !mine}
              selected={selected === "sale"}
              onSelect={() => setChoice("sale")}
              label="Buy"
              price={formatPrice(item.sale.price)}
            />
          )}
          {item.rental && (
            <Option
              interactive={both && !mine}
              selected={selected === "rental"}
              onSelect={() => setChoice("rental")}
              label={item.rental.deposit ? `Rent, ${formatPrice(item.rental.deposit)} deposit` : "Rent, no deposit"}
              price={formatPrice(item.rental.price_per_week)}
              suffix="a week"
            />
          )}
        </div>
        {item.rental && (
          <p className="mt-2 text-[12px] text-muted">
            Rentals last {RENTAL_DAYS} days from pickup. The deposit comes back when you return it.
          </p>
        )}

        {item.description && <p className="mt-3 mb-2 text-[13.5px] leading-relaxed text-muted">{item.description}</p>}

        <p className="flex items-center gap-1.5 text-[13.5px] font-medium">
          <MapPin className="size-4 text-cyan" aria-hidden />
          Meet at {spot}
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          {CATEGORY_LABEL[item.category]}, listed {timeAgo(item.created_at)}
        </p>
        <PhotoCreditLine src={item.images[photo]} className="mt-2" />

        {!mine && (
          <div className="mt-4">
            <ReportButton target={{ item_id: item.item_id, transaction_id: null, reported_user_id: null }} label="Report this listing" />
          </div>
        )}
      </main>

      {/* actions */}
      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[480px] bg-surface px-5 pt-3.5 pb-[max(env(safe-area-inset-bottom),20px)]">
        {mine ? (
          <div className="grid grid-cols-2 gap-2.5">
            <Link href="/deals" className={buttonClass("soft")}>
              See requests
            </Link>
            {item.status !== "removed" && item.status !== "sold" ? (
              <Button variant="danger" onClick={() => act(() => store.removeListing(item.item_id), "Listing removed")}>
                Remove listing
              </Button>
            ) : (
              <span />
            )}
          </div>
        ) : openDeal ? (
          <Link href={`/deals/${openDeal.transaction_id}`} className={buttonClass("grad", "w-full")}>
            View your request
          </Link>
        ) : (
          <div className="grid grid-cols-[110px_1fr] gap-2.5">
            <Button variant="soft" onClick={message}>
              Message
            </Button>
            <Button disabled={item.status !== "available"} onClick={request}>
              {item.status !== "available"
                ? ITEM_STATUS_LABEL[item.status]
                : selected === "sale"
                  ? "Request to buy"
                  : "Request to rent"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function Option({
  interactive,
  selected,
  onSelect,
  label,
  price,
  suffix,
}: {
  interactive: boolean;
  selected: boolean;
  onSelect: () => void;
  label: string;
  price: string;
  suffix?: string;
}) {
  const body = (
    <>
      <span className="block text-[12px] text-muted">{label}</span>
      <b className="font-display mt-0.5 block text-[17px] font-semibold">
        {price}
        {suffix && <small className="font-sans text-[11.5px] font-medium text-muted"> {suffix}</small>}
      </b>
    </>
  );
  const base = "rounded-2xl px-3 py-[11px] text-left";
  if (!interactive) return <div className={`${base} bg-bg`}>{body}</div>;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`${base} cursor-pointer ${selected ? "border-grad" : "border-[1.5px] border-transparent bg-bg"}`}
    >
      {body}
    </button>
  );
}
