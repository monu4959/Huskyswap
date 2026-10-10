import { formatPrice } from "@/lib/constants";
import type { Item } from "@/lib/types";

// "$35", "$8 a week", or "$35 · or $8 a week" style, per the design's price line
export function Price({ item, className = "" }: { item: Pick<Item, "sale" | "rental">; className?: string }) {
  const { sale, rental } = item;
  return (
    <p className={`font-display text-[15px] font-semibold ${className}`}>
      {sale ? formatPrice(sale.price) : formatPrice(rental!.price_per_week)}
      {!sale && <small className="font-sans text-[11.5px] font-medium text-muted"> a week</small>}
      {sale && rental && (
        <small className="font-sans text-[11.5px] font-medium text-muted">
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
