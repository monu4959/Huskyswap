// Small reference data the app ships with.
import type { MeetupSpot } from "./types";

// Mirrors public.meetup_spots (same ids as the insert in supabase/schema.sql)
export const MEETUP_SPOTS: MeetupSpot[] = [
  { spot_id: 1, name: "Snell Library" },
  { spot_id: 2, name: "Curry Student Center" },
  { spot_id: 3, name: "Marino Recreation Center" },
  { spot_id: 4, name: "International Village" },
  { spot_id: 5, name: "West Village" },
  { spot_id: 6, name: "Mission Hill (off campus)" },
  { spot_id: 7, name: "Fenway (off campus)" },
];

// Credits for the stand-in listing photos (scripts/fetch-images.mjs, fetch-commons.mjs, make-variants.mjs)
export interface PhotoCredit {
  src: string;
  title: string;
  creator: string;
  creator_url: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  landing: string | null;
  source: string;
  modified?: boolean; // edited variant
  variant_of?: string;
}
export type PhotoSets = Record<string, PhotoCredit[]>;

// Loaded on demand; only hand-reviewed photos
export async function loadPhotos(): Promise<PhotoSets> {
  const all = (await import("@/data/photos.json")).default as unknown as Record<string, (PhotoCredit & { reviewed?: boolean })[]>;
  return Object.fromEntries(Object.entries(all).map(([k, list]) => [k, list.filter((p) => p.reviewed)]));
}
