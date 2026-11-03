"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BadgeCheck, ChevronRight, MessageSquare, Pencil, Plus, ReceiptText } from "lucide-react";
import { Avatar, Rating } from "@/components/Avatar";
import { ItemCard } from "@/components/ItemCard";
import { Button, Card, CountBadge, Seg, TopBar, buttonClass, inputClass, pageClass, roundClass, useAction } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";

type Theme = "dark" | "light" | "system";
const THEME_KEY = "huskyswap-theme";

function useTheme() {
  // Only rendered in the browser (behind AuthGate), so the DOM is available here
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || "system");
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
    <div className={pageClass}>
      <TopBar back="/" title="Profile" />
      <main className="space-y-8 pt-2 pb-36 md:pb-24">
        <section className="flex items-center gap-4 rounded-sheet bg-surface p-5 shadow-raise md:gap-6 md:p-8">
          <Avatar name={me.name} size={72} />
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
                <span className="font-display truncate text-title md:text-[2.25rem]">{me.name}</span>
                <button type="button" onClick={() => setEditing(true)} aria-label="Edit name" className={`${roundClass} !size-9 !rounded-xl`}>
                  <Pencil className="size-4" />
                </button>
              </p>
            )}
            <p className="mt-0.5 flex items-center gap-1 text-small text-green">
              <BadgeCheck className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{me.email}</span>
            </p>
            <Rating {...store.ratingFor(me.id)} />
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          {[
            { href: "/inbox", icon: MessageSquare, label: "Chats", sub: "Messages with buyers and sellers", count: store.unreadCount, countLabel: "unread" },
            { href: "/deals", icon: ReceiptText, label: "Deals", sub: "Requests, handovers and returns", count: store.actionCount, countLabel: "need attention" },
          ].map(({ href, icon: Icon, label, sub, count, countLabel }) => (
            <Link key={href} href={href} className="flex items-center gap-3.5 rounded-card bg-surface p-4 shadow-raise transition-shadow hover:shadow-lift">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <b className="flex items-center gap-2 text-body font-semibold">
                  {label}
                  <CountBadge count={count} label={countLabel} />
                </b>
                <span className="block truncate text-small text-muted">{sub}</span>
              </span>
              <ChevronRight className="size-5 text-muted" aria-hidden />
            </Link>
          ))}
        </section>

        <section className="max-w-md">
          <span className="mb-2 block text-small font-semibold">App theme</span>
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
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-heading md:text-title">Your listings</h2>
            <Link href="/sell" className={buttonClass("soft", "!h-10 px-4 text-small")}>
              <Plus className="size-4" aria-hidden />
              New
            </Link>
          </div>
          {listings.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {listings.map((item) => (
                <ItemCard key={item.item_id} item={item} showStatus />
              ))}
            </div>
          ) : (
            <p className="text-body text-muted">You haven&apos;t listed anything yet.</p>
          )}
        </section>

        <section>
          <h2 className="mb-4 text-heading md:text-title">What people say</h2>
          {reviews.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {reviews.map((r) => (
                <li key={r.review_id}>
                  <Card className="h-full p-4">
                    <p className="text-small">
                      <span className="font-semibold">{store.profile(r.reviewer_id)?.name}</span>{" "}
                      <span className="text-muted">
                        gave {r.rating} of 5, {timeAgo(r.created_at)}
                      </span>
                    </p>
                    {r.comment && <p className="mt-1 text-small text-muted">{r.comment}</p>}
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-muted">Reviews appear after your first completed deal.</p>
          )}
        </section>

        <section className="flex flex-col gap-2.5 pt-2 sm:flex-row-reverse sm:justify-end">
          <Link href="/credits" className={buttonClass("ghost", "text-small !text-muted")}>
            Photo credits
          </Link>
          <Button
            variant="soft"
            className="sm:px-10"
            onClick={async () => {
              await store.signOut();
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        </section>
      </main>
    </div>
  );
}
