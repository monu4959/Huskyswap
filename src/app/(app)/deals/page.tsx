"use client";

import Link from "next/link";
import { useState } from "react";
import { ReceiptText } from "lucide-react";
import { DealRow } from "@/components/DealRow";
import { EmptyState, PageTitle, Seg, narrowClass } from "@/components/ui";
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
      {n > 0 && <span className="ml-1.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] font-bold text-on-accent">{n}</span>}
    </>
  );

  return (
    <main className={`${narrowClass} pb-36 md:pb-24`}>
      <PageTitle title="Deals" sub="Requests to buy and rent, from first message to handover" />
      <div className="mb-5">
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
              <Link href="/" className="font-semibold text-accent-ink">
                Browse listings
              </Link>
            </>
          ) : (
            <>
              <Link href="/sell" className="font-semibold text-accent-ink">
                Post a listing
              </Link>{" "}
              and requests show up here.
            </>
          )}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
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
