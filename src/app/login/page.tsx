"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Mark, PhoneFrame, Splash } from "@/components/AppShell";
import { Button, Field, inputClass, useToast } from "@/components/ui";
import { isNuEmail } from "@/lib/constants";
import { ActionError, useStore } from "@/lib/store";

type Step = "email" | "code" | "name";
const RESEND_AFTER = 60; // seconds
// Email codes aren't set up yet: in development, sign in with just the email (/api/dev-login)
const DEV_LOGIN = process.env.NEXT_PUBLIC_DEV_LOGIN === "true";

// Supabase Auth sends a one-time code to the Northeastern address; the
// enforce_nu_email trigger rejects any other domain on the server too.
export default function LoginPage() {
  const { ready, me, sendCode, verifyCode, devSignIn, updateName } = useStore();
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  // Already signed in: go home (but not mid-sign-in, which may still ask for a name)
  useEffect(() => {
    if (ready && me && step === "email" && !busy) router.replace("/");
  }, [ready, me, step, busy, router]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Signed-in visitors are redirected; only the email step waits for that check
  if (step === "email" && !busy && (!ready || me)) return <Splash />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ActionError ? friendly(e.message) : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!isNuEmail(clean)) {
      setError("Use your @northeastern.edu email address.");
      return;
    }
    run(async () => {
      setEmail(clean);
      if (DEV_LOGIN) {
        const { isNew } = await devSignIn(clean);
        afterSignIn(isNew, clean);
        return;
      }
      await sendCode(clean);
      setCode("");
      setCooldown(RESEND_AFTER);
      setStep("code");
    });
  };

  // New students pick a display name; returning ones go straight in
  const afterSignIn = (isNew: boolean, forEmail: string) => {
    if (isNew) {
      setName(forEmail.split("@")[0].replace(/[._\d]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()));
      setStep("name");
    } else {
      router.replace("/");
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6,10}$/.test(code)) {
      setError("Enter the code from the email.");
      return;
    }
    run(async () => {
      const { isNew } = await verifyCode(email, code);
      afterSignIn(isNew, email);
    });
  };

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter the name other students will see.");
      return;
    }
    run(async () => {
      await updateName(name);
      router.replace("/");
    });
  };

  const resend = () =>
    run(async () => {
      await sendCode(email);
      setCooldown(RESEND_AFTER);
      toast("New code sent");
    });

  const boxes = Math.max(6, code.length);

  return (
    <PhoneFrame>
      <main className="flex min-h-dvh flex-col px-5 pt-[max(env(safe-area-inset-top),20px)] pb-8">
        <div className="relative mt-1 mb-6 h-[156px]">
          <div className="plane absolute inset-0 [clip-path:polygon(0_22%,100%_0,100%_78%,0_100%)]" />
          <span className="absolute top-1/2 left-1/2 grid size-[76px] -translate-1/2 place-items-center rounded-[24px] bg-bg shadow-[0_16px_30px_-12px_rgba(8,11,19,0.6)]">
            <Mark className="size-9" stroke="url(#hs-grad)" />
          </span>
        </div>

        {step === "name" ? (
          <form onSubmit={submitName} noValidate className="space-y-4">
            <h1 className="text-[23px] leading-tight font-bold">What should we call you?</h1>
            <p className="text-[13.5px] text-muted">Buyers and sellers see this name. You can change it later.</p>
            <Field label="Display name" error={error}>
              <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-invalid={!!error} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Saving…" : "Start browsing"}
            </Button>
          </form>
        ) : (
          <>
            <h1 className="text-[23px] leading-tight font-bold">Buy, sell and borrow on campus</h1>
            <p className="mt-2 mb-5 text-[13.5px] text-muted">
              Only for Northeastern students. Sign in with your school email
              {DEV_LOGIN ? "." : " and we'll send you a code."}
            </p>

            {step === "email" ? (
              <form onSubmit={submitEmail} noValidate className="space-y-4">
                <Field label="Northeastern email" error={error}>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    placeholder="lastname.f@northeastern.edu"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                    aria-invalid={!!error}
                  />
                </Field>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? (DEV_LOGIN ? "Signing in…" : "Sending…") : DEV_LOGIN ? "Continue" : "Send code"}
                </Button>
                {DEV_LOGIN && (
                  <p className="text-center text-[12px] text-muted">Development mode: no email code yet, you&apos;re signed in directly.</p>
                )}
              </form>
            ) : (
              <form onSubmit={submitCode} noValidate>
                <span className="mb-[7px] block text-[12.5px] font-semibold text-muted">Northeastern email</span>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                  className={`${inputClass} flex cursor-pointer items-center justify-between text-left`}
                >
                  <span className="truncate">{email}</span>
                  <span className="text-[12.5px] font-semibold text-cyan">Change</span>
                </button>
                <p className="mt-2.5 mb-3 flex items-center gap-1.5 text-[12.5px] text-green">
                  <Check className="size-4" aria-hidden />
                  Code sent. Check your inbox (and spam).
                </p>
                {/* one real input, drawn as boxes */}
                <label className="group relative mb-2 block">
                  <span className="sr-only">Code from the email</span>
                  <input
                    ref={codeRef}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={10}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="absolute inset-0 z-10 opacity-0"
                    aria-invalid={!!error}
                  />
                  <span aria-hidden className="grid gap-2" style={{ gridTemplateColumns: `repeat(${boxes}, minmax(0, 1fr))` }}>
                    {Array.from({ length: boxes }, (_, i) => (
                      <span
                        key={i}
                        className={`font-display grid h-12 place-items-center rounded-[13px] bg-field text-[19px] font-semibold shadow-inset ${
                          i === Math.min(code.length, boxes - 1)
                            ? "group-focus-within:outline-[1.5px] group-focus-within:-outline-offset-[1.5px] group-focus-within:outline-cyan"
                            : ""
                        }`}
                      >
                        {code[i] ?? ""}
                      </span>
                    ))}
                  </span>
                </label>
                {error && <p className="mb-2 text-[12.5px] text-coral">{error}</p>}
                <Button type="submit" className="mt-3 w-full" disabled={busy}>
                  {busy ? "Checking…" : "Verify and continue"}
                </Button>
                <p className="mt-4 text-center text-[13px] text-muted">
                  Didn&apos;t get it?{" "}
                  {cooldown > 0 ? (
                    <span>Resend in {cooldown}s</span>
                  ) : (
                    <button type="button" onClick={resend} disabled={busy} className="cursor-pointer font-semibold text-fg">
                      Resend code
                    </button>
                  )}
                </p>
              </form>
            )}
          </>
        )}
      </main>
    </PhoneFrame>
  );
}

// Supabase Auth messages, in plain words
function friendly(message: string) {
  if (/expired|invalid/i.test(message)) return "That code is wrong or expired. Check the latest email or resend.";
  if (/rate limit|too many|security purposes/i.test(message)) return "Too many codes requested. Wait a minute and try again.";
  if (/northeastern|database error saving new user/i.test(message)) return "Only @northeastern.edu addresses can sign up.";
  return message;
}
