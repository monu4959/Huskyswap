"use client";

import { Husky } from "@/components/Husky";
import { ASSISTANT_NAME, ChatThread, assistantSubtitle, useAskChat } from "@/components/HuskyChat";
import { BackButton } from "@/components/ui";

// The assistant as a full page (the floating husky opens the same chat in a panel)
export default function AskPage() {
  const chat = useAskChat();

  return (
    <div className="mx-auto flex h-dvh max-w-[760px] flex-col md:h-[calc(100dvh-64px)] md:py-6">
      <div className="flex min-h-0 flex-1 flex-col md:overflow-hidden md:rounded-sheet md:bg-surface md:shadow-raise">
        <header className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 shadow-[0_1px_0_var(--line)] md:pt-4">
          <BackButton href="/" />
          <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-field" aria-hidden>
            <Husky animated className="size-[88%] translate-y-[4%]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-heading">{ASSISTANT_NAME}</h1>
            <p className="truncate text-micro text-muted">{assistantSubtitle(chat.isAdmin)}</p>
          </div>
        </header>
        <ChatThread chat={chat} />
      </div>
    </div>
  );
}
