"use client";

import { useEffect, useState } from "react";
import { loadPhotos, type PhotoCredit } from "@/lib/reference";

export function licenseLabel(p: Pick<PhotoCredit, "license" | "license_version">) {
  if (p.license === "cc0") return "CC0";
  if (p.license === "pdm" || /public|^pd/.test(p.license)) return "Public Domain";
  return `CC ${p.license.toUpperCase()}${p.license_version ? ` ${p.license_version}` : ""}`;
}

let cache: Promise<Map<string, PhotoCredit>> | null = null;
const creditsBySrc = () =>
  (cache ??= loadPhotos().then((sets) => new Map(Object.values(sets).flat().map((p) => [p.src, p]))));

// Attribution for a stand-in photo (required by CC BY / BY-SA). Uploaded photos have none.
export function PhotoCreditLine({ src, className = "" }: { src: string | undefined; className?: string }) {
  const [credit, setCredit] = useState<PhotoCredit | null>(null);
  useEffect(() => {
    let live = true;
    if (src?.startsWith("/items/")) creditsBySrc().then((m) => live && setCredit(m.get(src) ?? null));
    return () => {
      live = false;
    };
  }, [src]);
  if (!credit || credit.src !== src) return null;
  return (
    <p className={`text-[11px] text-muted ${className}`}>
      Photo{credit.modified ? " (cropped and color-adjusted)" : ""}:{" "}
      {credit.landing ? (
        <a href={credit.landing} target="_blank" rel="noreferrer" className="underline decoration-muted/50 underline-offset-2">
          {credit.creator}
        </a>
      ) : (
        credit.creator
      )}
      ,{" "}
      {credit.license_url ? (
        <a href={credit.license_url} target="_blank" rel="noreferrer" className="underline decoration-muted/50 underline-offset-2">
          {licenseLabel(credit)}
        </a>
      ) : (
        licenseLabel(credit)
      )}
      , via {credit.source === "wikimedia" ? "Wikimedia Commons" : "Openverse"}. Stand-in photo, not the seller&apos;s item.
    </p>
  );
}
