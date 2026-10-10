"use client";

import { useEffect, useState } from "react";
import { licenseLabel } from "@/components/PhotoCredit";
import { Card, TopBar } from "@/components/ui";
import { loadPhotos, type PhotoSets } from "@/lib/reference";

// Every stand-in photo with its author and license
export default function CreditsPage() {
  const [sets, setSets] = useState<PhotoSets | null>(null);
  useEffect(() => {
    loadPhotos().then(setSets);
  }, []);
  const photos = sets ? Object.values(sets).flat() : [];

  return (
    <>
      <TopBar back="/profile" title="Photo credits" />
      <main className="px-5 pt-1 pb-32">
        <p className="mb-4 text-[13.5px] text-muted">
          Demo listings use openly licensed photos found through Openverse, a search engine for Creative Commons and public domain
          media. They show the kind of item, not the actual item for sale. {photos.length ? `${photos.length} photos.` : ""}
        </p>
        <ul className="space-y-2.5">
          {photos.map((p) => (
            <li key={p.src}>
              <Card className="flex items-center gap-3 p-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element -- small local thumbnails */}
                <img src={p.src} alt="" loading="lazy" className="size-14 shrink-0 rounded-xl object-cover" />
                <div className="min-w-0 text-[12.5px]">
                  <p className="truncate font-semibold text-fg">{p.title}</p>
                  <p className="truncate text-muted">
                    {p.landing ? (
                      <a href={p.landing} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {p.creator}
                      </a>
                    ) : (
                      p.creator
                    )}{" "}
                    on {p.source},{" "}
                    {p.license_url ? (
                      <a href={p.license_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {licenseLabel(p)}
                      </a>
                    ) : (
                      licenseLabel(p)
                    )}
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
