"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
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
  if (!ready || !me) return <Splash />;
  return <>{children}</>;
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-8 text-center" role="alert">
      <p className="font-display text-lg font-semibold">Couldn&apos;t load the marketplace</p>
      <p className="text-[13px] text-muted">{message}</p>
      <button type="button" onClick={() => location.reload()} className="bg-grad mt-2 h-11 cursor-pointer rounded-2xl px-5 font-semibold">
        Try again
      </button>
    </div>
  );
}

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative mx-auto min-h-dvh max-w-[480px] overflow-x-clip bg-bg min-[481px]:shadow-raise">
      {children}
    </div>
  );
}

export function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3" aria-busy="true">
      <span className="bg-grad grid size-14 place-items-center rounded-[18px] shadow-grad">
        <Mark className="size-7" />
      </span>
      <span className="text-[13px] text-muted">Loading listings…</span>
    </div>
  );
}

// The tag mark from the design's wordmark
export function Mark({ className = "", stroke = "#fff" }: { className?: string; stroke?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12l8.5-8.5H20V12l-8.5 8.5z" />
      <circle cx="15.5" cy="8.5" r="1.4" />
    </svg>
  );
}
