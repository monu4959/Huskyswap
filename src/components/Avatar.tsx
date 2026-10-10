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
      className="font-display bg-grad grid shrink-0 place-items-center font-bold"
      style={{ width: size, height: size, borderRadius: size * 0.33, fontSize: size * 0.33 }}
    >
      {initials(name)}
    </span>
  );
}

export function Rating({ average, count }: { average: number | null; count: number }) {
  if (average === null) return <span className="text-[12px] text-muted">New seller, no reviews yet</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-muted">
      <Star className="size-[13px] fill-[#F7B955] text-[#F7B955]" aria-hidden />
      {average.toFixed(1)} from {count} review{count === 1 ? "" : "s"}
    </span>
  );
}
