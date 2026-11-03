"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useRef, useState } from "react";
import { BadgeCheck, ChevronLeft, HandCoins, Heart, MapPinned, MessageSquare, PackageX } from "lucide-react";
import { Avatar, Rating } from "@/components/Avatar";
import { Illustration } from "@/components/ItemArt";
import { PhotoCreditLine } from "@/components/PhotoCredit";
import { ReportButton } from "@/components/ReportDialog";
import { BackButton, Button, EmptyState, StatusPill, TopBar, buttonClass, pageClass, roundClass, useAction, type Tone } from "@/components/ui";
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
  const carousel = useRef<HTMLDivElement>(null);

  if (!item || (item.status === "removed" && item.owner_id !== store.me)) {
    return (
      <div className={pageClass}>
        <TopBar back="/" />
        <EmptyState icon={<PackageX className="size-7" strokeWidth={1.6} />} title="This listing is gone">
          It may have been sold or taken down.{" "}
          <Link href="/" className="font-semibold text-accent-ink">
            Keep browsing
          </Link>
        </EmptyState>
      </div>
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
  const showPhoto = (i: number) => {
    const el = carousel.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  const saveButton = !mine && (
    <button
      type="button"
      onClick={() => act(() => store.toggleSave(item.item_id))}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save"}
      className={roundClass}
    >
      <Heart className={`size-5 ${saved ? "fill-accent-ink text-accent-ink" : ""}`} />
    </button>
  );

  const actions = mine ? (
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
    <div className="grid grid-cols-[auto_1fr] gap-2.5">
      <Button variant="soft" onClick={message} className="px-5">
        <MessageSquare className="size-[18px]" aria-hidden />
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
  );

  return (
    <div className={`${pageClass} pb-40 md:pt-6 md:pb-24`}>
      <div className="mb-5 hidden items-center justify-between md:flex">
        <button type="button" onClick={() => router.back()} className="inline-flex cursor-pointer items-center gap-1 rounded-full py-2 pr-3 text-small font-semibold text-muted hover:text-fg">
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>
        {saveButton}
      </div>

      <div className="md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:items-start md:gap-10 lg:gap-14">
        {/* gallery */}
        <div className="-mx-4 sm:-mx-6 md:sticky md:top-24 md:mx-0">
          <div className="relative aspect-square overflow-hidden bg-field md:rounded-sheet">
            {item.images.length ? (
              <div
                ref={carousel}
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
                <Illustration category={item.category} className="absolute top-1/2 left-1/2 size-1/2 -translate-x-1/2 -translate-y-1/2" />
                <span className="sr-only">{item.title}</span>
              </>
            )}
            <div className="absolute inset-x-4 top-[max(env(safe-area-inset-top),12px)] z-10 flex justify-between md:hidden">
              <BackButton />
              {saveButton}
            </div>
            {item.images.length > 1 && (
              <span className="absolute right-4 bottom-4 rounded-full bg-black/60 px-2.5 py-1 text-micro font-semibold text-white backdrop-blur-sm">
                {photo + 1} / {item.images.length}
              </span>
            )}
          </div>
          {item.images.length > 1 && (
            <div className="mt-3 hidden gap-2.5 md:flex">
              {item.images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => showPhoto(i)}
                  aria-label={`Show photo ${i + 1}`}
                  aria-current={photo === i}
                  className={`size-[72px] cursor-pointer overflow-hidden rounded-tile bg-field transition-[box-shadow,opacity] ${
                    photo === i ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : "opacity-70 hover:opacity-100"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data URLs in the demo */}
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* details */}
        <main className="pt-6 md:pt-2">
          <div className="flex flex-wrap gap-1.5">
            <StatusPill tone={CONDITION_TONE[item.condition]}>{CONDITION_LABEL[item.condition]}</StatusPill>
            {item.status !== "available" && <StatusPill tone="amber">{ITEM_STATUS_LABEL[item.status]}</StatusPill>}
            <StatusPill tone="muted">{CATEGORY_LABEL[item.category]}</StatusPill>
          </div>
          <h1 className="mt-3 text-title md:text-[2.5rem] md:leading-[1.08]">{item.title}</h1>

          <div className={`mt-5 grid gap-2.5 ${both ? "grid-cols-2" : "grid-cols-1"}`} role={both && !mine ? "radiogroup" : undefined} aria-label="Buy or rent">
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
            <p className="mt-2.5 text-small text-muted">
              Rentals last {RENTAL_DAYS} days from pickup. The deposit comes back when you return it.
            </p>
          )}

          <div className="mt-6 hidden md:block">{actions}</div>

          {/* trust row */}
          <ul className="mt-6 grid grid-cols-3 gap-2 rounded-card bg-surface p-3 shadow-raise">
            {[
              { icon: BadgeCheck, title: "NU verified", sub: "@northeastern.edu" },
              { icon: MapPinned, title: "Campus pickup", sub: spot ?? "Meetup spot" },
              { icon: HandCoins, title: "Pay in person", sub: "No card needed" },
            ].map(({ icon: Icon, title, sub }) => (
              <li key={title} className="flex flex-col items-center gap-1 px-1 py-1.5 text-center">
                <Icon className="size-5 text-accent-ink" strokeWidth={1.8} aria-hidden />
                <b className="text-micro font-semibold">{title}</b>
                <span className="line-clamp-1 text-[11px] text-muted">{sub}</span>
              </li>
            ))}
          </ul>

          {owner && (
            <div className="mt-6 flex items-center gap-3">
              <Avatar name={owner.name} size={44} />
              <div className="min-w-0">
                <b className="block text-body font-semibold">{mine ? "You" : owner.name}</b>
                <Rating {...store.ratingFor(owner.id)} />
              </div>
            </div>
          )}

          {item.description && (
            <section className="mt-6">
              <h2 className="mb-2 text-lead font-semibold">About this item</h2>
              <p className="text-body leading-relaxed text-muted">{item.description}</p>
            </section>
          )}

          <p className="mt-6 text-small text-muted">
            Meet at <b className="font-semibold text-fg">{spot}</b>. {CATEGORY_LABEL[item.category]}, listed {timeAgo(item.created_at)}.
          </p>
          <PhotoCreditLine src={item.images[photo]} className="mt-2" />

          {!mine && (
            <div className="mt-4">
              <ReportButton target={{ item_id: item.item_id, transaction_id: null, reported_user_id: null }} label="Report this listing" />
            </div>
          )}
        </main>
      </div>

      {/* actions on phones: pinned to the bottom, primary button full width */}
      <div className="shadow-bar fixed inset-x-0 bottom-0 z-30 bg-surface/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] backdrop-blur-md md:hidden">
        {actions}
      </div>
    </div>
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
      <span className="block text-small text-muted">{label}</span>
      <b className="mt-1 block text-[1.75rem] leading-none font-bold tracking-[-0.02em]">
        {price}
        {suffix && <small className="text-small font-medium tracking-normal text-muted"> {suffix}</small>}
      </b>
    </>
  );
  const base = "rounded-card px-4 py-3.5 text-left";
  if (!interactive) return <div className={`${base} bg-surface shadow-raise`}>{body}</div>;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`${base} cursor-pointer transition-[box-shadow,border-color] ${selected ? "border-grad shadow-raise" : "border-2 border-transparent bg-surface shadow-raise hover:border-line"}`}
    >
      {body}
    </button>
  );
}
