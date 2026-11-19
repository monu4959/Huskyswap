// /api/ask limits: reserveAsk / finishAsk (src/lib/agent/log.ts) against a fake pg
// pool whose advisory lock really serializes, and the route's use of them: the
// reservation happens before the run, a second concurrent question is refused, a
// failed or cancelled run still releases (and keeps) its slot. No database, model or
// network is touched.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/lib/agent/types.ts";

// ---- fake ops database: ops.ask_quota rows and a per-key advisory lock ----
type Row = { id: number; user_id: string; started_at: number; finished_at: number | null; run_id: string | null };
const fake = vi.hoisted(() => {
  const state = { rows: [] as Row[], nextId: 1, now: Date.now(), failOn: null as RegExp | null, locks: new Map<string, Promise<void>>() };
  const sqlLog: string[] = [];
  function client() {
    let release: (() => void) | null = null;
    return {
      release: vi.fn(),
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        sqlLog.push(sql.replace(/\s+/g, " ").trim());
        if (state.failOn?.test(sql)) throw new Error("boom");
        if (/pg_advisory_xact_lock/.test(sql)) {
          const key = String(params[0]);
          while (state.locks.has(key)) await state.locks.get(key);
          state.locks.set(key, new Promise<void>((r) => (release = () => { state.locks.delete(key); r(); })));
          return { rows: [] };
        }
        if (sql === "commit" || sql === "rollback") {
          release?.();
          release = null;
          return { rows: [] };
        }
        if (/from ops\.ask_quota/.test(sql) && /count\(\*\)/.test(sql)) {
          const [userId, inFlightSecs] = params as [string, number];
          const mine = state.rows.filter((r) => r.user_id === userId && r.started_at > state.now - 86_400_000);
          const counts = {
            running: mine.filter((r) => r.finished_at === null && r.started_at > state.now - inFlightSecs * 1000).length,
            minute: mine.filter((r) => r.started_at > state.now - 60_000).length,
            day: mine.length,
          };
          // Read now, answer later: without the lock, parallel callers all see the same snapshot
          await new Promise((r) => setTimeout(r, 2));
          return { rows: [counts] };
        }
        if (/insert into ops\.ask_quota/.test(sql)) {
          const row = { id: state.nextId++, user_id: params[0] as string, started_at: state.now, finished_at: null, run_id: null };
          state.rows.push(row);
          return { rows: [{ id: String(row.id) }] };
        }
        if (/update ops\.ask_quota set finished_at/.test(sql)) {
          const row = state.rows.find((r) => String(r.id) === params[0]);
          if (row) Object.assign(row, { finished_at: state.now, run_id: params[1] });
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }
  const pool = { connect: vi.fn(async () => client()), query: vi.fn((sql: string, params?: unknown[]) => client().query(sql, params)) };
  return { state, sqlLog, pool };
});
vi.mock("@/lib/agent/ops-db.ts", () => ({ opsPool: () => fake.pool }));

const { reserveAsk, finishAsk, IN_FLIGHT_MS } = await import("@/lib/agent/log.ts");
const LIMITS = { perMinute: 3, perDay: 40 };

beforeEach(() => {
  fake.state.rows = [];
  fake.state.nextId = 1;
  fake.state.now = Date.now();
  fake.state.failOn = null;
  fake.state.locks.clear();
  fake.sqlLog.length = 0;
});

const past = (userId: string, agoMs: number, finished = true) =>
  fake.state.rows.push({ id: fake.state.nextId++, user_id: userId, started_at: fake.state.now - agoMs, finished_at: finished ? fake.state.now - agoMs + 1000 : null, run_id: null });

describe("reserveAsk", () => {
  it("reserves a slot: lock, count, insert, commit, in that order", async () => {
    expect(await reserveAsk("u1", LIMITS)).toEqual({ ok: true, id: "1" });
    const at = (re: RegExp) => fake.sqlLog.findIndex((s) => re.test(s));
    expect(fake.sqlLog[0]).toBe("begin");
    expect(at(/pg_advisory_xact_lock/)).toBeLessThan(at(/count\(\*\)/));
    expect(at(/count\(\*\)/)).toBeLessThan(at(/insert into ops\.ask_quota/));
    expect(fake.sqlLog.at(-1)).toBe("commit");
    expect(fake.state.rows).toHaveLength(1);
  });

  it("one question at a time: a run in flight blocks the next", async () => {
    past("u1", 5_000, false);
    expect(await reserveAsk("u1", LIMITS)).toEqual({ ok: false, reason: "busy" });
    expect(fake.sqlLog.at(-1)).toBe("rollback");
    expect(fake.state.rows).toHaveLength(1);
  });

  it("a reservation left open past the function's lifetime (killed run) stops blocking but still counts", async () => {
    past("u1", IN_FLIGHT_MS + 1_000, false);
    expect((await reserveAsk("u1", LIMITS)).ok).toBe(true);
    for (let i = 0; i < 38; i++) past("u1", 3_600_000);
    // 1 killed + 1 just reserved + 38 = 40: the day is used up
    fake.state.rows.find((r) => r.id === 2)!.finished_at = fake.state.now;
    expect(await reserveAsk("u1", LIMITS)).toEqual({ ok: false, reason: "day" });
  });

  it(`at most ${LIMITS.perMinute} a minute and ${LIMITS.perDay} a day`, async () => {
    for (let i = 0; i < 3; i++) past("u1", 10_000);
    expect(await reserveAsk("u1", LIMITS)).toEqual({ ok: false, reason: "minute" });
    fake.state.rows = [];
    for (let i = 0; i < 40; i++) past("u1", 3_600_000);
    expect(await reserveAsk("u1", LIMITS)).toEqual({ ok: false, reason: "day" });
    expect((await reserveAsk("someone-else", LIMITS)).ok).toBe(true);
  });

  it("parallel requests from one student: exactly one gets through", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveAsk("u1", LIMITS)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(7);
    expect(fake.state.rows).toHaveLength(1);
  });

  it("parallel requests can't exceed the per-minute limit either", async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 4 }, () => reserveAsk("u1", LIMITS)));
      for (const r of fake.state.rows) r.finished_at ??= fake.state.now;
    }
    expect(fake.state.rows).toHaveLength(3);
  });

  it("a database error rolls back, discards the connection and is rethrown", async () => {
    fake.state.failOn = /insert into ops\.ask_quota/;
    await expect(reserveAsk("u1", LIMITS)).rejects.toThrow("boom");
    expect(fake.sqlLog.at(-1)).toBe("rollback");
    const client = await fake.pool.connect.mock.results[0].value;
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("finishAsk closes the reservation with its run id", async () => {
    const r = await reserveAsk("u1", LIMITS);
    await finishAsk((r as { id: string }).id, "run-9");
    expect(fake.state.rows[0]).toMatchObject({ finished_at: fake.state.now, run_id: "run-9" });
    expect((await reserveAsk("u1", LIMITS)).ok).toBe(true);
  });
});

// ---- the route ----
const r = vi.hoisted(() => ({
  askerFrom: vi.fn(),
  reserveAsk: vi.fn(),
  finishAsk: vi.fn(),
  runAgent: vi.fn(),
  route: vi.fn(),
  fallback: vi.fn(),
  markDown: vi.fn(),
}));

describe("POST /api/ask", async () => {
  vi.doMock("@/lib/agent/auth", () => ({ askerFrom: r.askerFrom }));
  vi.doMock("@/lib/agent/log", () => ({ reserveAsk: r.reserveAsk, finishAsk: r.finishAsk }));
  vi.doMock("@/lib/agent/graph", () => ({ runAgent: r.runAgent }));
  vi.doMock("@/lib/agent/serving", () => ({ route: r.route, fallback: r.fallback, markDown: r.markDown }));
  const { POST } = await import("@/app/api/ask/route.ts");

  const STUDENT = { label: "student", model: "s" };
  const TEACHER = { label: "teacher", model: "t" };
  const run = (o: Partial<AgentRun> = {}): AgentRun => ({
    runId: "run-1", question: "q", resolvedQuestion: null, role: "nlq_student", status: "answered", answer: "42", finalSql: "select 42",
    result: { ok: true, columns: ["n"], rows: [{ n: 42 }], rowCount: 1, truncated: false }, clarification: null, cacheHit: false, grounded: true,
    retrieval: null, nodes: [], calls: [], messages: [], sqlErrors: 0, promptTokens: 0, completionTokens: 0, latencyMs: 5, error: null, ...o,
  });
  const ask = (signal?: AbortSignal) =>
    POST(new Request("http://localhost/api/ask", { method: "POST", body: JSON.stringify({ question: "how many bikes?" }), signal }));
  const events = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

  beforeEach(() => {
    for (const fn of Object.values(r)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    r.askerFrom.mockResolvedValue({ userId: "u1", role: "nlq_student" });
    r.reserveAsk.mockResolvedValue({ ok: true, id: "slot-7" });
    r.finishAsk.mockResolvedValue(undefined);
    r.route.mockResolvedValue({ model: STUDENT, arm: "production", modelId: "student-1" });
    r.fallback.mockReturnValue({ model: TEACHER, arm: "fallback", modelId: "teacher" });
    r.runAgent.mockResolvedValue(run());
  });

  it.each([
    ["busy", "One question at a time: wait for the current answer."],
    ["minute", "One moment: try again in a minute."],
    ["day", "That's today's limit. Ask again tomorrow."],
  ] as const)("refused reservation (%s) is a 429 and no run starts", async (reason, error) => {
    r.reserveAsk.mockResolvedValue({ ok: false, reason });
    const res = await ask();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error });
    expect(r.runAgent).not.toHaveBeenCalled();
    expect(r.finishAsk).not.toHaveBeenCalled();
  });

  it("reserves with the route's limits (3 a minute, 40 a day) before running", async () => {
    await events(await ask());
    expect(r.reserveAsk).toHaveBeenCalledWith("u1", { perMinute: 3, perDay: 40 });
    expect(r.reserveAsk.mock.invocationCallOrder[0]).toBeLessThan(r.runAgent.mock.invocationCallOrder[0]);
  });

  it("can't reserve (database down): 503, no run", async () => {
    r.reserveAsk.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await ask();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/ECONN/);
    expect(r.runAgent).not.toHaveBeenCalled();
  });

  it("answers, then finishes the reservation with the run id; passes the request's abort signal", async () => {
    const done = (await events(await ask())).at(-1);
    expect(done).toMatchObject({ type: "done", status: "answered", answer: "42", runId: "run-1" });
    expect(r.finishAsk).toHaveBeenCalledWith("slot-7", "run-1");
    expect(r.runAgent.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it("a run that throws still finishes its reservation", async () => {
    r.runAgent.mockRejectedValue(new Error("unexpected"));
    const res = await ask();
    await res.text().catch(() => "");
    await vi.waitFor(() => expect(r.finishAsk).toHaveBeenCalledWith("slot-7", null));
  });

  it("the student model failing falls back to the teacher (same reservation)", async () => {
    r.runAgent.mockResolvedValueOnce(run({ status: "error", error: "502", runId: "run-a" })).mockResolvedValueOnce(run({ runId: "run-b" }));
    await events(await ask());
    expect(r.runAgent).toHaveBeenCalledTimes(2);
    expect(r.markDown).toHaveBeenCalledWith(STUDENT);
    expect(r.reserveAsk).toHaveBeenCalledTimes(1);
    expect(r.finishAsk).toHaveBeenCalledWith("slot-7", "run-b");
  });

  it("a client that disconnected gets no fallback run", async () => {
    const controller = new AbortController();
    r.runAgent.mockImplementation(async () => {
      controller.abort();
      return run({ status: "error", error: "Cancelled: the client disconnected" });
    });
    const res = await ask(controller.signal);
    await res.text().catch(() => "");
    await vi.waitFor(() => expect(r.finishAsk).toHaveBeenCalled());
    expect(r.runAgent).toHaveBeenCalledTimes(1);
    expect(r.markDown).not.toHaveBeenCalled();
  });
});
