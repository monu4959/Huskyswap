import { formatPrice } from "@/lib/constants";
import type { Item } from "@/lib/types";

// "$35", "$8 a week", or "$35 · or $8 a week" style, per the design's price line
export function Price({ item, className = "" }: { item: Pick<Item, "sale" | "rental">; className?: string }) {
  const { sale, rental } = item;
  return (
    <p className={`text-lead leading-snug font-bold tracking-[-0.01em] ${className}`}>
      {sale ? formatPrice(sale.price) : formatPrice(rental!.price_per_week)}
      {!sale && <small className="text-micro font-medium tracking-normal text-muted"> a week</small>}
      {sale && rental && (
        <small className="text-micro font-medium tracking-normal text-muted">
          {" "}
          or {formatPrice(rental.price_per_week)} a week
        </small>
      )}
    </p>
  );
}

export function priceText(item: Pick<Item, "sale" | "rental">) {
  const parts = [];
  if (item.sale) parts.push(formatPrice(item.sale.price));
  if (item.rental) parts.push(`${formatPrice(item.rental.price_per_week)} a week`);
  return parts.join(" or ");
}
