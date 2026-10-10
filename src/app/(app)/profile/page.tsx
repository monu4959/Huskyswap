"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BadgeCheck, Pencil, Plus } from "lucide-react";
import { Avatar, Rating } from "@/components/Avatar";
import { ItemCard } from "@/components/ItemCard";
import { Button, Card, Seg, TopBar, buttonClass, inputClass, roundClass, useAction } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";

type Theme = "dark" | "light" | "system";
const THEME_KEY = "huskyswap-theme";

function useTheme() {
  // Only rendered in the browser (behind AuthGate), so the DOM is available here
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || "dark");
  const change = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // storage blocked: the choice lasts for this visit
    }
  };
  return [theme, change] as const;
}

export default function ProfilePage() {
  const store = useStore();
  const router = useRouter();
  const act = useAction();
  const me = store.profile(store.me!)!;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.name);
  const [theme, setTheme] = useTheme();

  const listings = store.db.items
    .filter((i) => i.owner_id === store.me && i.status !== "removed")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const reviews = store.db.reviews.filter((r) => r.reviewee_id === store.me).sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
      <TopBar back="/" title="Profile" />
      <main className="space-y-6 px-5 pt-2 pb-32">
        <section className="flex items-center gap-4">
          <Avatar name={me.name} size={64} />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const saved = await act(async () => {
                    await store.updateName(name);
                    return true;
                  }, "Name updated");
                  if (saved) setEditing(false);
                }}
              >
                <label className="flex-1">
                  <span className="sr-only">Display name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={inputClass} autoFocus />
                </label>
                <Button type="submit" className="!h-[46px]">
                  Save
                </Button>
              </form>
            ) : (
              <p className="flex items-center gap-2">
                <span className="font-display truncate text-[22px] font-bold">{me.name}</span>
                <button type="button" onClick={() => setEditing(true)} aria-label="Edit name" className={`${roundClass} !size-9 !rounded-xl`}>
                  <Pencil className="size-4" />
                </button>
              </p>
            )}
            <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-green">
              <BadgeCheck className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{me.email}</span>
            </p>
            <Rating {...store.ratingFor(me.id)} />
          </div>
        </section>

        <section>
          <span className="mb-[7px] block text-[12.5px] font-semibold text-muted">App theme</span>
          <Seg<Theme>
            label="App theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "Match device" },
            ]}
          />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold">Your listings</h2>
            <Link href="/sell" className={buttonClass("soft", "!h-9 rounded-xl px-3 text-[13px]")}>
              <Plus className="size-4" aria-hidden />
              New
            </Link>
          </div>
          {listings.length ? (
            <div className="grid grid-cols-2 gap-3">
              {listings.map((item) => (
                <ItemCard key={item.item_id} item={item} showStatus />
              ))}
            </div>
          ) : (
            <p className="text-[14px] text-muted">You haven&apos;t listed anything yet.</p>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[16px] font-semibold">What people say</h2>
          {reviews.length ? (
            <ul className="space-y-2.5">
              {reviews.map((r) => (
                <li key={r.review_id}>
                  <Card className="p-3.5">
                    <p className="text-[13px]">
                      <span className="font-semibold">{store.profile(r.reviewer_id)?.name}</span>{" "}
                      <span className="text-muted">
                        gave {r.rating} of 5, {timeAgo(r.created_at)}
                      </span>
                    </p>
                    {r.comment && <p className="mt-1 text-[13px] text-muted">{r.comment}</p>}
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-muted">Reviews appear after your first completed deal.</p>
          )}
        </section>

        <section className="space-y-2.5 pt-2">
          <Link href="/credits" className={buttonClass("ghost", "w-full text-[13px] !text-muted")}>
            Photo credits
          </Link>
          <Button
            variant="soft"
            className="w-full"
            onClick={async () => {
              await store.signOut();
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        </section>
      </main>
    </>
  );
}
