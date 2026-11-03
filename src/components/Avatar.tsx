import { Star } from "lucide-react";

export function initials(name: string) {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="font-display grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-ink"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

export function Rating({ average, count }: { average: number | null; count: number }) {
  if (average === null) return <span className="text-micro text-muted">New seller, no reviews yet</span>;
  return (
    <span className="inline-flex items-center gap-1 text-micro text-muted">
      <Star className="size-[13px] fill-gold text-gold" aria-hidden />
      {average.toFixed(1)} from {count} review{count === 1 ? "" : "s"}
    </span>
  );
}
