"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, House, LayoutGrid, MessageSquare, Plus, ReceiptText, UserRound } from "lucide-react";
import { Logo } from "@/components/AppShell";
import { Avatar } from "@/components/Avatar";
import { CategorySheetButton } from "@/components/Categories";
import { CountBadge, pageClass } from "@/components/ui";
import { useStore } from "@/lib/store";

// Screens with their own bottom action bar
const HIDDEN = [/^\/item\//, /^\/inbox\/.+/, /^\/sell/, /^\/ask/];
// Top-level screens that get the slim mobile header (Chats and Deals live there on phones)
const WITH_HEADER = ["/", "/saved", "/inbox", "/deals"];

// Phones: Home, Categories, Sell, Saved, Profile along the bottom
export function TabBar() {
  const pathname = usePathname();
  if (HIDDEN.some((r) => r.test(pathname))) return null;

  const tab = (active: boolean) =>
    `relative flex w-16 flex-col items-center gap-1 pt-1 text-[11px] font-semibold transition-colors ${active ? "text-accent-ink" : "text-muted hover:text-fg"}`;
  const icon = (active: boolean) => <span className={`block h-[3px] w-5 rounded-full ${active ? "bg-accent" : "bg-transparent"}`} aria-hidden />;

  return (
    <nav aria-label="Main" className="shadow-bar fixed inset-x-0 bottom-0 z-30 bg-surface/95 pb-safe backdrop-blur-md md:hidden">
      <ul className="mx-auto flex h-[70px] max-w-[560px] items-center justify-around px-2">
        <li>
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined} className={tab(pathname === "/")}>
            <House className="size-[22px]" strokeWidth={pathname === "/" ? 2.2 : 1.7} aria-hidden />
            Home
            {icon(pathname === "/")}
          </Link>
        </li>
        <li>
          <CategorySheetButton className={`${tab(false)} cursor-pointer`}>
            <LayoutGrid className="size-[22px]" strokeWidth={1.7} aria-hidden />
            Categories
            {icon(false)}
          </CategorySheetButton>
        </li>
        <li>
          <Link href="/sell" className="flex w-16 flex-col items-center gap-1 text-[11px] font-semibold text-muted">
            <span className="bg-grad -mt-6 grid size-[54px] place-items-center rounded-full shadow-lift ring-4 ring-surface transition-colors hover:bg-accent-press">
              <Plus className="size-6" strokeWidth={2.2} aria-hidden />
            </span>
            Sell
          </Link>
        </li>
        <li>
          <Link href="/saved" aria-current={pathname.startsWith("/saved") ? "page" : undefined} className={tab(pathname.startsWith("/saved"))}>
            <Heart className="size-[22px]" strokeWidth={pathname.startsWith("/saved") ? 2.2 : 1.7} aria-hidden />
            Saved
            {icon(pathname.startsWith("/saved"))}
          </Link>
        </li>
        <li>
          <Link href="/profile" aria-current={pathname.startsWith("/profile") ? "page" : undefined} className={tab(pathname.startsWith("/profile"))}>
            <UserRound className="size-[22px]" strokeWidth={pathname.startsWith("/profile") ? 2.2 : 1.7} aria-hidden />
            Profile
            {icon(pathname.startsWith("/profile"))}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

const iconLinkClass = "relative grid size-10 place-items-center rounded-full text-fg transition-colors hover:bg-field";

// Phones: logo, then Chats and Deals with their counts, then your avatar
export function MobileHeader() {
  const pathname = usePathname();
  const store = useStore();
  if (!WITH_HEADER.includes(pathname)) return null;
  const name = store.profile(store.me!)?.name ?? "";

  return (
    <header className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),14px)] pb-1 sm:px-6 md:hidden">
      <Link href="/" aria-label="HuskySwap home">
        <Logo className="text-[22px]" />
      </Link>
      <div className="flex items-center gap-1">
        <Link href="/inbox" aria-label="Chats" className={`${iconLinkClass} ${pathname.startsWith("/inbox") ? "text-accent-ink" : ""}`}>
          <MessageSquare className="size-[21px]" strokeWidth={1.8} aria-hidden />
          <CountBadge count={store.unreadCount} label="unread" className="absolute -top-0.5 -right-0.5" />
        </Link>
        <Link href="/deals" aria-label="Deals" className={`${iconLinkClass} ${pathname.startsWith("/deals") ? "text-accent-ink" : ""}`}>
          <ReceiptText className="size-[21px]" strokeWidth={1.8} aria-hidden />
          <CountBadge count={store.actionCount} label="need attention" className="absolute -top-0.5 -right-0.5" />
        </Link>
        <Link href="/profile" aria-label="Your profile" className="ml-1 rounded-full">
          <Avatar name={name} size={36} />
        </Link>
      </div>
    </header>
  );
}

// Desktop and tablet: one clean bar across the top
export function TopNav() {
  const pathname = usePathname();
  const store = useStore();
  const name = store.profile(store.me!)?.name ?? "";

  const link = (active: boolean) =>
    `relative inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-small font-semibold transition-colors ${
      active ? "text-accent-ink" : "text-fg hover:bg-field"
    }`;
  const links = [
    { href: "/", label: "Home", active: pathname === "/" },
    { href: "/saved", label: "Saved", active: pathname.startsWith("/saved") },
    { href: "/inbox", label: "Chats", active: pathname.startsWith("/inbox"), count: store.unreadCount, countLabel: "unread" },
    { href: "/deals", label: "Deals", active: pathname.startsWith("/deals"), count: store.actionCount, countLabel: "need attention" },
  ];

  return (
    <header className="sticky top-0 z-30 hidden h-16 bg-bg/85 shadow-[0_1px_0_var(--line)] backdrop-blur-md md:block">
      <div className={`${pageClass} flex h-full items-center gap-6`}>
        <Link href="/" aria-label="HuskySwap home" className="shrink-0">
          <Logo className="text-[22px]" />
        </Link>
        <nav aria-label="Main" className="flex flex-1 items-center gap-1">
          <Link href="/" aria-current={links[0].active ? "page" : undefined} className={link(links[0].active)}>
            Home
          </Link>
          <CategorySheetButton className={`${link(false)} cursor-pointer`}>Categories</CategorySheetButton>
          {links.slice(1).map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.active ? "page" : undefined} className={link(l.active)}>
              {l.label}
              {l.count ? <CountBadge count={l.count} label={l.countLabel!} className="ring-bg" /> : null}
            </Link>
          ))}
        </nav>
        <Link href="/sell" className="bg-grad inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-5 text-small font-semibold transition-colors hover:bg-accent-press">
          <Plus className="size-4" strokeWidth={2.4} aria-hidden />
          Sell an item
        </Link>
        <Link
          href="/profile"
          aria-label="Your profile"
          aria-current={pathname.startsWith("/profile") ? "page" : undefined}
          className={`shrink-0 rounded-full ${pathname.startsWith("/profile") ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
        >
          <Avatar name={name} size={38} />
        </Link>
      </div>
    </header>
  );
}
