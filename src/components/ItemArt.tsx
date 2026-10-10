import type { ReactNode } from "react";
import type { ItemCategory } from "@/lib/types";

// Gradient line illustrations from app-design.html (plus a few in the same style).
// Shown until a listing has real photos.
const ART: Record<ItemCategory, { box: string; art: ReactNode }> = {
  textbooks: {
    box: "0 0 120 120",
    art: (
      <>
        <rect className="body" x="24" y="76" width="74" height="17" rx="3" />
        <rect className="soft" x="30" y="57" width="66" height="17" rx="3" />
        <rect className="body" x="20" y="38" width="70" height="17" rx="3" />
        <path className="detail" d="M30 85h56M38 66h48M28 47h52" />
      </>
    ),
  },
  electronics: {
    box: "0 0 120 120",
    art: (
      <>
        <rect className="body" x="36" y="16" width="48" height="88" rx="9" />
        <rect className="inner" x="44" y="26" width="32" height="18" rx="3" />
        <g className="dot">
          {[56, 67, 78, 89].flatMap((y) =>
            [50, 60, 70].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="3.2" />),
          )}
        </g>
      </>
    ),
  },
  furniture: {
    box: "0 0 120 120",
    art: (
      <>
        <rect className="body" x="34" y="96" width="52" height="10" rx="5" />
        <path className="stroke" d="M58 96 L46 62 L68 36" />
        <path className="body" d="M60 26 L94 38 L84 58 L54 44 Z" />
        <circle className="soft" cx="88" cy="66" r="6" />
      </>
    ),
  },
  kitchen: {
    box: "0 0 120 120",
    art: (
      <>
        <path className="body" d="M26 52h68v30a18 18 0 0 1-18 18H44a18 18 0 0 1-18-18z" />
        <rect className="soft" x="22" y="42" width="76" height="9" rx="4.5" />
        <path className="stroke" d="M52 34h16M26 62H14M94 62h12" />
        <path className="detail" d="M40 70h40" />
      </>
    ),
  },
  clothing: {
    box: "0 0 120 120",
    art: (
      <>
        <path className="body" d="M44 20l-26 14 10 22 10-5v49h44V51l10 5 10-22-26-14a16 16 0 0 1-32 0z" />
        <path className="detail" d="M60 46v52M48 64h24" />
      </>
    ),
  },
  dorm_essentials: {
    box: "0 0 120 120",
    art: (
      <>
        <rect className="body" x="36" y="14" width="48" height="92" rx="9" />
        <path className="detail" d="M36 44h48M76 24v12M76 54v24" />
      </>
    ),
  },
  sports_outdoors: {
    box: "0 0 120 120",
    art: (
      <>
        <path className="body" d="M60 20 L102 96 H18 Z" />
        <path className="soft" d="M60 54 L80 96 H40 Z" />
        <path className="detail" d="M60 20v76" />
        <path className="stroke" d="M10 100h100" />
      </>
    ),
  },
  bikes_transport: {
    box: "0 0 150 120",
    art: (
      <>
        <circle className="stroke" cx="40" cy="80" r="24" />
        <circle className="stroke" cx="110" cy="80" r="24" />
        <path className="stroke" d="M40 80 L62 48 L98 48 L110 80 M62 48 L74 80 L40 80 M74 80 L98 48 M56 38 h14 M98 48 L93 32 h11" />
      </>
    ),
  },
  other: {
    box: "0 0 120 120",
    art: (
      <>
        <path className="body" d="M20 44 L60 28 L100 44 V86 L60 102 L20 86 Z" />
        <path className="soft" d="M20 44 L60 60 L100 44 L60 28 Z" />
        <path className="detail" d="M60 60v40M40 36l40 16" />
      </>
    ),
  },
};

export function Illustration({
  category,
  onGrad = false,
  className = "",
}: {
  category: ItemCategory;
  onGrad?: boolean;
  className?: string;
}) {
  const { box, art } = ART[category];
  return (
    <svg viewBox={box} aria-hidden className={`ill ${onGrad ? "on-grad" : ""} ${className}`}>
      {art}
    </svg>
  );
}

// Photo if there is one, otherwise the category illustration on a sunken tile.
export function ItemArt({
  category,
  image,
  alt,
  className = "",
  artClass = "w-3/5 h-3/5",
}: {
  category: ItemCategory;
  image?: string;
  alt: string;
  className?: string;
  artClass?: string;
}) {
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element -- local data URLs in the demo
    return <img src={image} alt={alt} className={`h-full w-full object-cover ${className}`} />;
  }
  return (
    <div role="img" aria-label={alt} className={`flex h-full w-full items-center justify-center bg-field ${className}`}>
      <Illustration category={category} className={artClass} />
    </div>
  );
}
