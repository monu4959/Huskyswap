"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Check, LoaderCircle, SendHorizontal, ThumbsDown, ThumbsUp, TriangleAlert, X, Zap } from "lucide-react";
import { Husky, PawTyping } from "@/components/Husky";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/lib/store";
import type { AskDone, AskNode } from "@/app/api/ask/route";
import type { ClarificationTurn } from "@/lib/agent/types";

export const ASSISTANT_NAME = "Ask HuskySwap";

const EXAMPLES = {
  student: ["Cheapest textbooks this week", "Any mini fridges for rent at Curry?", "What's free right now?", "How much have I earned from selling?"],
  admin: [
    "How many rentals came back late during spring 2025 move-out?",
    "Top 5 meetup spots by completed deals",
    "Who are the best sellers?",
  ],
};

// One question and its answer; a clarification reply continues the same question
type Turn = {
  id: number;
  question: string; // the original question
  shown: string; // what the user typed for this turn (the question, or their clarification answer)
  clarifications: ClarificationTurn[];
  events: AskNode[];
  done?: AskDone;
  error?: string;
  feedback?: 1 | -1;
};

const LABEL: Record<AskNode["node"], string> = {
  cache: "Checking past answers",
  retrieve: "Finding the relevant tables and values",
  clarify: "Checking the question is clear",
  sql: "Writing the query",
  validate: "Checking the query is safe",
  execute: "Running it",
  answer: "Writing the answer",
};

// Progress lines from the event stream: one per node run, marked when it finishes
function progress(events: AskNode[]) {
  const lines: { node: AskNode["node"]; status: AskNode["status"]; finished: boolean }[] = [];
  for (const e of events) {
    const open = [...lines].reverse().find((l) => l.node === e.node && !l.finished);
    if (e.status === "start") lines.push({ node: e.node, status: e.status, finished: false });
    else if (open) Object.assign(open, { status: e.status, finished: true });
    else lines.push({ node: e.node, status: e.status, finished: true }); // validate / execute report once
  }
  return lines;
}

function lineText(l: { node: AskNode["node"]; status: AskNode["status"] }) {
  if (l.node === "cache" && l.status === "hit") return "Found a matching past answer";
  if (l.status === "error") return l.node === "validate" ? "Query rejected: fixing it" : "It failed: fixing it";
  return LABEL[l.node];
}

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ""}` };
}

// The assistant's conversation: asks /api/ask, reads its event stream, continues
// clarifications and sends feedback. Shared by the chat panel and the /ask page.
export function useAskChat() {
  const store = useStore();
  const isAdmin = store.profile(store.me!)?.role === "admin";
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const busy = turns.some((t) => !t.done && !t.error);
  const last = turns.at(-1);
  const pending = last?.done?.status === "clarify" ? last : null; // waiting for a clarification answer
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  const update = (id: number, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const ask = async (question: string, clarifications: ClarificationTurn[], shown: string) => {
    const id = Date.now();
    setTurns((all) => [...all, { id, question, shown, clarifications, events: [] }]);
    setDraft("");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ question, clarifications }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        update(id, (t) => ({ ...t, error: body?.error ?? "Something went wrong. Try again." }));
        return;
      }
      // Newline-delimited JSON: one event per line
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as AskNode | AskDone;
          update(id, (t) => (event.type === "done" ? { ...t, done: event } : { ...t, events: [...t.events, event] }));
        }
      }
    } catch {
      update(id, (t) => (t.done ? t : { ...t, error: "Couldn't reach the server. Check your connection and try again." }));
    }
  };

  // A clarification answer continues the pending question; anything else is a new question
  const reply = (text: string) => {
    if (pending?.done?.clarification) {
      const turnsSoFar = [...pending.clarifications, { question: pending.done.clarification.question, answer: text }];
      ask(pending.question, turnsSoFar, text);
    } else {
      ask(text, [], text);
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && !busy) reply(draft.trim());
  };

  const rate = async (turn: Turn, value: 1 | -1) => {
    if (!turn.done?.runId) return;
    update(turn.id, (t) => ({ ...t, feedback: value }));
    await fetch("/api/ask/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ runId: turn.done.runId, value }),
    }).catch(() => {});
  };

  return { isAdmin, draft, setDraft, turns, busy, pending, endRef, reply, send, rate };
}

type Chat = ReturnType<typeof useAskChat>;

export const assistantSubtitle = (isAdmin: boolean) =>
  isAdmin ? "Questions about all marketplace activity" : "Questions about listings and your own activity";

function HuskyAvatar({ size = "size-8" }: { size?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-field ${size}`} aria-hidden>
      <Husky className="size-[88%] translate-y-[4%]" />
    </span>
  );
}

// An assistant message: husky avatar on the left, light gray bubble
function FromHusky({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex items-end gap-2">
      <HuskyAvatar />
      <div className={`min-w-0 rounded-[20px] rounded-bl-md bg-field px-4 py-3 text-small text-fg ${wide ? "flex-1" : "max-w-[85%]"}`}>{children}</div>
    </div>
  );
}

// The conversation and the composer, sized by the parent (the panel or the /ask page)
export function ChatThread({ chat, inputRef }: { chat: Chat; inputRef?: RefObject<HTMLTextAreaElement | null> }) {
  const { isAdmin, draft, setDraft, turns, busy, pending, endRef, reply, send, rate } = chat;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-4 pb-3">
        {turns.length === 0 && (
          <div className="animate-pop-in">
            <FromHusky>
              <p className="font-semibold">Woof! Ask me in your own words.</p>
              <p className="mt-1 text-muted">I write a database query, run it and tell you what I found.</p>
            </FromHusky>
          </div>
        )}

        {turns.map((turn) => (
          <section key={turn.id} className="flex flex-col gap-3" aria-label={turn.shown}>
            <p className="ml-auto max-w-[85%] rounded-[20px] rounded-br-md bg-grad px-4 py-2.5 text-small leading-snug whitespace-pre-line">{turn.shown}</p>

            {!turn.done && !turn.error && (
              <FromHusky>
                <PawTyping label="Looking that up" />
                <ol className="mt-2 flex flex-col gap-1 text-micro" aria-live="polite">
                  {progress(turn.events).map((l, i, all) => (
                    <li key={i} className={`flex items-center gap-1.5 ${i < all.length - 1 ? "text-muted" : "text-fg"}`}>
                      {!l.finished ? (
                        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent-ink" />
                      ) : l.status === "error" ? (
                        <TriangleAlert className="size-3.5 shrink-0 text-amber" />
                      ) : l.status === "hit" ? (
                        <Zap className="size-3.5 shrink-0 text-accent-ink" />
                      ) : (
                        <Check className="size-3.5 shrink-0 text-green" />
                      )}
                      {lineText(l)}
                    </li>
                  ))}
                  {turn.events.length === 0 && <li className="text-muted">Starting</li>}
                </ol>
              </FromHusky>
            )}

            {turn.error && (
              <FromHusky>
                <span className="text-coral">{turn.error}</span>
              </FromHusky>
            )}

            {turn.done?.status === "clarify" && turn.done.clarification && (
              <FromHusky>
                <p className="leading-snug">{turn.done.clarification.question}</p>
                {turn === pending && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {turn.done.clarification.options.map((o) => (
                      <button
                        key={o}
                        type="button"
                        disabled={busy}
                        onClick={() => reply(o)}
                        className="cursor-pointer rounded-full bg-surface px-3.5 py-1.5 text-small font-medium shadow-raise transition-colors hover:text-accent-ink disabled:opacity-45"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </FromHusky>
            )}

            {turn.done && turn.done.status !== "clarify" && (
              <FromHusky wide={turn.done.rows.length > 0}>
                <div className="flex flex-col gap-3">
                  {turn.done.cacheHit && (
                    <span className="flex items-center gap-1 text-micro font-semibold text-accent-ink">
                      <Zap className="size-3.5" /> Instant answer from a matching past question
                    </span>
                  )}
                  <p className="leading-snug whitespace-pre-line">{turn.done.error ?? turn.done.answer ?? "I couldn't find an answer to that."}</p>

                  {turn.done.rows.length > 0 && (
                    <div className="overflow-x-auto rounded-xl bg-surface p-2">
                      <table className="w-full text-left text-micro">
                        <thead className="text-muted">
                          <tr>
                            {turn.done.columns.map((c) => (
                              <th key={c} className="px-1.5 pb-1 font-semibold whitespace-nowrap">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {turn.done.rows.map((row, i) => (
                            <tr key={i} className="border-t border-line">
                              {turn.done!.columns.map((c) => (
                                <td key={c} className="max-w-[180px] truncate px-1.5 py-1 whitespace-nowrap">
                                  {row[c] === null ? "–" : String(row[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {turn.done.rowCount > turn.done.rows.length && (
                        <p className="mt-1 px-1.5 text-micro text-muted">
                          Showing {turn.done.rows.length} of {turn.done.truncated ? "200+" : turn.done.rowCount} rows
                        </p>
                      )}
                    </div>
                  )}

                  {turn.done.sql && (
                    <details className="text-micro">
                      <summary className="cursor-pointer font-semibold text-accent-ink">SQL used</summary>
                      <pre className="mt-2 overflow-x-auto rounded-xl bg-surface p-2.5 font-mono text-[11px] leading-relaxed">{turn.done.sql}</pre>
                    </details>
                  )}

                  <div className="flex items-center justify-between text-micro text-muted">
                    <span>
                      {turn.done.cacheHit ? "No model calls" : `${turn.done.modelCalls} model call${turn.done.modelCalls === 1 ? "" : "s"}`} ·{" "}
                      {(turn.done.latencyMs / 1000).toFixed(1)} s
                    </span>
                    {turn.done.runId && (
                      <span className="flex gap-1">
                        {([1, -1] as const).map((v) => {
                          const Icon = v === 1 ? ThumbsUp : ThumbsDown;
                          return (
                            <button
                              key={v}
                              type="button"
                              onClick={() => rate(turn, v)}
                              aria-label={v === 1 ? "Good answer" : "Bad answer"}
                              aria-pressed={turn.feedback === v}
                              className={`grid size-11 cursor-pointer place-items-center rounded-full transition-colors ${
                                turn.feedback === v ? "bg-surface text-accent-ink shadow-raise" : "hover:bg-surface"
                              }`}
                            >
                              <Icon className="size-4" />
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </div>
                </div>
              </FromHusky>
            )}
          </section>
        ))}
        <div ref={endRef} aria-hidden />
      </div>

      {turns.length === 0 && (
        <div className="scrollbar-none flex gap-2 overflow-x-auto px-4 pb-2 md:flex-wrap">
          {EXAMPLES[isAdmin ? "admin" : "student"].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => reply(q)}
              className="shrink-0 cursor-pointer rounded-full bg-surface px-3.5 py-2 text-small font-medium whitespace-nowrap shadow-raise transition-colors hover:text-accent-ink"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={send} className="flex items-end gap-2 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),14px)] md:pb-3.5">
        <label className="flex-1">
          <span className="sr-only">{pending ? "Your answer" : "Your question"}</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={pending ? "Pick an option or type your answer" : "Ask about listings"}
            className="block max-h-32 min-h-12 w-full resize-none rounded-[24px] bg-field px-4.5 py-3 text-small text-fg outline-none placeholder:text-muted focus:bg-surface focus:ring-2 focus:ring-accent-ink"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          aria-label="Send"
          className="bg-grad grid size-12 shrink-0 cursor-pointer place-items-center rounded-full transition-[background-color,scale] hover:bg-accent-press active:scale-95 disabled:cursor-not-allowed disabled:bg-field-strong disabled:text-muted"
        >
          <SendHorizontal className="size-5" />
        </button>
      </form>
    </div>
  );
}

// Screens where the floating husky would sit on top of a composer
const NO_LAUNCHER = [/^\/ask/, /^\/inbox\/.+/];
const HINT_KEY = "huskyswap-husky-hint";

// The floating husky in the bottom-right corner and the chat panel it opens
export function HuskyAssistant() {
  const pathname = usePathname();
  const chat = useAskChat();
  const [open, setOpen] = useState(false);
  // Only rendered in the browser (behind AuthGate), so storage is available here
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "dismissed";
    } catch {
      return false;
    }
  });
  const [hintReady, setHintReady] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hidden = NO_LAUNCHER.some((r) => r.test(pathname));

  // The speech bubble appears a moment after the page settles
  useEffect(() => {
    const t = setTimeout(() => setHintReady(true), 1200);
    return () => clearTimeout(t);
  }, []);

  const dismissHint = () => {
    setHintDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, "dismissed");
    } catch {
      // storage blocked: the bubble stays hidden for this visit
    }
  };

  const close = () => {
    setOpen(false);
    launcherRef.current?.focus();
  };

  // Escape closes the panel; opening it focuses the question box
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (hidden) return null;

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="husky-chat-title"
          className="animate-sheet-in fixed inset-0 z-50 flex flex-col bg-bg md:inset-auto md:right-8 md:bottom-[136px] md:h-[600px] md:max-h-[calc(100dvh-170px)] md:w-[400px] md:overflow-hidden md:rounded-sheet md:bg-surface md:shadow-pop"
        >
          <header className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)] pb-3 shadow-[0_1px_0_var(--line)] md:pt-3.5">
            <HuskyAvatar size="size-11" />
            <div className="min-w-0 flex-1">
              <h2 id="husky-chat-title" className="text-lead font-semibold">
                {ASSISTANT_NAME}
              </h2>
              <p className="truncate text-micro text-muted">{assistantSubtitle(chat.isAdmin)}</p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close chat"
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-fg transition-colors hover:bg-field"
            >
              <X className="size-5" />
            </button>
          </header>
          <ChatThread chat={chat} inputRef={inputRef} />
        </div>
      )}

      <div className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+96px)] z-40 flex items-end gap-3 md:right-8 md:bottom-8">
        {!open && !hintDismissed && hintReady && (
          <div className="animate-pop-in relative mb-3 flex max-w-[220px] items-start gap-1 rounded-[18px] rounded-br-md bg-surface py-2.5 pr-1.5 pl-3.5 text-small font-medium shadow-lift">
            <p>Woof! Need help finding something?</p>
            <button
              type="button"
              onClick={dismissHint}
              aria-label="Dismiss the assistant tip"
              className="-my-1.5 -mr-1 grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-muted hover:bg-field hover:text-fg"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <button
          ref={launcherRef}
          type="button"
          onClick={() => {
            if (open) return close();
            setOpen(true);
            if (!hintDismissed) dismissHint();
          }}
          aria-label={open ? `Close ${ASSISTANT_NAME}` : `Open ${ASSISTANT_NAME}, the marketplace assistant`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`group grid size-16 shrink-0 cursor-pointer place-items-center rounded-full bg-surface shadow-lift ring-1 ring-line transition-transform duration-200 hover:-translate-y-0.5 hover:scale-105 active:scale-95 md:size-20 ${
            open ? "max-md:hidden" : ""
          }`}
        >
          <Husky animated className="size-[86%] translate-y-[3%] transition-transform duration-300 group-hover:rotate-[-6deg]" />
        </button>
      </div>
    </>
  );
}
