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

// Page widths: wide for browsing grids, narrow for forms, chats and detail flows
export const pageClass = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 md:px-8";
export const narrowClass = "mx-auto w-full max-w-[720px] px-4 sm:px-6 md:px-8";

type Variant = "grad" | "soft" | "ghost" | "danger";

const VARIANT: Record<Variant, string> = {
  grad: "bg-grad hover:bg-accent-press active:scale-[0.98]",
  soft: "bg-surface text-fg shadow-raise hover:bg-field active:scale-[0.98]",
  ghost: "text-fg hover:bg-field",
  danger: "bg-surface text-coral shadow-raise hover:bg-field active:scale-[0.98]",
};

export const buttonClass = (variant: Variant = "grad", extra = "") =>
  `inline-flex h-[50px] items-center justify-center gap-2 rounded-full px-6 text-body font-semibold transition-[background-color,opacity,scale] duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${extra}`;

export function Button({
  variant = "grad",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={buttonClass(variant, className)} {...props} />;
}

export const roundClass =
  "grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-full bg-surface text-fg shadow-raise transition-colors hover:bg-field";

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

// Round back button, centered title, optional right action. Sits under the desktop top nav.
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
    <header className="sticky top-0 z-20 grid grid-cols-[42px_1fr_42px] items-center gap-2 bg-bg/90 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 backdrop-blur-md md:top-16 md:px-0 md:pt-6">
      {back ? <BackButton href={back === true ? undefined : back} icon={backIcon} /> : <span />}
      <h1 className="truncate text-center text-heading">{title}</h1>
      <div className="flex justify-end">{right}</div>
    </header>
  );
}

// A page heading for top-level screens (Saved, Chats, Deals)
export function PageTitle({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 pt-[max(env(safe-area-inset-top),20px)] md:pt-10">
      <div>
        <h1 className="text-title md:text-[2.5rem]">{title}</h1>
        {sub && <p className="mt-1.5 text-small text-muted">{sub}</p>}
      </div>
      {children}
    </div>
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
      <span className="mb-2 block text-small font-semibold text-fg">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-small text-coral">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-micro text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full min-h-[48px] rounded-field bg-field px-4 py-3 text-body text-fg placeholder:text-muted outline-none transition-[background-color,box-shadow] hover:bg-field-strong focus:bg-surface focus:ring-2 focus:ring-accent-ink border-0 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-coral";

// Segmented control (soft track, raised white selection)
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
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-field p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`relative min-h-10 flex-1 cursor-pointer rounded-full px-2 text-small font-semibold transition-[background-color,color,box-shadow] ${
            value === o.value ? "bg-surface text-fg shadow-raise" : "text-muted hover:text-fg"
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
      className={`relative h-[26px] w-11 shrink-0 cursor-pointer rounded-full transition-colors ${checked ? "bg-accent" : "bg-field-strong"}`}
    >
      <span
        className={`absolute top-[3px] size-5 rounded-full bg-white shadow-raise transition-[left] duration-150 ${checked ? "left-[21px]" : "left-[3px]"}`}
      />
    </button>
  );
}

export type Tone = "amber" | "cyan" | "violet" | "green" | "coral" | "muted";
const TONE: Record<Tone, string> = {
  amber: "text-amber bg-amber/12",
  cyan: "text-cyan bg-cyan/12",
  violet: "text-violet bg-violet/12",
  green: "text-green bg-green/12",
  coral: "text-coral bg-coral/12",
  muted: "text-muted bg-field",
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-[5px] text-micro leading-none font-semibold whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-5 grid size-[72px] place-items-center rounded-full bg-surface text-accent-ink shadow-raise">{icon}</div>
      <p className="font-display text-heading font-medium">{title}</p>
      {children && <div className="mt-2 max-w-sm text-small text-muted">{children}</div>}
    </div>
  );
}

// A raised card (the app's main container)
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-card bg-surface shadow-raise ${className}`}>{children}</div>;
}

// A red count bubble on an icon (unread chats, deals waiting on you)
export function CountBadge({ count, label, className = "" }: { count: number; label: string; className?: string }) {
  if (!count) return null;
  return (
    <span
      className={`grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] leading-none font-bold text-on-accent ring-2 ring-surface ${className}`}
    >
      {count}
      <span className="sr-only"> {label}</span>
    </span>
  );
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
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),16px)] z-[60] flex justify-center px-4 md:top-20">
        {toast && (
          <div
            key={toast.key}
            className={`animate-pop-in rounded-full px-5 py-3 text-small font-semibold shadow-pop ${
              toast.tone === "error" ? "bg-grad" : "bg-fg text-bg"
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
