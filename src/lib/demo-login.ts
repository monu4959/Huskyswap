// Database side of the demo sign-in (src/app/api/demo-login/route.ts): per-IP
// rate limits and the race-safe find-or-create of the account, in one
// transaction on one pooled connection.
//
// Rate limits live in ops.signin_attempts (supabase/migrations/0009_hardening.sql),
// not in memory, because each serverless instance has its own memory.

import pg from "pg";

// Lowercased first; letters/digits separated by single . _ or -
export const NU_EMAIL = /^[a-z0-9]+([._-][a-z0-9]+)*@northeastern\.edu$/;

export type Limits = { perIpPerMinute: number; newAccountsPerIpPerDay: number };

export type Prepared =
  | { ok: true; password: string; created: boolean }
  | { ok: false; reason: "rate_limited" | "new_account_limit" | "not_allowed" };

const intFromEnv = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  return {
    perIpPerMinute: intFromEnv(env.DEMO_LOGIN_PER_IP_PER_MIN, 10),
    newAccountsPerIpPerDay: intFromEnv(env.DEMO_LOGIN_NEW_ACCOUNTS_PER_IP_PER_DAY, 20),
  };
}

// The client's address: first hop of x-forwarded-for, else x-real-ip. On Vercel both
// are set by the edge (a client-sent x-forwarded-for is not passed through as-is).
export function clientIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = first || headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 64);
}

// One connection per serverless instance: sign-ins queue for it rather than each
// opening its own (Supabase's pooler has a small connection budget).
let pool: pg.Pool | null = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10_000,
    });
    // An idle connection dropped by the pooler must not crash the process; the pool replaces it
    pool.on("error", (e) => console.error("demo-login: idle connection error:", e.message));
  }
  return pool;
}

export async function closeDemoLoginPool() {
  await pool?.end();
  pool = null;
}

// Checks the IP's limits, then finds or creates the account for `email` (already
// lowercased and validated) and gives it `password` for this one sign-in.
// Refuses admins and accounts that aren't active.
export async function prepareAccount(email: string, ip: string, password: string, limits: Limits): Promise<Prepared> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    // Serialize attempts from one IP so the count below can't be raced
    await client.query("select pg_advisory_xact_lock(hashtext('demo-login:ip'), hashtext($1))", [ip]);
    if (Math.random() < 0.05) await client.query("delete from ops.signin_attempts where at < now() - interval '1 day'");
    const { rows: [counts] } = await client.query<{ minute: number; created: number }>(
      `select count(*) filter (where at > now() - interval '1 minute')::int as minute,
              count(*) filter (where new_account)::int as created
       from ops.signin_attempts where ip = $1 and at > now() - interval '1 day'`,
      [ip],
    );
    if (counts.minute >= limits.perIpPerMinute) {
      await client.query("rollback");
      return { ok: false, reason: "rate_limited" };
    }

    // Serialize sign-ins for one address: find-or-create can't make two accounts
    await client.query("select pg_advisory_xact_lock(hashtext('demo-login:email'), hashtext($1))", [email]);
    const { rows } = await client.query<{ id: string; role: string | null; account_status: string | null }>(
      `select u.id, p.role::text as role, p.account_status::text as account_status
       from auth.users u left join public.profiles p on p.id = u.id
       where u.email = $1 and u.is_sso_user = false`,
      [email],
    );

    let created = false;
    if (rows.length) {
      const user = rows[0];
      if (user.role === "admin" || (user.account_status !== null && user.account_status !== "active")) {
        // Counts as an attempt, so probing for admins is rate limited too
        await client.query("insert into ops.signin_attempts (ip) values ($1)", [ip]);
        await client.query("commit");
        return { ok: false, reason: "not_allowed" };
      }
      // Existing account (yours, or a seeded student): set a one-time password for this sign-in
      await client.query(
        `update auth.users
         set encrypted_password = crypt($2, gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now())
         where id = $1`,
        [user.id, password],
      );
      await client.query(
        `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         select gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now()
         where not exists (select 1 from auth.identities where user_id = $1::uuid and provider = 'email')`,
        [user.id, email],
      );
    } else {
      if (counts.created >= limits.newAccountsPerIpPerDay) {
        await client.query("rollback");
        return { ok: false, reason: "new_account_limit" };
      }
      // New student: the on_auth_user_created trigger creates their profile
      const { rows: [{ id }] } = await client.query<{ id: string }>(
        `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
           confirmation_token, recovery_token, email_change_token_new, email_change)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1, crypt($2, gen_salt('bf')), now(),
           '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
         returning id`,
        [email, password],
      );
      await client.query(
        `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         values (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now())`,
        [id, email],
      );
      created = true;
    }
    await client.query("insert into ops.signin_attempts (ip, new_account) values ($1, $2)", [ip, created]);
    await client.query("commit");
    return { ok: true, password, created };
  } catch (e) {
    broken = e as Error;
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    // A failed connection is discarded, not reused
    client.release(broken && !(broken instanceof pg.DatabaseError) ? broken : undefined);
  }
}
