"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, SendHorizontal, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { BackButton, Card } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/lib/store";
import type { AskDone, AskStep } from "@/app/api/ask/route";

const EXAMPLES = {
  student: ["Any mini fridges for rent at Curry?", "Cheapest graphing calculator for sale", "What's free right now?"],
  admin: [
    "How many rentals came back late during spring 2025 move-out?",
    "Top 5 meetup spots by completed deals",
    "Average seller reply time in September 2025",
  ],
};

type Turn = { id: number; question: string; steps: AskStep[]; done?: AskDone; error?: string; feedback?: 1 | -1 };

// What the assistant is doing, in words, for one tool call
function stepLabel(s: AskStep) {
  const a = s.args ?? {};
  switch (s.tool) {
    case "describe_view":
      return `Reading the ${String(a.view)} table`;
    case "sample_values":
      return `Looking up ${String(a.column)} values${a.search ? ` like "${String(a.search)}"` : ""}`;
    case "run_sql":
      return "Running a query";
    case "submit_answer":
      return "Checking the answer";
    default:
      return s.tool;
  }
}

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ""}` };
}

export default function AskPage() {
  const store = useStore();
  const isAdmin = store.profile(store.me!)?.role === "admin";
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const busy = turns.some((t) => !t.done && !t.error);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  const update = (id: number, fn: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const ask = async (question: string) => {
    const id = Date.now();
    setTurns((all) => [...all, { id, question, steps: [] }]);
    setDraft("");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ question }),
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
          const event = JSON.parse(line) as AskStep | AskDone;
          update(id, (t) => (event.type === "done" ? { ...t, done: event } : { ...t, steps: [...t.steps, event] }));
        }
      }
    } catch {
      update(id, (t) => (t.done ? t : { ...t, error: "Couldn't reach the server. Check your connection and try again." }));
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && !busy) ask(draft.trim());
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

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-2.5 bg-bg/95 px-5 pt-[max(env(safe-area-inset-top),12px)] pb-3 backdrop-blur-sm">
        <BackButton href="/" />
        <div className="min-w-0">
          <h1 className="font-display text-[17px] font-semibold">Ask HuskySwap</h1>
          <p className="text-[12px] text-muted">{isAdmin ? "Questions about all marketplace activity" : "Questions about what's listed right now"}</p>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 px-5 pt-2 pb-4">
        {turns.length === 0 && (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="mb-4 grid size-16 place-items-center rounded-[22px] bg-surface text-cyan shadow-raise">
              <Sparkles className="size-7" strokeWidth={1.6} />
            </div>
            <p className="font-display text-lg font-semibold">Ask in your own words</p>
            <p className="mt-2 max-w-xs text-[14px] text-muted">The assistant writes a database query, runs it and tells you what it found.</p>
            <div className="mt-5 flex w-full flex-col gap-2">
              {EXAMPLES[isAdmin ? "admin" : "student"].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="cursor-pointer rounded-[14px] bg-surface px-3.5 py-3 text-left text-[13.5px] shadow-raise hover:brightness-110"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <section key={turn.id} className="flex flex-col gap-2" aria-label={turn.question}>
            <p className="bg-grad ml-auto max-w-[85%] rounded-[18px] rounded-br-md px-[13px] py-[9px] text-[13.5px] leading-snug">{turn.question}</p>

            {!turn.done && !turn.error && (
              <Card className="px-3.5 py-3">
                <ol className="flex flex-col gap-1.5 text-[13px]" aria-live="polite">
                  {turn.steps
                    .filter((s) => s.phase === "call")
                    .map((s, i, calls) => {
                      const result = turn.steps.find((r) => r.phase === "result" && r.step === s.step && r.tool === s.tool);
                      const failed = result && !result.ok;
                      return (
                        <li key={i} className={`flex items-center gap-2 ${i < calls.length - 1 ? "text-muted" : ""}`}>
                          {failed ? (
                            <TriangleAlert className="size-3.5 shrink-0 text-amber" />
                          ) : result ? (
                            <Check className="size-3.5 shrink-0 text-green" />
                          ) : (
                            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-cyan" />
                          )}
                          {stepLabel(s)}
                          {failed && s.tool === "run_sql" ? ": it failed, fixing it" : ""}
                        </li>
                      );
                    })}
                  {turn.steps.length === 0 && (
                    <li className="flex items-center gap-2">
                      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-cyan" /> Thinking
                    </li>
                  )}
                </ol>
              </Card>
            )}

            {turn.error && <Card className="px-3.5 py-3 text-[13.5px] text-coral">{turn.error}</Card>}

            {turn.done && (
              <Card className="flex flex-col gap-3 px-3.5 py-3">
                <p className="text-[14px] leading-snug whitespace-pre-line">
                  {turn.done.error ?? turn.done.answer ?? "I couldn't find an answer to that."}
                </p>

                {turn.done.rows.length > 0 && (
                  <div className="-mx-1 overflow-x-auto">
                    <table className="w-full text-left text-[12px]">
                      <thead className="text-muted">
                        <tr>
                          {turn.done.columns.map((c) => (
                            <th key={c} className="px-1 pb-1 font-semibold whitespace-nowrap">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {turn.done.rows.map((row, i) => (
                          <tr key={i} className="border-t border-line">
                            {turn.done!.columns.map((c) => (
                              <td key={c} className="max-w-[180px] truncate px-1 py-1 whitespace-nowrap">
                                {row[c] === null ? "–" : String(row[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {turn.done.rowCount > turn.done.rows.length && (
                      <p className="mt-1 px-1 text-[11.5px] text-muted">
                        Showing {turn.done.rows.length} of {turn.done.truncated ? "200+" : turn.done.rowCount} rows
                      </p>
                    )}
                  </div>
                )}

                {turn.done.sql && (
                  <details className="text-[12px]">
                    <summary className="cursor-pointer font-semibold text-cyan">SQL used</summary>
                    <pre className="mt-2 overflow-x-auto rounded-xl bg-field p-2.5 font-mono text-[11.5px] leading-relaxed shadow-inset">{turn.done.sql}</pre>
                  </details>
                )}

                <div className="flex items-center justify-between text-[11.5px] text-muted">
                  <span>
                    {turn.done.steps} step{turn.done.steps === 1 ? "" : "s"} · {(turn.done.latencyMs / 1000).toFixed(1)} s
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
                            className={`grid size-8 cursor-pointer place-items-center rounded-[10px] ${turn.feedback === v ? "bg-field text-cyan shadow-inset" : "hover:bg-field"}`}
                          >
                            <Icon className="size-4" />
                          </button>
                        );
                      })}
                    </span>
                  )}
                </div>
              </Card>
            )}
          </section>
        ))}
        <div ref={endRef} aria-hidden />
      </div>

      <form onSubmit={send} className="sticky bottom-0 flex items-end gap-2 bg-bg px-4 pt-2 pb-[max(env(safe-area-inset-bottom),20px)]">
        <label className="flex-1">
          <span className="sr-only">Your question</span>
          <textarea
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
            placeholder="Ask about listings"
            className="block max-h-32 min-h-[46px] w-full resize-none rounded-[14px] bg-field px-3.5 py-3 text-[14px] text-fg shadow-inset outline-none placeholder:text-muted focus:ring-[1.5px] focus:ring-cyan"
          />
        </label>
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          aria-label="Ask"
          className="bg-grad grid size-[46px] shrink-0 cursor-pointer place-items-center rounded-[14px] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <SendHorizontal className="size-5" />
        </button>
      </form>
    </div>
  );
}
