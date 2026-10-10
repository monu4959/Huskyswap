"use client";

import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function InboxPage() {
  const store = useStore();

  return (
    <main className="px-5 pt-[max(env(safe-area-inset-top),16px)] pb-32">
      <h1 className="mt-1.5 mb-3.5 text-[24px] font-bold">Chats</h1>
      {store.myConversations.length === 0 ? (
        <EmptyState icon={<MessageSquare className="size-7" strokeWidth={1.6} />} title="No chats yet">
          Find something you like and tap Message to ask the seller a question.
        </EmptyState>
      ) : (
        <ul className="space-y-[11px]">
          {store.myConversations.map(({ conversation: c, last, unread }) => {
            const item = store.item(c.item_id);
            const selling = item?.owner_id === store.me;
            const other = store.profile((selling ? c.buyer_id : item?.owner_id) ?? "");
            return (
              <li key={c.conversation_id}>
                <Link href={`/inbox/${c.conversation_id}`} className="flex items-center gap-3 rounded-[20px] bg-surface p-2.5 shadow-raise">
                  <Avatar name={other?.name ?? "?"} size={46} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <b className={`truncate text-[13.5px] ${unread ? "font-bold" : "font-semibold"}`}>{other?.name}</b>
                      <span className="shrink-0 text-[11px] text-muted">{timeAgo(last?.sent_at ?? c.created_at)}</span>
                    </div>
                    <p className="truncate text-[12px] text-muted">
                      {selling ? "Your listing: " : ""}
                      {item?.title}
                    </p>
                    <p className={`truncate text-[12.5px] ${unread ? "font-semibold text-fg" : "text-muted"}`}>
                      {last ? `${last.sender_id === store.me ? "You: " : ""}${last.body}` : "No messages yet"}
                    </p>
                  </div>
                  {unread > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#FF7A7A] px-1.5 text-[11px] font-bold text-white">
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
