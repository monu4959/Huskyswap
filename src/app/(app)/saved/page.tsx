"use client";

import { Heart } from "lucide-react";
import { ItemCard } from "@/components/ItemCard";
import { EmptyState } from "@/components/ui";
import { useStore } from "@/lib/store";

export default function SavedPage() {
  const store = useStore();
  const items = store.db.saved
    .filter((s) => s.user_id === store.me)
    .map((s) => store.item(s.item_id))
    .filter((i) => i && i.status !== "removed");

  return (
    <main className="px-5 pt-[max(env(safe-area-inset-top),16px)] pb-32">
      <h1 className="mt-1.5 mb-3.5 text-[24px] font-bold">Saved</h1>
      {items.length ? (
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <ItemCard key={item!.item_id} item={item!} showStatus />
          ))}
        </div>
      ) : (
        <EmptyState icon={<Heart className="size-7" strokeWidth={1.6} />} title="Nothing saved yet">
          Tap the heart on a listing to keep it here.
        </EmptyState>
      )}
    </main>
  );
}
