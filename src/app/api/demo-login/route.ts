// DEMO SIGN-IN: any @northeastern.edu email gets in; the app's code screen
// accepts any 6 digits. Stand-in until real email codes are set up (Supabase
// email template + Resend). Turn it on with DEMO_LOGIN=true (and
// NEXT_PUBLIC_DEMO_LOGIN=true for the screens); without it this route is a 404.
//
// It finds or creates the account directly in the database, gives it a fresh
// random password, signs in with that password, and returns the session. Because
// it never proves the person owns the email, anyone can sign in as any
// Northeastern address while it's on. Fine for a demo with synthetic data;
// turn it off before real students use the app.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const NU_EMAIL = /^[^@\s]+@northeastern\.edu$/;

function enabled() {
  return process.env.DEMO_LOGIN === "true";
}

export async function POST(request: Request) {
  if (!enabled()) return new Response("Not found", { status: 404 });

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!NU_EMAIL.test(email)) {
    return Response.json({ error: "Use your @northeastern.edu email address." }, { status: 400 });
  }

  const password = randomUUID();
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    const { rows } = await db.query("select id from auth.users where lower(email) = $1", [email]);
    if (rows.length) {
      // Existing account (yours, or a seeded student): set a one-time password for this sign-in
      await db.query(
        `update auth.users
         set encrypted_password = crypt($2, gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now())
         where id = $1`,
        [rows[0].id, password],
      );
      await db.query(
        `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         select gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now()
         where not exists (select 1 from auth.identities where user_id = $1::uuid and provider = 'email')`,
        [rows[0].id, email],
      );
    } else {
      // New student: the on_auth_user_created trigger creates their profile
      const id = randomUUID();
      await db.query(
        `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
           confirmation_token, recovery_token, email_change_token_new, email_change)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(),
           '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`,
        [id, email, password],
      );
      await db.query(
        `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         values (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now())`,
        [id, email],
      );
    }
  } catch (e) {
    return Response.json({ error: `Couldn't prepare the account: ${(e as Error).message}` }, { status: 500 });
  } finally {
    await db.end().catch(() => {});
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return Response.json({ error: error?.message ?? "Sign-in failed." }, { status: 500 });
  }
  return Response.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
}
