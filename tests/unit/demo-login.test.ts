// POST /api/demo-login with a fake pg pool and a fake Supabase client: email
// validation, the admin / inactive-account refusal, per-IP rate limits, race-safe
// find-or-create (locks before the lookup, one transaction), generic errors, and the
// single shared connection. No database or network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class DatabaseError extends Error {}
  const client = { query: vi.fn(), release: vi.fn() };
  const pool = { connect: vi.fn(), on: vi.fn(), end: vi.fn(async () => {}) };
  const Pool = vi.fn(function () {
    return pool;
  });
  const signInWithPassword = vi.fn();
  const createClient = vi.fn(() => ({ auth: { signInWithPassword } }));
  return { DatabaseError, client, pool, Pool, signInWithPassword, createClient };
});
vi.mock("pg", () => ({ default: { Pool: h.Pool, DatabaseError: h.DatabaseError } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: h.createClient }));

const { POST } = await import("@/app/api/demo-login/route.ts");
const { NU_EMAIL, clientIp, closeDemoLoginPool, limitsFromEnv } = await import("@/lib/demo-login.ts");

// What the fake database holds for this test
type User = { id: string; role: string | null; account_status: string | null };
let users: Record<string, User>;
let counts: { minute: number; created: number };
let failOn: RegExp | null;

beforeEach(() => {
  vi.stubEnv("DEMO_LOGIN", "true");
  vi.stubEnv("DATABASE_URL", "postgres://unit-test.invalid/db");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key");
  vi.stubEnv("DEMO_LOGIN_PER_IP_PER_MIN", "");
  vi.stubEnv("DEMO_LOGIN_NEW_ACCOUNTS_PER_IP_PER_DAY", "");
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no opportunistic pruning unless a test asks
  vi.spyOn(console, "error").mockImplementation(() => {});
  users = {};
  counts = { minute: 0, created: 0 };
  failOn = null;
  h.Pool.mockClear();
  h.pool.on.mockClear();
  h.pool.connect.mockReset().mockResolvedValue(h.client);
  h.client.release.mockReset();
  h.client.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (failOn?.test(sql)) throw new Error("connection terminated: secret-host:5432");
    if (/from ops\.signin_attempts/.test(sql)) return { rows: [counts] };
    if (/from auth\.users u/.test(sql)) {
      const u = users[params[0] as string];
      return { rows: u ? [u] : [] };
    }
    if (/insert into auth\.users/.test(sql)) return { rows: [{ id: "new-user-id" }] };
    return { rows: [], rowCount: 1 };
  });
  h.signInWithPassword.mockReset().mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt" } }, error: null });
});
afterEach(async () => {
  await closeDemoLoginPool();
  vi.restoreAllMocks();
});

const post = (email: unknown, headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }) =>
  POST(new Request("http://localhost/api/demo-login", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ email }) }));
const sqls = () => h.client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " ").trim());
const callsMatching = (re: RegExp) => h.client.query.mock.calls.filter((c) => re.test(String(c[0])));

describe("demo-login: switched off", () => {
  it("is a 404 without DEMO_LOGIN=true and touches nothing", async () => {
    vi.stubEnv("DEMO_LOGIN", "false");
    expect((await post("a.b@northeastern.edu")).status).toBe(404);
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});

describe("demo-login: email validation", () => {
  it.each(["bob.smith@northeastern.edu", "smith.b@northeastern.edu", "a_b-c.d9@northeastern.edu", "x@northeastern.edu"])("accepts %j", (email) => {
    expect(NU_EMAIL.test(email)).toBe(true);
  });

  it.each([
    "a..b@northeastern.edu", ".a@northeastern.edu", "a.@northeastern.edu", "a b@northeastern.edu", "<script>@northeastern.edu",
    "a+tag@northeastern.edu", "a@northeastern.edu.evil.com", "a@sub.northeastern.edu", "a@northeastern-edu", "@northeastern.edu",
    "a'--@northeastern.edu", "A@northeastern.edu",
  ])("rejects %j", (email) => {
    expect(NU_EMAIL.test(email)).toBe(false);
  });

  it("lowercases before checking, and answers bad input with 400 without connecting", async () => {
    expect((await post("Bob.Smith@NORTHEASTERN.EDU")).status).toBe(200);
    expect(h.signInWithPassword).toHaveBeenCalledWith(expect.objectContaining({ email: "bob.smith@northeastern.edu" }));
    h.pool.connect.mockClear();
    for (const bad of ["evil@gmail.com", 42, null, `${"a".repeat(250)}@northeastern.edu`]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Use your @northeastern.edu email address." });
    }
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});

describe("demo-login: who may sign in", () => {
  it.each([
    ["an admin", { id: "u1", role: "admin", account_status: "active" }],
    ["a suspended student", { id: "u1", role: "student", account_status: "suspended" }],
    ["a deactivated student", { id: "u1", role: "student", account_status: "deactivated" }],
  ])("refuses %s with a generic 403 and doesn't touch the account", async (_label, user) => {
    users["boss@northeastern.edu"] = user;
    const res = await post("boss@northeastern.edu");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This account can't sign in here." });
    expect(callsMatching(/update auth\.users/)).toHaveLength(0);
    expect(callsMatching(/insert into auth\./)).toHaveLength(0);
    expect(h.signInWithPassword).not.toHaveBeenCalled();
    // The refused attempt still counts toward the IP's rate limit
    expect(callsMatching(/insert into ops\.signin_attempts/)).toHaveLength(1);
    expect(sqls().at(-1)).toBe("commit");
  });

  it("an active student gets a one-time password and signs in with it", async () => {
    users["bob.smith@northeastern.edu"] = { id: "u1", role: "student", account_status: "active" };
    const res = await post("bob.smith@northeastern.edu");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "at", refresh_token: "rt" });
    const [update] = callsMatching(/update auth\.users/);
    const password = (update[1] as string[])[1];
    expect(update[1]).toEqual(["u1", password]);
    expect(h.signInWithPassword).toHaveBeenCalledWith({ email: "bob.smith@northeastern.edu", password });
    expect(callsMatching(/insert into auth\.users/)).toHaveLength(0);
    expect(callsMatching(/insert into ops\.signin_attempts/)[0][1]).toEqual(["203.0.113.7", false]);
  });

  it("a new address gets an account, recorded as a new account for the IP", async () => {
    const res = await post("new.student@northeastern.edu");
    expect(res.status).toBe(200);
    expect(callsMatching(/insert into auth\.users/)).toHaveLength(1);
    expect(callsMatching(/insert into auth\.identities/)[0][1]).toEqual(["new-user-id", "new.student@northeastern.edu"]);
    expect(callsMatching(/insert into ops\.signin_attempts/)[0][1]).toEqual(["203.0.113.7", true]);
  });

  it("looks the address up exactly (indexable), after taking the IP and email locks, in one transaction", async () => {
    users["bob.smith@northeastern.edu"] = { id: "u1", role: "student", account_status: "active" };
    await post("bob.smith@northeastern.edu");
    const all = sqls();
    const at = (re: RegExp) => all.findIndex((s) => re.test(s));
    expect(all[0]).toBe("begin");
    expect(at(/pg_advisory_xact_lock\(hashtext\('demo-login:ip'\)/)).toBeLessThan(at(/from ops\.signin_attempts/));
    expect(at(/pg_advisory_xact_lock\(hashtext\('demo-login:email'\)/)).toBeLessThan(at(/from auth\.users u/));
    expect(all.find((s) => /from auth\.users u/.test(s))).toMatch(/where u\.email = \$1 and u\.is_sso_user = false/);
    expect(all.filter((s) => s === "begin")).toHaveLength(1);
    expect(all.at(-1)).toBe("commit");
    expect(callsMatching(/demo-login:email/)[0][1]).toEqual(["bob.smith@northeastern.edu"]);
    expect(h.client.release).toHaveBeenCalledWith(undefined);
  });
});

describe("demo-login: per-IP rate limits", () => {
  it("defaults to 10 attempts a minute and 20 new accounts a day, overridable from the environment", () => {
    expect(limitsFromEnv({})).toEqual({ perIpPerMinute: 10, newAccountsPerIpPerDay: 20 });
    expect(limitsFromEnv({ DEMO_LOGIN_PER_IP_PER_MIN: "1000", DEMO_LOGIN_NEW_ACCOUNTS_PER_IP_PER_DAY: "100000" })).toEqual({
      perIpPerMinute: 1000, newAccountsPerIpPerDay: 100000,
    });
    expect(limitsFromEnv({ DEMO_LOGIN_PER_IP_PER_MIN: "abc", DEMO_LOGIN_NEW_ACCOUNTS_PER_IP_PER_DAY: "-5" })).toEqual({ perIpPerMinute: 10, newAccountsPerIpPerDay: 20 });
  });

  it("the 11th attempt in a minute is a 429, before any account lookup", async () => {
    counts = { minute: 10, created: 0 };
    users["bob.smith@northeastern.edu"] = { id: "u1", role: "student", account_status: "active" };
    const res = await post("bob.smith@northeastern.edu");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many sign-in attempts. Try again in a minute." });
    expect(callsMatching(/from auth\.users u/)).toHaveLength(0);
    expect(sqls().at(-1)).toBe("rollback");
  });

  it("uses the limit from the environment", async () => {
    vi.stubEnv("DEMO_LOGIN_PER_IP_PER_MIN", "1000");
    counts = { minute: 500, created: 0 };
    expect((await post("bob.smith@northeastern.edu")).status).toBe(200);
  });

  it("past the daily new-account limit: new addresses are refused, existing ones still sign in", async () => {
    counts = { minute: 0, created: 20 };
    const res = await post("another.new@northeastern.edu");
    expect(res.status).toBe(429);
    expect(callsMatching(/insert into auth\.users/)).toHaveLength(0);
    users["bob.smith@northeastern.edu"] = { id: "u1", role: "student", account_status: "active" };
    expect((await post("bob.smith@northeastern.edu")).status).toBe(200);
  });

  it("counts attempts per IP: x-forwarded-for's first hop, then x-real-ip", async () => {
    await post("bob.smith@northeastern.edu", { "x-real-ip": "198.51.100.4" });
    expect(callsMatching(/from ops\.signin_attempts/)[0][1]).toEqual(["198.51.100.4"]);
    const ip = (headers: Record<string, string>) => clientIp(new Headers(headers));
    expect(ip({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1", "x-real-ip": "1.1.1.1" })).toBe("203.0.113.7");
    expect(ip({ "x-real-ip": "1.1.1.1" })).toBe("1.1.1.1");
    expect(ip({})).toBe("unknown");
    expect(ip({ "x-forwarded-for": "x".repeat(500) })).toHaveLength(64);
  });

  it("now and then prunes attempts older than a day", async () => {
    vi.mocked(Math.random).mockReturnValue(0.01);
    await post("bob.smith@northeastern.edu");
    expect(callsMatching(/delete from ops\.signin_attempts where at < now\(\) - interval '1 day'/)).toHaveLength(1);
  });
});

describe("demo-login: failures", () => {
  it("a database error is a generic 500 (details only in the server log), rolled back, connection discarded", async () => {
    failOn = /from auth\.users u/;
    const res = await post("bob.smith@northeastern.edu");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Sign-in isn't working right now. Try again in a minute." });
    expect(JSON.stringify(body)).not.toMatch(/secret-host|connection/);
    expect(console.error).toHaveBeenCalled();
    expect(sqls().at(-1)).toBe("rollback");
    expect(h.client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("no free connection within the timeout is the same generic 500", async () => {
    h.pool.connect.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
    const res = await post("bob.smith@northeastern.edu");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Sign-in isn't working right now. Try again in a minute.");
  });

  it("a failed Supabase sign-in is a generic 500", async () => {
    h.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: "Database error querying schema" } });
    const res = await post("bob.smith@northeastern.edu");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Sign-in failed. Try again in a minute." });
  });
});

describe("demo-login: connections", () => {
  it("shares one pool of a single connection, with a connect timeout and an error handler", async () => {
    await post("a.one@northeastern.edu");
    await post("a.two@northeastern.edu");
    expect(h.Pool).toHaveBeenCalledTimes(1);
    expect(h.Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000 }));
    expect(h.pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(h.client.release).toHaveBeenCalledTimes(2);
  });
});
