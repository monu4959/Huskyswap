"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { ArrowRight, Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import { CategoryCircle, categoryHref } from "@/components/Categories";
import { ItemArt } from "@/components/ItemArt";
import { ItemCard } from "@/components/ItemCard";
import { Button, EmptyState, Seg, buttonClass, pageClass } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/constants";
import { useStore } from "@/lib/store";
import type { Item, ItemCategory } from "@/lib/types";

type Mode = "all" | "buy" | "rent";
type Sort = "new" | "low" | "high";
const PAGE = 24;

const lowestPrice = (i: Item) => Math.min(i.sale?.price ?? Infinity, i.rental?.price_per_week ?? Infinity);

// The category filter lives in the URL (?category=), so the nav's category sheet can link here
export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <Home />
    </Suspense>
  );
}

function Home() {
  const store = useStore();
  const { db, me } = store;
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const fromUrl = params.get("category");
  const category = CATEGORIES.includes(fromUrl as ItemCategory) ? (fromUrl as ItemCategory) : null;

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

  // The four biggest categories, each shown with a photo from one of its listings
  const topCategories = useMemo(() => {
    const byCategory = new Map<ItemCategory, Item[]>();
    for (const i of listings) byCategory.set(i.category, [...(byCategory.get(i.category) ?? []), i]);
    return [...byCategory.entries()]
      .filter(([c]) => c !== "other")
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4)
      .map(([c, items]) => ({ category: c, count: items.length, cover: items.find((i) => i.images.length) ?? items[0] }));
  }, [listings]);

  // Three recent photos for the hero, from different categories
  const heroItems = useMemo(() => {
    const seen = new Set<ItemCategory>();
    return [...listings]
      .filter((i) => i.images.length)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .filter((i) => !seen.has(i.category) && seen.add(i.category))
      .slice(0, 3);
  }, [listings]);

  const filtering = !!query || mode !== "all" || !!category || sort !== "new";
  const myName = store.profile(me!)?.name ?? "";
  const reset = () => setLimit(PAGE);
  const setCategory = (c: ItemCategory | null) => {
    router.replace(categoryHref(c), { scroll: false });
    reset();
  };
  const clearAll = () => {
    setQuery("");
    setMode("all");
    setSort("new");
    setCategory(null);
  };

  return (
    <main className={`${pageClass} pt-3 pb-36 md:pt-8 md:pb-24`}>
      {/* search */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-12 flex-1 items-center gap-2.5 rounded-full bg-field pr-1.5 pl-4.5 transition-[background-color,box-shadow] focus-within:bg-surface focus-within:shadow-raise focus-within:ring-2 focus-within:ring-accent-ink hover:bg-field-strong focus-within:hover:bg-surface md:h-14">
          <Search className="size-[18px] shrink-0 text-muted" aria-hidden />
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search listings</span>
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                reset();
              }}
              placeholder={'Search "lamp", "calculus", "mini fridge"'}
              className="w-full bg-transparent text-body text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="grid size-11 cursor-pointer place-items-center rounded-full text-muted hover:bg-field hover:text-fg">
              <X className="size-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          aria-label="Filters"
          className={`grid size-12 shrink-0 cursor-pointer place-items-center rounded-full transition-colors md:size-14 ${
            showFilters || mode !== "all" || sort !== "new" ? "bg-fg text-bg" : "bg-surface text-fg shadow-raise hover:bg-field"
          }`}
        >
          <SlidersHorizontal className="size-[18px]" aria-hidden />
        </button>
      </div>

      {showFilters && (
        <div className="animate-pop-in mt-3 grid gap-3 rounded-card bg-surface p-3 shadow-raise sm:grid-cols-2">
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

      {/* hero */}
      {!filtering && (
        <section className="mt-6 grid overflow-hidden rounded-sheet bg-surface shadow-raise md:mt-8 md:grid-cols-[1.15fr_1fr]">
          <div className="flex flex-col justify-center px-6 py-8 sm:px-8 md:px-12 md:py-14">
            <p className="text-micro font-semibold tracking-[0.08em] text-accent-ink uppercase">Hi {myName.split(" ")[0]} · Huskies only</p>
            <h1 className="mt-3 max-w-[13ch] text-[2.25rem] leading-[1.04] sm:text-display md:text-[3.25rem]">What do you need this week?</h1>
            <p className="mt-4 max-w-[42ch] text-body text-muted md:text-lead">
              Buy, sell and rent with other Northeastern students. Meet at a campus spot and pay in person.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link href="/sell" className={buttonClass("grad", "h-12 px-6")}>
                List an item
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <button
                type="button"
                onClick={() => {
                  setMode("rent");
                  reset();
                }}
                className={buttonClass("ghost", "h-12 px-5 bg-field hover:bg-field-strong")}
              >
                Rent for a week
              </button>
            </div>
          </div>
          {heroItems.length === 3 && (
            <div className="hidden grid-cols-2 grid-rows-2 gap-3 p-3 pl-0 md:grid">
              {heroItems.map((item, i) => (
                <Link
                  key={item.item_id}
                  href={`/item/${item.item_id}`}
                  className={`group relative overflow-hidden rounded-card bg-field ${i === 0 ? "row-span-2" : ""}`}
                  aria-label={item.title}
                >
                  <ItemArt category={item.category} image={item.images[0]} alt="" className="transition-transform duration-700 group-hover:scale-105" />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* categories */}
      <section aria-label="Categories" className="mt-8 md:mt-12">
        <div className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:justify-between md:px-0">
          <CategoryCircle category={null} active={!category} onClick={() => setCategory(null)} />
          {CATEGORIES.map((c) => (
            <CategoryCircle key={c} category={c} active={category === c} onClick={() => setCategory(c)} />
          ))}
        </div>
      </section>

      {/* top categories */}
      {!filtering && topCategories.length === 4 && (
        <section className="mt-10 md:mt-14">
          <h2 className="mb-4 text-heading md:text-title">Top categories</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            {topCategories.map(({ category: c, count, cover }) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-card bg-field text-left shadow-raise md:aspect-[5/4]"
              >
                <ItemArt category={c} image={cover.images[0]} alt="" className="transition-transform duration-700 group-hover:scale-105" />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-4 pt-10 pb-3.5 text-white">
                  <span className="block font-display text-lead font-medium md:text-heading">{CATEGORY_LABEL[c]}</span>
                  <span className="text-micro text-white/90">{count.toLocaleString()} listings</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* listings */}
      <section className="mt-10 md:mt-14">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-heading md:text-title">{filtering ? (category && !query ? CATEGORY_LABEL[category] : "Results") : "Featured listings"}</h2>
            <p className="mt-1 text-small text-muted" aria-live="polite">
              {results.length.toLocaleString()} listing{results.length === 1 ? "" : "s"}
              {filtering ? "" : ", newest first"}
            </p>
          </div>
          {filtering && (
            <button type="button" onClick={clearAll} className="cursor-pointer rounded-full px-3 py-1.5 text-small font-semibold text-accent-ink hover:bg-accent-soft">
              Clear filters
            </button>
          )}
        </div>

        {results.length ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {results.slice(0, limit).map((item) => (
                <ItemCard key={item.item_id} item={item} />
              ))}
            </div>
            {limit < results.length && (
              <div className="mt-10 flex justify-center">
                <Button variant="soft" className="w-full sm:w-auto sm:px-10" onClick={() => setLimit((l) => l + PAGE)}>
                  Show more
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState icon={<SearchX className="size-7" strokeWidth={1.6} />} title="Nothing matches yet">
            Try fewer words or another category. New listings show up here as soon as they&apos;re posted.
          </EmptyState>
        )}
      </section>
    </main>
  );
}
