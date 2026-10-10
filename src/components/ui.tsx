"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ActionError } from "@/lib/store";

type Variant = "grad" | "soft" | "ghost" | "danger";

const VARIANT: Record<Variant, string> = {
  grad: "bg-grad shadow-grad hover:brightness-110",
  soft: "bg-surface text-fg shadow-raise hover:brightness-110",
  ghost: "text-fg hover:bg-surface",
  danger: "bg-surface text-coral shadow-raise hover:brightness-110",
};

export const buttonClass = (variant: Variant = "grad", extra = "") =>
  `font-display inline-flex h-[50px] items-center justify-center gap-2 rounded-2xl px-4 text-[14.5px] font-semibold transition-[filter,opacity] duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${extra}`;

export function Button({
  variant = "grad",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={buttonClass(variant, className)} {...props} />;
}

export const roundClass =
  "grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-[14px] bg-surface text-fg shadow-raise hover:brightness-110";

export function BackButton({ href, icon = "back" }: { href?: string; icon?: "back" | "close" }) {
  const router = useRouter();
  const Icon = icon === "close" ? X : ChevronLeft;
  const label = icon === "close" ? "Close" : "Back";
  if (href)
    return (
      <Link href={href} className={roundClass} aria-label={label}>
        <Icon className="size-5" />
      </Link>
    );
  return (
    <button type="button" onClick={() => router.back()} className={roundClass} aria-label={label}>
      <Icon className="size-5" />
    </button>
  );
}

// Round back button, centered title, optional right action (app-design "topbar")
export function TopBar({
  title,
  back,
  backIcon,
  right,
}: {
  title?: ReactNode;
  back?: string | true;
  backIcon?: "back" | "close";
  right?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 grid grid-cols-[42px_1fr_42px] items-center gap-2 bg-bg/95 px-5 pt-[max(env(safe-area-inset-top),12px)] pb-3 backdrop-blur-sm">
      {back ? <BackButton href={back === true ? undefined : back} icon={backIcon} /> : <span />}
      <h1 className="truncate text-center text-[17px] font-semibold">{title}</h1>
      <div className="flex justify-end">{right}</div>
    </header>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-[7px] block text-[12.5px] font-semibold text-muted">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[12.5px] text-coral">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[12px] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full min-h-[46px] rounded-[14px] bg-field shadow-inset px-3.5 py-2.5 text-[15px] text-fg placeholder:text-muted outline-none focus:ring-[1.5px] focus:ring-cyan border-0";

// Segmented control (sunken track, raised selection)
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-[14px] bg-field p-1 shadow-inset">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`relative min-h-9 flex-1 cursor-pointer rounded-[10px] px-1 text-[13px] font-medium transition-colors ${
            value === o.value ? "bg-surface text-fg shadow-raise" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[23px] w-10 shrink-0 cursor-pointer rounded-full ${checked ? "bg-grad" : "bg-field shadow-inset"}`}
    >
      <span
        className={`absolute top-[3px] size-[17px] rounded-full transition-[left] duration-150 ${
          checked ? "left-5 bg-white" : "left-[3px] bg-muted"
        }`}
      />
    </button>
  );
}

export type Tone = "amber" | "cyan" | "violet" | "green" | "coral" | "muted";
const TONE: Record<Tone, string> = {
  amber: "text-amber bg-amber/15",
  cyan: "text-cyan bg-cyan/15",
  violet: "text-violet bg-violet/15",
  green: "text-green bg-green/15",
  coral: "text-coral bg-coral/15",
  muted: "text-muted bg-muted/15",
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-[9px] py-1 text-[11.5px] leading-none font-semibold whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 grid size-16 place-items-center rounded-[22px] bg-surface text-cyan shadow-raise">{icon}</div>
      <p className="font-display text-lg font-semibold">{title}</p>
      {children && <div className="mt-2 max-w-xs text-[14px] text-muted">{children}</div>}
    </div>
  );
}

// A raised card (the app's main container)
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-[20px] bg-surface shadow-raise ${className}`}>{children}</div>;
}

// ---------- toasts ----------
const ToastContext = createContext<(msg: string, tone?: "ok" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "error"; key: number } | null>(null);
  const show = useCallback((msg: string, tone: "ok" | "error" = "ok") => {
    const key = Date.now();
    setToast({ msg, tone, key });
    setTimeout(() => setToast((t) => (t?.key === key ? null : t)), 2800);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),16px)] z-50 flex justify-center px-4">
        {toast && (
          <div
            key={toast.key}
            className={`rounded-2xl px-4 py-3 text-[14px] font-semibold text-white shadow-raise ${
              toast.tone === "error" ? "bg-[#c33b3b]" : "bg-grad"
            }`}
          >
            {toast.msg}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// Run a store action (they all talk to the database); show a refused rule or a
// network problem as a toast instead of crashing. Resolves to undefined on failure.
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <R,>(fn: () => R | Promise<R>, success?: string): Promise<R | undefined> => {
      try {
        const result = await fn();
        if (success) toast(success);
        return result;
      } catch (e) {
        toast(e instanceof ActionError ? e.message : "Couldn't reach the server. Check your connection and try again.", "error");
        if (!(e instanceof ActionError)) console.error(e);
        return undefined;
      }
    },
    [toast],
  );
}
