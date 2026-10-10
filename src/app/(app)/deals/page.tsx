"use client";

import Link from "next/link";
import { useState } from "react";
import { ReceiptText } from "lucide-react";
import { DealRow } from "@/components/DealRow";
import { EmptyState, Seg } from "@/components/ui";
import { useStore } from "@/lib/store";

type Side = "buying" | "selling";
const FINISHED = ["completed", "declined", "cancelled"];

export default function DealsPage() {
  const store = useStore();
  const { myDeals, needsMe } = store;
  const sellingCount = myDeals.filter((t) => store.item(t.item_id)?.owner_id === store.me && needsMe(t)).length;
  const buyingCount = myDeals.filter((t) => t.buyer_id === store.me && needsMe(t)).length;
  // Open the side that's waiting on you
  const [side, setSide] = useState<Side>(sellingCount > buyingCount ? "selling" : "buying");

  const deals = myDeals
    .filter((t) => (side === "buying" ? t.buyer_id === store.me : store.item(t.item_id)?.owner_id === store.me))
    .sort((a, b) => {
      // waiting on you, then in progress, then finished; newest first within each
      const rank = (t: typeof a) => (needsMe(t) ? 0 : FINISHED.includes(t.status) ? 2 : 1);
      return rank(a) - rank(b) || b.created_at.localeCompare(a.created_at);
    });

  const label = (text: string, n: number) => (
    <>
      {text}
      {n > 0 && <span className="ml-1.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-[#FF7A7A] px-1 text-[10px] font-bold text-white">{n}</span>}
    </>
  );

  return (
    <main className="px-5 pt-[max(env(safe-area-inset-top),16px)] pb-32">
      <h1 className="mt-1.5 mb-3.5 text-[24px] font-bold">Deals</h1>
      <div className="mb-4">
        <Seg<Side>
          label="Deals"
          value={side}
          onChange={setSide}
          options={[
            { value: "buying", label: label("Buying", buyingCount) },
            { value: "selling", label: label("Selling", sellingCount) },
          ]}
        />
      </div>
      {deals.length === 0 ? (
        <EmptyState icon={<ReceiptText className="size-7" strokeWidth={1.6} />} title={side === "buying" ? "Nothing requested yet" : "No requests on your listings yet"}>
          {side === "buying" ? (
            <>
              Find something and tap Request.{" "}
              <Link href="/" className="font-semibold text-cyan">
                Browse listings
              </Link>
            </>
          ) : (
            <>
              <Link href="/sell" className="font-semibold text-cyan">
                Post a listing
              </Link>{" "}
              and requests show up here.
            </>
          )}
        </EmptyState>
      ) : (
        <ul className="space-y-[11px]">
          {deals.map((t) => (
            <li key={t.transaction_id}>
              <DealRow deal={t} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
