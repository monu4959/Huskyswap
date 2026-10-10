"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, House, MessageSquare, Plus, ReceiptText } from "lucide-react";
import { useStore } from "@/lib/store";

// Screens with their own bottom action bar
const HIDDEN = [/^\/item\//, /^\/inbox\/.+/, /^\/sell/];

export function TabBar() {
  const pathname = usePathname();
  const { unreadCount, actionCount } = useStore();
  if (HIDDEN.some((r) => r.test(pathname))) return null;

  const tabs = [
    { href: "/", label: "Home", icon: House, active: pathname === "/" },
    { href: "/saved", label: "Saved", icon: Heart, active: pathname.startsWith("/saved") },
    { href: "/sell", label: "Sell", icon: Plus, active: false, sell: true },
    { href: "/inbox", label: "Chats", icon: MessageSquare, active: pathname.startsWith("/inbox"), badge: unreadCount },
    { href: "/deals", label: "Deals", icon: ReceiptText, active: pathname.startsWith("/deals"), badge: actionCount },
  ];

  return (
    <nav
      aria-label="Main"
      className="shadow-bar fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[480px] rounded-t-[26px] bg-surface pb-safe"
    >
      <ul className="flex h-20 items-start justify-around px-2 pt-3">
        {tabs.map(({ href, label, icon: Icon, active, badge, sell }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative flex w-14 flex-col items-center gap-1 text-[11px] font-medium ${
                active ? "text-fg" : "text-muted"
              } ${sell ? "-mt-[26px]" : ""}`}
            >
              {sell ? (
                <span className="bg-grad grid size-[52px] place-items-center rounded-[18px] shadow-[0_12px_22px_-10px_rgba(78,74,242,0.9)]">
                  <Icon className="size-[22px]" strokeWidth={2} aria-hidden />
                </span>
              ) : (
                <Icon className="size-[22px]" strokeWidth={1.8} aria-hidden />
              )}
              {label}
              {active && <span aria-hidden className="bg-grad absolute -bottom-2 h-[3px] w-[18px] rounded-full" />}
              {!!badge && (
                <span className="absolute -top-1 right-2.5 grid h-4 min-w-4 place-items-center rounded-full bg-[#FF7A7A] px-1 text-[10px] font-bold text-white">
                  {badge}
                  <span className="sr-only"> need attention</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
