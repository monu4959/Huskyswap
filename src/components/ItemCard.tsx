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

export function ItemCard({ item, showStatus = false }: { item: Item; showStatus?: boolean }) {
  const { isSaved, toggleSave, me } = useStore();
  const act = useAction();
  const saved = isSaved(item.item_id);
  const spot = MEETUP_SPOTS.find((s) => s.spot_id === item.meetup_spot_id)?.name;

  return (
    <article className="relative rounded-[20px] bg-surface p-[9px] pb-3 shadow-raise">
      <Link href={`/item/${item.item_id}`} className="block rounded-[14px]">
        <div className="relative h-[104px] overflow-hidden rounded-[14px]">
          <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-16" />
          {showStatus && item.status !== "available" && (
            <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
              {ITEM_STATUS_LABEL[item.status]}
            </span>
          )}
        </div>
        <h3 className="mx-[3px] mt-[9px] mb-[3px] line-clamp-2 min-h-[2.6em] font-sans text-[13px] leading-[1.3] font-semibold tracking-normal">{item.title}</h3>
        <Price item={item} className="mx-[3px] line-clamp-1" />
        <p className="mx-0.5 mt-1 flex items-center gap-[3px] text-[11.5px] text-muted">
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
          className="absolute top-2 right-2 grid size-11 cursor-pointer place-items-center"
        >
          <span className="grid size-[26px] place-items-center rounded-[9px] bg-surface">
            <Heart className={`size-4 ${saved ? "fill-[#FF7A7A] text-[#FF7A7A]" : "text-muted"}`} aria-hidden />
          </span>
        </button>
      )}
    </article>
  );
}
