"use client";

import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ItemArt } from "@/components/ItemArt";
import { EmptyState, PageTitle, narrowClass } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function InboxPage() {
  const store = useStore();

  return (
    <main className={`${narrowClass} pb-36 md:pb-24`}>
      <PageTitle title="Chats" sub="Questions and plans with buyers and sellers" />
      {store.myConversations.length === 0 ? (
        <EmptyState icon={<MessageSquare className="size-7" strokeWidth={1.6} />} title="No chats yet">
          Find something you like and tap Message to ask the seller a question.
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-card bg-surface shadow-raise">
          {store.myConversations.map(({ conversation: c, last, unread }) => {
            const item = store.item(c.item_id);
            const selling = item?.owner_id === store.me;
            const other = store.profile((selling ? c.buyer_id : item?.owner_id) ?? "");
            return (
              <li key={c.conversation_id} className="border-b border-line last:border-0">
                <Link href={`/inbox/${c.conversation_id}`} className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-field/60">
                  <Avatar name={other?.name ?? "?"} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <b className={`truncate text-body ${unread ? "font-bold" : "font-semibold"}`}>{other?.name}</b>
                      <span className="shrink-0 text-micro text-muted">{timeAgo(last?.sent_at ?? c.created_at)}</span>
                    </div>
                    <p className="truncate text-micro text-muted">
                      {selling ? "Your listing: " : ""}
                      {item?.title}
                    </p>
                    <p className={`mt-0.5 truncate text-small ${unread ? "font-semibold text-fg" : "text-muted"}`}>
                      {last ? `${last.sender_id === store.me ? "You: " : ""}${last.body}` : "No messages yet"}
                    </p>
                  </div>
                  {item && (
                    <span className="hidden size-12 shrink-0 overflow-hidden rounded-xl bg-field sm:block">
                      <ItemArt category={item.category} image={item.images[0]} alt="" artClass="size-7" />
                    </span>
                  )}
                  {unread > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-on-accent">
                      {unread}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
