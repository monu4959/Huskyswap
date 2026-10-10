"use client";

import { useRef, useState } from "react";
import { Flag } from "lucide-react";
import { Button, Field, inputClass, useAction } from "./ui";
import { useStore } from "@/lib/store";
import type { Report } from "@/lib/types";

type Target = Pick<Report, "item_id" | "transaction_id" | "reported_user_id">;

export function ReportButton({ target, label }: { target: Target; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const { submitReport } = useStore();
  const act = useAction();

  const submit = async () => {
    const ok = await act(async () => {
      await submitReport(target, reason);
      return true;
    }, "Report sent. The team will take a look.");
    if (ok) {
      setReason("");
      ref.current?.close();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-muted hover:text-fg"
      >
        <Flag className="size-4" aria-hidden />
        {label}
      </button>
      <dialog
        ref={ref}
        className="m-auto w-[min(92vw,420px)] rounded-[24px] bg-surface p-5 text-fg shadow-raise backdrop:bg-black/60"
        aria-labelledby="report-title"
      >
        <h2 id="report-title" className="text-[18px] font-bold">
          {label}
        </h2>
        <p className="mt-1 text-[13px] text-muted">Reports go to the moderators, not to the other student.</p>
        <div className="mt-4">
          <Field label="What's wrong?">
            <textarea
              rows={4}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={`${inputClass} resize-none`}
              placeholder="For example: the photos don't match the item"
            />
          </Field>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Button variant="soft" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button onClick={submit}>Send report</Button>
        </div>
      </dialog>
    </>
  );
}
