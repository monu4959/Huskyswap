"use client";

import Link from "next/link";
import { Heart } from "lucide-react";
import { ItemCard } from "@/components/ItemCard";
import { EmptyState, PageTitle, buttonClass, pageClass } from "@/components/ui";
import { useStore } from "@/lib/store";

export default function SavedPage() {
  const store = useStore();
  const items = store.db.saved
    .filter((s) => s.user_id === store.me)
    .map((s) => store.item(s.item_id))
    .filter((i) => i && i.status !== "removed");

  return (
    <main className={`${pageClass} pb-36 md:pb-24`}>
      <PageTitle title="Saved" sub={items.length ? `${items.length} listing${items.length === 1 ? "" : "s"} you're keeping an eye on` : undefined} />
      {items.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <ItemCard key={item!.item_id} item={item!} showStatus />
          ))}
        </div>
      ) : (
        <EmptyState icon={<Heart className="size-7" strokeWidth={1.6} />} title="Nothing saved yet">
          Tap the heart on a listing to keep it here.
          <span className="mt-5 block">
            <Link href="/" className={buttonClass("grad", "h-11 px-6")}>
              Browse listings
            </Link>
          </span>
        </EmptyState>
      )}
    </main>
  );
}
