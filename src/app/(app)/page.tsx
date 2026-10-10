"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ItemCard } from "@/components/ItemCard";
import { Button, EmptyState, Seg } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/constants";
import { useStore } from "@/lib/store";
import type { Item, ItemCategory } from "@/lib/types";

type Mode = "all" | "buy" | "rent";
type Sort = "new" | "low" | "high";
const PAGE = 24;

const lowestPrice = (i: Item) => Math.min(i.sale?.price ?? Infinity, i.rental?.price_per_week ?? Infinity);

export default function HomePage() {
  const store = useStore();
  const { db, me } = store;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [category, setCategory] = useState<ItemCategory | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // Same rows as nlq.listings: available items from active accounts
  const listings = useMemo(() => {
    const active = new Set(db.profiles.filter((p) => p.account_status === "active").map((p) => p.id));
    return db.items.filter((i) => i.status === "available" && i.owner_id !== me && active.has(i.owner_id));
  }, [db, me]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = listings
      .filter((i) => (mode === "buy" ? i.sale : mode === "rent" ? i.rental : true))
      .filter((i) => !category || i.category === category)
      .filter((i) => {
        if (!words.length) return true;
        const text = `${i.title} ${i.description} ${CATEGORY_LABEL[i.category]}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
    return rows.sort((a, b) =>
      sort === "new"
        ? b.created_at.localeCompare(a.created_at)
        : sort === "low"
          ? lowestPrice(a) - lowestPrice(b)
          : lowestPrice(b) - lowestPrice(a),
    );
  }, [listings, query, mode, category, sort]);

  const filtering = !!query || mode !== "all" || !!category || sort !== "new";
  const myName = store.profile(me!)?.name ?? "";
  const reset = () => setLimit(PAGE);

  return (
    <main className="px-5 pt-[max(env(safe-area-inset-top),16px)] pb-32">
      <header className="mt-1 mb-3.5 flex items-center justify-between">
        <div>
          <p className="text-[13px] text-muted">Hi {myName.split(" ")[0]}</p>
          <h1 className="mt-0.5 max-w-[240px] text-[21px] leading-tight font-bold">What do you need this week?</h1>
        </div>
        <Link href="/profile" aria-label="Your profile" className="rounded-[13px]">
          <Avatar name={myName} />
        </Link>
      </header>

      <div className="mb-3 flex h-[46px] items-center gap-2 rounded-[14px] bg-field pr-2 pl-3.5 shadow-inset focus-within:ring-[1.5px] focus-within:ring-cyan">
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search listings</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              reset();
            }}
            placeholder={'Try "lamp" or "calculus"'}
            className="w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="grid size-8 cursor-pointer place-items-center text-muted">
            <X className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          aria-label="Filters"
          className="bg-grad grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-[10px]"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </button>
      </div>

      {showFilters && (
        <div className="mb-3 space-y-2.5 rounded-[20px] bg-surface p-3 shadow-raise">
          <Seg<Mode>
            label="Show"
            value={mode}
            onChange={(v) => {
              setMode(v);
              reset();
            }}
            options={[
              { value: "all", label: "Everything" },
              { value: "buy", label: "To buy" },
              { value: "rent", label: "Rent a week" },
            ]}
          />
          <Seg<Sort>
            label="Sort"
            value={sort}
            onChange={(v) => {
              setSort(v);
              reset();
            }}
            options={[
              { value: "new", label: "Newest" },
              { value: "low", label: "Price: low" },
              { value: "high", label: "Price: high" },
            ]}
          />
        </div>
      )}

      <div className="scrollbar-none -mx-5 mb-3 flex gap-[9px] overflow-x-auto px-5 pt-1 pb-2.5">
        {[null, ...CATEGORIES].map((c) => (
          <button
            key={c ?? "all"}
            type="button"
            aria-pressed={category === c}
            onClick={() => {
              setCategory(c);
              reset();
            }}
            className={`min-h-9 shrink-0 cursor-pointer rounded-xl px-3.5 text-[13px] font-medium whitespace-nowrap ${
              category === c ? "bg-grad" : "bg-surface shadow-raise"
            }`}
          >
            {c ? CATEGORY_LABEL[c] : "All"}
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[16px] font-semibold">{filtering ? "Results" : "New near you"}</h2>
        <span className="text-[12.5px] text-muted" aria-live="polite">
          {results.length.toLocaleString()} listing{results.length === 1 ? "" : "s"}
        </span>
      </div>

      {results.length ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            {results.slice(0, limit).map((item) => (
              <ItemCard key={item.item_id} item={item} />
            ))}
          </div>
          {limit < results.length && (
            <Button variant="soft" className="mt-5 w-full" onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </Button>
          )}
        </>
      ) : (
        <EmptyState icon={<SearchX className="size-7" strokeWidth={1.6} />} title="Nothing matches yet">
          Try fewer words or another category. New listings show up here as soon as they&apos;re posted.
        </EmptyState>
      )}
    </main>
  );
}
