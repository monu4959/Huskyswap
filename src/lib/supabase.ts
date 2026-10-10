import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local");

// Browser client: the session lives in localStorage and every query runs as the
// signed-in student, so row-level security decides what they can see and do.
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const PHOTO_BUCKET = "item-images";

// Seeded stand-in photos ship with the app (public/items); uploads live in Storage.
export function photoUrl(path: string) {
  if (path.startsWith("items/")) return `/${path}`;
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}
