// DEMO SIGN-IN: any @northeastern.edu email gets in; the app's code screen
// accepts any 6 digits. Stand-in until real email codes are set up (Supabase
// email template + Resend). Turn it on with DEMO_LOGIN=true (and
// NEXT_PUBLIC_DEMO_LOGIN=true for the screens); without it this route is a 404.
//
// It finds or creates the account directly in the database, gives it a fresh
// random password, signs in with that password, and returns the session. Because
// it never proves the person owns the email, anyone can sign in as any
// Northeastern address while it's on (an accepted risk for the demo). Admin
// accounts and suspended or deactivated ones can't sign in here, and each IP is
// rate limited (src/lib/demo-login.ts).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NU_EMAIL, clientIp, limitsFromEnv, prepareAccount } from "@/lib/demo-login";

function enabled() {
  return process.env.DEMO_LOGIN === "true";
}

const REFUSED: Record<"rate_limited" | "new_account_limit" | "not_allowed", [string, number]> = {
  rate_limited: ["Too many sign-in attempts. Try again in a minute.", 429],
  new_account_limit: ["Too many new accounts from this network today. Try again tomorrow.", 429],
  not_allowed: ["This account can't sign in here.", 403],
};

export async function POST(request: Request) {
  if (!enabled()) return new Response("Not found", { status: 404 });

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !NU_EMAIL.test(email)) {
    return Response.json({ error: "Use your @northeastern.edu email address." }, { status: 400 });
  }

  let password: string;
  try {
    const prepared = await prepareAccount(email, clientIp(request.headers), randomUUID(), limitsFromEnv());
    if (!prepared.ok) {
      const [error, status] = REFUSED[prepared.reason];
      return Response.json({ error }, { status });
    }
    password = prepared.password;
  } catch (e) {
    console.error("demo-login: couldn't prepare the account:", e);
    return Response.json({ error: "Sign-in isn't working right now. Try again in a minute." }, { status: 500 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    console.error("demo-login: sign-in failed:", error?.message ?? "no session");
    return Response.json({ error: "Sign-in failed. Try again in a minute." }, { status: 500 });
  }
  return Response.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
}
