"use client";

import Link from "next/link";
import { Heart, MapPin } from "lucide-react";
import { ItemArt } from "./ItemArt";
import { useAction } from "./ui";
import { Price } from "./Price";
import { ITEM_STATUS_LABEL } from "@/lib/constants";
import { MEETUP_SPOTS } from "@/lib/reference";
import { useStore } from "@/lib/store";
import type { Item } from "@/lib/types";

// "For sale", "For rent" or "Free" tags on the photo
export function OfferBadges({ item }: { item: Pick<Item, "sale" | "rental"> }) {
  const free = item.sale?.price === 0 || (!item.sale && item.rental?.price_per_week === 0);
  const badge = "rounded-full bg-surface/95 px-2.5 py-1 text-[11px] leading-none font-semibold shadow-raise backdrop-blur-sm";
  return (
    <span className="flex flex-wrap gap-1.5">
      {free && <span className="bg-grad rounded-full px-2.5 py-1 text-[11px] leading-none font-semibold">Free</span>}
      {item.sale && !free && <span className={`${badge} text-fg`}>For sale</span>}
      {item.rental && <span className={`${badge} text-accent-ink`}>For rent</span>}
    </span>
  );
}

export function ItemCard({ item, showStatus = false }: { item: Item; showStatus?: boolean }) {
  const { isSaved, toggleSave, me } = useStore();
  const act = useAction();
  const saved = isSaved(item.item_id);
  const spot = MEETUP_SPOTS.find((s) => s.spot_id === item.meetup_spot_id)?.name;

  return (
    <article className="group relative">
      <Link href={`/item/${item.item_id}`} className="block rounded-tile">
        <div className="relative aspect-square overflow-hidden rounded-tile bg-field">
          <ItemArt
            category={item.category}
            image={item.images[0]}
            alt=""
            className="transition-transform duration-500 ease-out group-hover:scale-[1.04]"
            artClass="size-[46%]"
          />
          <span className="absolute bottom-2.5 left-2.5">
            {showStatus && item.status !== "available" ? (
              <span className="rounded-full bg-fg/80 px-2.5 py-1 text-[11px] leading-none font-semibold text-bg">{ITEM_STATUS_LABEL[item.status]}</span>
            ) : (
              <OfferBadges item={item} />
            )}
          </span>
        </div>
        <h3 className="mt-3 line-clamp-1 font-sans text-body font-medium transition-colors group-hover:text-accent-ink">{item.title}</h3>
        <Price item={item} className="mt-0.5 line-clamp-1" />
        <p className="mt-1 flex items-center gap-1 text-micro text-muted">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{spot}</span>
        </p>
      </Link>
      {item.owner_id !== me && (
        <button
          type="button"
          onClick={() => act(() => toggleSave(item.item_id))}
          aria-pressed={saved}
          aria-label={saved ? `Remove ${item.title} from saved` : `Save ${item.title}`}
          className="absolute top-1.5 right-1.5 grid size-11 cursor-pointer place-items-center"
        >
          <span className="grid size-9 place-items-center rounded-full bg-surface/95 shadow-raise backdrop-blur-sm transition-transform hover:scale-110 active:scale-95">
            <Heart className={`size-[17px] ${saved ? "fill-accent-ink text-accent-ink" : "text-fg"}`} strokeWidth={1.9} aria-hidden />
          </span>
        </button>
      )}
    </article>
  );
}

// The same shape while listings load
export function ItemCardSkeleton() {
  return (
    <div aria-hidden>
      <div className="skeleton aspect-square rounded-tile" />
      <div className="skeleton mt-3 h-4 w-4/5 rounded-full" />
      <div className="skeleton mt-2 h-4 w-1/3 rounded-full" />
    </div>
  );
}
