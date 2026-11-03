"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ItemCardSkeleton } from "@/components/ItemCard";
import { pageClass } from "@/components/ui";
import { useStore } from "@/lib/store";

// Signed-in area: waits for the session and this student's data, then sends
// signed-out visitors to /login.
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, me, loadError } = useStore();
  const router = useRouter();

  useEffect(() => {
    if (ready && !me) router.replace("/login");
  }, [ready, me, router]);

  if (loadError) return <LoadError message={loadError} />;
  if (!ready || !me) return <AppSkeleton />;
  return <>{children}</>;
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-8 text-center" role="alert">
      <Logo className="mb-4 text-[28px]" />
      <p className="font-display text-title">Couldn&apos;t load the marketplace</p>
      <p className="max-w-sm text-small text-muted">{message}</p>
      <button type="button" onClick={() => location.reload()} className="bg-grad mt-3 h-12 cursor-pointer rounded-full px-6 font-semibold hover:bg-accent-press">
        Try again
      </button>
    </div>
  );
}

// The page behind every screen: warm off-white, full width (screens set their own widths)
export function AppFrame({ children }: { children: ReactNode }) {
  return <div className="relative min-h-dvh bg-bg">{children}</div>;
}

// While the marketplace loads: the shape of the home page, shimmering
function AppSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading listings">
      <div className="hidden h-16 items-center md:flex">
        <div className={`${pageClass} flex items-center justify-between`}>
          <Logo className="text-[22px]" />
          <span className="skeleton h-9 w-9 rounded-full" />
        </div>
      </div>
      <div className={`${pageClass} pt-[max(env(safe-area-inset-top),20px)] md:pt-6`}>
        <div className="mb-5 flex items-center justify-between md:hidden">
          <Logo className="text-[22px]" />
          <span className="skeleton size-10 rounded-full" />
        </div>
        <div className="skeleton mb-6 h-12 rounded-full" />
        <div className="skeleton mb-8 h-[200px] rounded-sheet md:h-[280px]" />
        <div className="mb-8 flex gap-5 overflow-hidden">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex shrink-0 flex-col items-center gap-2">
              <span className="skeleton size-16 rounded-full md:size-[72px]" />
              <span className="skeleton h-3 w-14 rounded-full" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <ItemCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

// The launch screen: the wordmark on the warm page
export function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg" aria-busy="true">
      <Logo className="text-[40px]" />
      <span className="text-small text-muted">Loading listings…</span>
    </div>
  );
}

// HuskySwap's price-tag mark: a tag, punched, in Northeastern red
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        className="fill-accent"
        d="M2.5 12.2 11.6 3.1a1.6 1.6 0 0 1 1.1-.5h7.1c.9 0 1.6.7 1.6 1.6v7.1c0 .4-.2.8-.5 1.1l-9.1 9.1a1.6 1.6 0 0 1-2.3 0l-7-7a1.6 1.6 0 0 1 0-2.3z"
      />
      <circle className="fill-bg" cx="16.6" cy="7.4" r="1.7" />
    </svg>
  );
}

// Mark + wordmark, sized by font-size.
// Northeastern's own logo is a registered trademark: use it here only with the university's approval.
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display inline-flex items-center gap-[0.22em] leading-none font-semibold tracking-[-0.02em] text-fg ${className}`}>
      <Mark className="size-[0.92em]" />
      HuskySwap
    </span>
  );
}
