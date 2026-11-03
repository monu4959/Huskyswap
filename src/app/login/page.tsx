"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Logo, Splash } from "@/components/AppShell";
import { Husky } from "@/components/Husky";
import { Button, Field, inputClass, useToast } from "@/components/ui";
import { isNuEmail } from "@/lib/constants";
import { ActionError, useStore } from "@/lib/store";

type Step = "email" | "code" | "name";
const RESEND_AFTER = 60; // seconds
// Email codes aren't set up yet: in demo mode no email is sent and any 6-digit code works (/api/demo-login)
const DEMO_LOGIN = process.env.NEXT_PUBLIC_DEMO_LOGIN === "true";

// Supabase Auth sends a one-time code to the Northeastern address; the
// enforce_nu_email trigger rejects any other domain on the server too.
export default function LoginPage() {
  const { ready, me, sendCode, verifyCode, demoSignIn, updateName } = useStore();
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
      if (!DEMO_LOGIN) await sendCode(clean);
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
    if (!(DEMO_LOGIN ? /^\d{6}$/ : /^\d{6,10}$/).test(code)) {
      setError(DEMO_LOGIN ? "Enter any 6 digits." : "Enter the code from the email.");
      return;
    }
    run(async () => {
      const { isNew } = DEMO_LOGIN ? await demoSignIn(email) : await verifyCode(email, code);
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
      if (DEMO_LOGIN) {
        toast("Demo mode: no email is sent. Enter any 6 digits.");
        return;
      }
      await sendCode(email);
      setCooldown(RESEND_AFTER);
      toast("New code sent");
    });

  const boxes = Math.max(6, code.length);

  return (
    <main className="flex min-h-dvh flex-col bg-bg md:grid md:grid-cols-2 lg:grid-cols-[1.05fr_1fr]">
      {/* brand side: a calm intro with the husky (a compact header on phones) */}
      <div className="relative overflow-hidden px-6 pt-[calc(max(env(safe-area-inset-top),16px)+12px)] pb-6 md:m-4 md:flex md:flex-col md:rounded-sheet md:bg-surface md:p-12 md:shadow-raise lg:p-16">
        <Logo className="text-[24px] md:text-[26px]" />
        <div className="mt-10 md:my-auto md:pt-10">
          {/* the headline lives here until the name step, which asks its own question */}
          {step === "name" ? (
            <p className="font-display max-w-[12ch] text-[2.5rem] leading-[1.04] font-medium tracking-[-0.02em] lg:text-[3.5rem]">Buy, sell and borrow on campus</p>
          ) : (
            <h1 className="max-w-[12ch] text-[2.5rem] leading-[1.04] lg:text-[3.5rem]">Buy, sell and borrow on campus</h1>
          )}
          <p className="mt-4 max-w-[38ch] text-body text-muted md:text-lead">
            The marketplace for Northeastern students. Textbooks, dorm gear and bikes from people on your campus.
          </p>
          <ul className="mt-8 hidden gap-3 text-small md:grid">
            {["Only @northeastern.edu accounts", "Meet at campus spots, pay in person", "Rent things for a week, deposit back on return"].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent-ink">
                  <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <Husky className="pointer-events-none absolute right-6 bottom-0 hidden size-52 md:block lg:size-60" />
      </div>

      <div className="flex items-start justify-center px-6 pb-10 md:items-center md:px-10">
        <div className="w-full max-w-[420px] md:rounded-sheet md:bg-surface md:p-8 md:shadow-raise">
        {step === "name" ? (
          <form onSubmit={submitName} noValidate className="space-y-4">
            <h1 className="text-title">What should we call you?</h1>
            <p className="text-small text-muted">Buyers and sellers see this name. You can change it later.</p>
            <Field label="Display name" error={error}>
              <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-invalid={!!error} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Saving…" : "Start browsing"}
            </Button>
          </form>
        ) : (
          <>
            <p className="mb-5 text-body text-muted">
              Only for Northeastern students. Sign in with your school email and we&apos;ll send you a code.
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
                  {busy ? "Sending…" : "Send code"}
                </Button>
              </form>
            ) : (
              <form onSubmit={submitCode} noValidate>
                <span className="mb-2 block text-small font-semibold">Northeastern email</span>
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
                  <span className="text-small font-semibold text-accent-ink">Change</span>
                </button>
                {DEMO_LOGIN ? (
                  <p className="mt-3 mb-4 rounded-field bg-accent-soft px-3.5 py-2.5 text-small text-accent-ink">
                    Demo mode: no email is sent. Enter any 6 digits to sign in.
                  </p>
                ) : (
                  <p className="mt-2.5 mb-3 flex items-center gap-1.5 text-small text-green">
                    <Check className="size-4" aria-hidden />
                    Code sent. Check your inbox (and spam).
                  </p>
                )}
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
                        className={`grid h-14 place-items-center rounded-field bg-field text-[1.6rem] font-bold ${
                          i === Math.min(code.length, boxes - 1)
                            ? "group-focus-within:bg-surface group-focus-within:outline-2 group-focus-within:-outline-offset-2 group-focus-within:outline-accent-ink"
                            : ""
                        }`}
                      >
                        {code[i] ?? ""}
                      </span>
                    ))}
                  </span>
                </label>
                {error && <p className="mb-2 text-small text-coral">{error}</p>}
                <Button type="submit" className="mt-3 w-full" disabled={busy}>
                  {busy ? "Checking…" : "Verify and continue"}
                </Button>
                <p className="mt-4 text-center text-small text-muted">
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
          {/* on phones the husky greets you under the form */}
          <Husky animated className="mx-auto mt-12 size-28 md:hidden" />
        </div>
      </div>
    </main>
  );
}

// Supabase Auth messages, in plain words
function friendly(message: string) {
  if (/expired|invalid/i.test(message)) return "That code is wrong or expired. Check the latest email or resend.";
  if (/rate limit|too many|security purposes/i.test(message)) return "Too many codes requested. Wait a minute and try again.";
  if (/northeastern|database error saving new user/i.test(message)) return "Only @northeastern.edu addresses can sign up.";
  return message;
}
