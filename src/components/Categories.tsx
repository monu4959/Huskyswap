"use client";

import { useRouter } from "next/navigation";
import { useRef, type ReactNode } from "react";
import {
  Bike,
  BedDouble,
  BookOpen,
  CookingPot,
  Dumbbell,
  LayoutGrid,
  Laptop,
  Package,
  Shirt,
  Sofa,
  X,
  type LucideIcon,
} from "lucide-react";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/constants";
import type { ItemCategory } from "@/lib/types";

export const CATEGORY_ICON: Record<ItemCategory, LucideIcon> = {
  textbooks: BookOpen,
  electronics: Laptop,
  furniture: Sofa,
  kitchen: CookingPot,
  clothing: Shirt,
  dorm_essentials: BedDouble,
  sports_outdoors: Dumbbell,
  bikes_transport: Bike,
  other: Package,
};

// Home filtered to one category (the category lives in the URL so the nav can link to it)
export const categoryHref = (c: ItemCategory | null) => (c ? `/?category=${c}` : "/");

// A round icon with its label underneath
export function CategoryCircle({
  category,
  active = false,
  onClick,
}: {
  category: ItemCategory | null;
  active?: boolean;
  onClick: () => void;
}) {
  const Icon = category ? CATEGORY_ICON[category] : LayoutGrid;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="group flex w-[76px] shrink-0 cursor-pointer flex-col items-center gap-2 text-center md:w-[88px]"
    >
      <span
        className={`grid size-16 place-items-center rounded-full transition-[background-color,color,box-shadow,scale] duration-200 group-hover:scale-105 md:size-[72px] ${
          active ? "bg-accent text-on-accent shadow-lift" : "bg-surface text-fg shadow-raise group-hover:text-accent-ink"
        }`}
      >
        <Icon className="size-6 md:size-7" strokeWidth={1.6} aria-hidden />
      </span>
      <span className={`text-micro leading-tight font-semibold ${active ? "text-accent-ink" : "text-fg"}`}>
        {category ? CATEGORY_LABEL[category] : "All"}
      </span>
    </button>
  );
}

// A trigger that opens the "browse by category" sheet (bottom sheet on phones, centered on desktop)
export function CategorySheetButton({ className, label, children }: { className: string; label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const go = (c: ItemCategory | null) => {
    ref.current?.close();
    router.push(categoryHref(c));
  };

  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()} className={className} aria-label={label} aria-haspopup="dialog">
        {children}
      </button>
      <dialog
        ref={ref}
        aria-labelledby="categories-title"
        className="animate-sheet-in mx-auto mt-auto mb-0 w-full max-w-none rounded-t-sheet bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px] md:m-auto md:w-[min(92vw,560px)] md:rounded-sheet"
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.close(); // tap on the backdrop
        }}
      >
        <div className="p-5 pb-[max(env(safe-area-inset-bottom),24px)] md:p-7">
          <div className="mb-5 flex items-center justify-between">
            <h2 id="categories-title" className="text-heading">
              Browse by category
            </h2>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              aria-label="Close categories"
              className="grid size-11 cursor-pointer place-items-center rounded-full hover:bg-field"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="grid grid-cols-4 justify-items-center gap-y-5 sm:grid-cols-5">
            <CategoryCircle category={null} onClick={() => go(null)} />
            {CATEGORIES.map((c) => (
              <CategoryCircle key={c} category={c} onClick={() => go(c)} />
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
