// Load test: N virtual students using HuskySwap at once, against the LOCAL stack only.
//
//   npm run test:env -- node scripts/load-test.mjs --users 50 --minutes 10 --ramp 30 \
//     [--app http://localhost:3100] [--ask-app http://localhost:3101 --stub http://127.0.0.1:8787] \
//     [--out <dir>] [--label run50] [--signin-gap-ms 0]
//
// Each virtual user does what the browser does (src/lib/store.tsx):
//   * arrival: GET / and every JS/CSS asset it references, POST /api/demo-login, auth.setSession,
//     the "is this a new account" profile read, then the store's sign-in load (profiles, saved,
//     deals, conversations + messages, my reviews, profile_ratings, then items).
//   * one realtime channel `student-<uid>` (messages INSERT, transactions *) for the whole test,
//     with the same refreshes the store runs on each event (refreshChats / refreshDeals + refreshItems).
//   * a loop with 2-8 s think time: ~50% browse/search/open item (client navigation = RSC fetch +
//     images), 15% save toggle, 20% chat with a partner (open_conversation + insert message; the
//     partner replies when the message reaches its subscription), 10% deal steps (sale: request ->
//     accept -> hand_over -> confirm_received, both sides), 5% create listing (rpc create_listing,
//     a quarter with a photo uploaded to item-images/<uid>/).
//   * optionally 1-3 questions to the assistant (/api/ask on --ask-app), at most 3 a minute.
// A monitor samples pg_stat_activity, docker stats, the app processes and this process every 10 s.
//
// Never point this at production: it refuses any non-local URL.

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Options and safety
// ---------------------------------------------------------------------------
const { values: A } = parseArgs({
  options: {
    users: { type: "string", default: "50" },
    minutes: { type: "string", default: "10" },
    ramp: { type: "string", default: "30" }, // seconds over which users arrive
    app: { type: "string", default: "http://localhost:3100" },
    "ask-app": { type: "string" },
    stub: { type: "string" },
    "ask-min": { type: "string", default: "1" },
    "ask-max": { type: "string", default: "3" },
    out: { type: "string", default: "load-results" },
    label: { type: "string", default: "run" },
    "signin-gap-ms": { type: "string", default: "0" }, // minimum gap between sign-ins (rate-limit friendly)
    "user-offset": { type: "string", default: "0" },
    sample: { type: "string", default: "10" },
    "think-min": { type: "string", default: "2" },
    "think-max": { type: "string", default: "8" },
    // incremental: what src/lib/store.tsx does now (merge realtime rows, fetch only what's missing);
    // legacy: the old store (refetch all chats / all deals on every event), for comparison
    store: { type: "string", default: "incremental" },
  },
});
const USERS = Number(A.users);
const INCREMENTAL = A.store !== "legacy";
const DURATION_MS = Number(A.minutes) * 60_000;
const RAMP_MS = Number(A.ramp) * 1000;
const APP = A.app.replace(/\/$/, "");
const ASK_APP = A["ask-app"]?.replace(/\/$/, "") ?? null;
const STUB = A.stub?.replace(/\/$/, "") ?? null;
const SAMPLE_MS = Number(A.sample) * 1000;
const THINK = [Number(A["think-min"]) * 1000, Number(A["think-max"]) * 1000];
const OUT = A.out;
const LABEL = A.label;

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const DB_URL = process.env.DATABASE_URL;
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
for (const [name, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: SB_URL, DATABASE_URL: DB_URL, app: APP, "ask-app": ASK_APP, stub: STUB })) {
  if (!value) {
    if (["app", "ask-app", "stub"].includes(name)) continue;
    console.error(`Missing ${name}. Run through: npm run test:env -- node scripts/load-test.mjs ...`);
    process.exit(2);
  }
  if (!LOCAL.has(new URL(value).hostname)) {
    console.error(`Refusing: ${name} is not local (${new URL(value).hostname}).`);
    process.exit(2);
  }
}
if (!SB_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
const T0 = performance.now();
const now = () => performance.now();
const since = () => (now() - T0) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const ops = new Map(); // op -> { lat: number[], ok, err, business, rateLimited }
const errors = new Map(); // "op | class | message" -> count
const windows = []; // per 10 s: { t, n, err, lat: [] }
const LOCAL_OPS = new Set(["search_local"]); // no network: excluded from the DB/API gate

function windowNow() {
  const idx = Math.floor((now() - T0) / 10_000);
  while (windows.length <= idx) windows.push({ t: windows.length * 10, n: 0, err: 0, lat: [] });
  return windows[idx];
}

// kind: ok | system | business | ratelimit
function rec(op, ms, kind = "ok", message = "") {
  let o = ops.get(op);
  if (!o) ops.set(op, (o = { lat: [], ok: 0, err: 0, business: 0, rateLimited: 0 }));
  o.lat.push(ms);
  const w = windowNow();
  w.n++;
  w.lat.push(ms);
  if (kind === "ok") o.ok++;
  else {
    if (kind === "business") o.business++;
    else if (kind === "ratelimit") o.rateLimited++;
    else {
      o.err++;
      w.err++;
    }
    const key = `${op} | ${kind} | ${String(message).replace(/\s+/g, " ").slice(0, 160)}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
}

class OpError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

// Classify a PostgREST/Storage/Auth error: raise exception in our functions = business rule (shown as a toast)
function classify(status, code, message) {
  if (status === 429) return "ratelimit";
  if (code === "P0001") return "business";
  if (/already have an open request|already answered|isn't available|no longer exists|already reviewed/i.test(message ?? "")) return "business";
  return "system";
}

async function timed(op, fn) {
  const t = now();
  try {
    const v = await fn();
    rec(op, now() - t);
    return v;
  } catch (e) {
    rec(op, now() - t, e.kind ?? "system", e.message);
    throw e;
  }
}

// A supabase-js call that returns { data, error, status }: throws on error
async function sbCall(op, fn) {
  return timed(op, async () => {
    const res = await fn();
    if (res.error) {
      const e = res.error;
      throw new OpError(e.message ?? String(e), classify(res.status ?? e.status ?? e.statusCode, e.code, e.message));
    }
    return res.data;
  });
}

async function timedFetch(op, url, init = {}, as = "text") {
  return timed(op, async () => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = as === "json" ? await res.json().catch(() => null) : as === "buf" ? await res.arrayBuffer() : await res.text();
    if (!res.ok) throw new OpError(`HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}`, res.status === 429 ? "ratelimit" : "system");
    return body;
  });
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
function summarize(lat) {
  const s = [...lat].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? null, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null };
}

// ---------------------------------------------------------------------------
// Realtime bookkeeping
// ---------------------------------------------------------------------------
const rt = {
  status: {}, // channel status -> count
  subscribeErrors: [],
  expectedMsgs: new Map(), // message_id -> { to, t0, t1, delivered, ms }
  expectedTx: new Map(), // `${tx}:${status}` -> { to, t0, delivered, ms }
  eventsReceived: 0,
  ownEcho: 0, // the sender's own subscription receiving its message (the store relies on it too)
};

// ---------------------------------------------------------------------------
// Assistant bookkeeping
// ---------------------------------------------------------------------------
const ask = { asked: 0, http429: 0, httpErr: 0, statuses: {}, cacheHits: 0, modelCalls: 0, ttfb: [], total: [], errors: {} };

// ---------------------------------------------------------------------------
// Fixtures from the database (enum values, meetup spots, a small photo)
// ---------------------------------------------------------------------------
const admin = new pg.Client({ connectionString: DB_URL, ssl: DB_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false } });
await admin.connect();
const enumVals = async (t) => (await admin.query(`select unnest(enum_range(null::public.${t}))::text v`)).rows.map((r) => r.v);
const CATEGORIES = await enumVals("item_category");
const CONDITIONS = await enumVals("item_condition");
const SPOTS = (await admin.query("select spot_id from public.meetup_spots")).rows.map((r) => r.spot_id);
const PHOTO = (() => {
  const dir = join(process.cwd(), "public", "items");
  const smallest = readdirSync(dir)
    .filter((f) => f.endsWith(".webp"))
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)[0];
  return readFileSync(join(dir, smallest.f));
})();

// ---------------------------------------------------------------------------
// Virtual user
// ---------------------------------------------------------------------------
const vus = []; // index n-1
const vuById = new Map(); // auth uid -> VU
let stopping = false; // no new actions
let draining = false; // no new messages (so every expectation has time to arrive)
const deadline = () => now() - T0 > DURATION_MS;

const ITEM_COLUMNS =
  "item_id, owner_id, meetup_spot_id, title, description, category, condition, status, created_at, updated_at, buyable_items(price), borrowable_items(price_per_week, deposit), item_images(storage_path, position)";
const one = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const toItem = (r) => ({
  item_id: r.item_id,
  owner_id: r.owner_id,
  title: r.title,
  description: r.description,
  category: r.category,
  status: r.status,
  sale: one(r.buyable_items),
  rental: one(r.borrowable_items),
  images: [...(r.item_images ?? [])].sort((a, b) => a.position - b.position).map((i) => i.storage_path),
});
const photoUrl = (path) => (path.startsWith("items/") ? `${APP}/${path}` : `${SB_URL}/storage/v1/object/public/item-images/${path}`);

// Per-user fetch with a timeout, like a browser tab that gives up
const timeoutFetch = (url, init = {}) => {
  const t = AbortSignal.timeout(30_000);
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, t]) : t });
};

let lastSignin = 0;
async function signinSlot() {
  const gap = Number(A["signin-gap-ms"]);
  if (!gap) return;
  const wait = lastSignin + gap - Date.now();
  lastSignin = Math.max(Date.now(), lastSignin + gap);
  if (wait > 0) await sleep(wait);
}

const QUESTIONS_NUM = [
  (n) => `Which listings are for sale under $${n}?`,
  (n) => `What can I rent for less than $${n} a week?`,
  (n) => `Show me things I can buy for under ${n} dollars`,
  (n) => `Any items below $${n} right now?`,
];
const QUESTIONS_FIXED = ["What are the cheapest items for sale right now?", "What is for rent right now?", "Show me the cheapest listings"];

class VU {
  constructor(n) {
    this.n = n;
    this.email = `load-${n}@northeastern.edu`;
    this.partnerN = n % 2 === 1 ? n + 1 : n - 1;
    this.db = { profiles: [], items: [], saved: [], conversations: [], messages: [], transactions: [], reviews: [], ratings: [] };
    this.seenImages = new Set();
    this.scheduledTx = new Set(); // deal steps already queued as reactions
    this.pending = new Set(); // in-flight promises (drained at the end)
    this.rtReadyAt = null;
    this.ready = false;
  }
  get partner() {
    return vus[this.partnerN - 1] ?? null;
  }
  track(p) {
    this.pending.add(p);
    p.catch(() => {}).finally(() => this.pending.delete(p));
    return p;
  }

  // ---------- reads (store.tsx) ----------
  async fetchAll(query) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error, status } = await query(from, from + 999);
      if (error) throw new OpError(error.message, classify(status, error.code, error.message));
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) return rows;
    }
  }
  loadItems(ids) {
    return this.fetchAll((f, t) => this.sb.from("items").select(ITEM_COLUMNS).in("item_id", ids).order("item_id").range(f, t)).then((r) => r.map(toItem));
  }
  loadDeals() {
    return this.fetchAll((f, t) =>
      this.sb
        .from("transactions")
        .select("transaction_id, item_id, buyer_id, type, agreed_price, status, created_at, completed_at, rentals(start_date, due_date, deposit_agreed, returned_at, return_condition)")
        .order("transaction_id")
        .range(f, t),
    );
  }
  async loadChats() {
    const [conversations, messages] = await Promise.all([
      this.fetchAll((f, t) => this.sb.from("conversations").select("*").order("conversation_id").range(f, t)),
      this.fetchAll((f, t) => this.sb.from("messages").select("*").order("message_id").range(f, t)),
    ]);
    return { conversations, messages };
  }
  async loadRelevantItems(related) {
    const [active, mine] = await Promise.all([
      this.fetchAll((f, t) => this.sb.from("items").select(ITEM_COLUMNS).in("status", ["available", "reserved", "rented_out"]).order("item_id").range(f, t)),
      this.fetchAll((f, t) => this.sb.from("items").select(ITEM_COLUMNS).eq("owner_id", this.me).order("item_id").range(f, t)),
    ]);
    const have = new Set([...active, ...mine].map((r) => r.item_id));
    const missing = [...new Set(related)].filter((id) => !have.has(id));
    const extra = [];
    for (let i = 0; i < missing.length; i += 200) extra.push(...(await this.loadItems(missing.slice(i, i + 200))));
    const byId = new Map();
    for (const it of [...active.map(toItem), ...mine.map(toItem), ...extra]) byId.set(it.item_id, it);
    return [...byId.values()].sort((a, b) => a.item_id - b.item_id);
  }

  async loadStore() {
    const me = this.me;
    const [profiles, saved, transactions, chats, reviews, ratings] = await Promise.all([
      timed("load_profiles", () => this.fetchAll((f, t) => this.sb.from("profiles").select("id, name, role, account_status, created_at").order("id").range(f, t))),
      timed("load_saved", () => this.fetchAll((f, t) => this.sb.from("saved_items").select("*").eq("user_id", me).range(f, t))),
      timed("load_deals", () => this.loadDeals()),
      timed("load_chats", () => this.loadChats()),
      timed("load_my_reviews", () =>
        this.fetchAll((f, t) => this.sb.from("reviews").select("*").or(`reviewer_id.eq.${me},reviewee_id.eq.${me}`).order("review_id").range(f, t)),
      ),
      timed("load_ratings", () => this.fetchAll((f, t) => this.sb.from("profile_ratings").select("*").order("profile_id").range(f, t))),
    ]);
    const related = [...transactions.map((t) => t.item_id), ...chats.conversations.map((c) => c.item_id), ...saved.map((s) => s.item_id)];
    const items = await timed("load_items", () => this.loadRelevantItems(related));
    this.db = { profiles, items, saved, transactions, reviews, ratings, ...chats };
  }

  refreshItems(ids) {
    if (!ids.length) return Promise.resolve();
    return timed("refresh_items", () => this.loadItems(ids)).then((fresh) => {
      const byId = new Map(fresh.map((i) => [i.item_id, i]));
      this.db.items = [...this.db.items.filter((i) => !byId.has(i.item_id)), ...fresh];
    });
  }
  refreshDeals() {
    return timed("refresh_deals", () => this.loadDeals()).then((t) => (this.db.transactions = t));
  }
  // incremental store: one conversation (and its messages) / one deal
  fetchConversation(id) {
    return timed("fetch_conversation", async () => {
      const [c, m] = await Promise.all([
        this.sb.from("conversations").select("*").eq("conversation_id", id),
        this.sb.from("messages").select("*").eq("conversation_id", id).order("message_id"),
      ]);
      if (c.error || m.error) throw new Error((c.error ?? m.error).message);
      return { conversations: c.data, messages: m.data };
    }).then(({ conversations, messages }) => {
      for (const c of conversations) if (!this.db.conversations.some((x) => x.conversation_id === c.conversation_id)) this.db.conversations.push(c);
      for (const x of messages) if (!this.db.messages.some((y) => y.message_id === x.message_id)) this.db.messages.push(x);
    });
  }
  fetchDeal(id) {
    return timed("fetch_deal", async () => {
      const { data, error } = await this.sb
        .from("transactions")
        .select("transaction_id, item_id, buyer_id, type, agreed_price, status, created_at, completed_at, rentals(start_date, due_date, deposit_agreed, returned_at, return_condition)")
        .eq("transaction_id", id);
      if (error) throw new Error(error.message);
      return data;
    }).then((rows) => {
      for (const r of rows) this.db.transactions = [...this.db.transactions.filter((t) => t.transaction_id !== r.transaction_id), r];
    });
  }
  refreshChats() {
    return timed("refresh_chats", () => this.loadChats()).then((c) => Object.assign(this.db, c));
  }

  // ---------- arrival ----------
  async demoLogin() {
    for (let attempt = 0; attempt < 8; attempt++) {
      await signinSlot();
      const t = now();
      let res;
      try {
        res = await timeoutFetch(`${APP}/api/demo-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: this.email }) });
      } catch (e) {
        rec("demo_login", now() - t, "system", e.message);
        throw e;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) {
        rec("demo_login", now() - t, "ratelimit", `429 ${body.error ?? ""}`);
        const retry = Number(res.headers.get("retry-after"));
        await sleep((Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2000 * 2 ** attempt) + rand(0, 1000));
        continue;
      }
      if (!res.ok) {
        rec("demo_login", now() - t, "system", `HTTP ${res.status} ${body.error ?? ""}`);
        throw new OpError(`demo-login ${res.status}`, "system");
      }
      rec("demo_login", now() - t);
      return body;
    }
    throw new OpError("demo-login: rate-limited 8 times", "ratelimit");
  }

  async arrive() {
    const t0 = now();
    // 1. The page: HTML, then every script and stylesheet it references (cold browser cache)
    const html = await timedFetch("page_html", `${APP}/`);
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
    await timed("page_assets", () => pool(assets, 6, (a) => timedFetch("asset", `${APP}${a}`, {}, "buf")));
    const pageMs = now() - t0;
    rec("initial_page_load", pageMs);

    // 2. Sign in (demo) and the store's sign-in data load
    const t1 = now();
    const tokens = await this.demoLogin();
    this.sb = createClient(SB_URL, SB_KEY, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `vu-${this.n}` },
      global: { fetch: timeoutFetch },
    });
    const session = await sbCall("auth_set_session", () => this.sb.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }));
    this.me = session.user.id;
    vuById.set(this.me, this);
    await sbCall("profile_is_new", () => this.sb.from("profiles").select("name").eq("id", this.me).single());
    await timed("store_load", () => this.loadStore());
    rec("initial_signin_and_data", now() - t1);
    rec("initial_load_total", now() - t0);

    await this.subscribe();
    this.ready = true;
  }

  subscribe() {
    return new Promise((resolve) => {
      const t = now();
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.channel = this.sb
        .channel(`student-${this.me}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: m }) => this.onMessage(m))
        // the store also listens for read receipts (no HTTP on receipt; counted as realtime load)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, () => {
          if (INCREMENTAL) rt.eventsReceived++;
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, ({ new: tx }) => this.onTx(tx))
        .on("system", {}, (p) => {
          // "Subscribed to PostgreSQL": changes will flow from now on
          if (/subscribed/i.test(p?.message ?? "") && p?.status === "ok" && !this.rtReadyAt) {
            this.rtReadyAt = now();
            rec("rt_postgres_ready", now() - t);
          }
        })
        .subscribe((status, err) => {
          rt.status[status] = (rt.status[status] ?? 0) + 1;
          this.rtStatus = status;
          if (status === "SUBSCRIBED") {
            if (!settled) rec("rt_subscribe", now() - t);
            // Fallback when no system message arrives: assume ready a few seconds later
            setTimeout(() => (this.rtReadyAt ??= now()), 5000);
            done();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            if (!stopping) rt.subscribeErrors.push({ t: since(), vu: this.n, status, err: err?.message ?? null });
            if (!settled) rec("rt_subscribe", now() - t, "system", `${status} ${err?.message ?? ""}`);
            done();
          }
        });
      setTimeout(done, 30_000);
    });
  }

  // ---------- realtime handlers (store.tsx) ----------
  onMessage(m) {
    rt.eventsReceived++;
    const exp = rt.expectedMsgs.get(m.message_id);
    if (exp && exp.to === this.n && !exp.delivered) {
      exp.delivered = true;
      exp.ms = now() - exp.t0;
      exp.msAfterCommit = exp.t1 ? now() - exp.t1 : null;
    } else if (m.sender_id === this.me) rt.ownEcho++;
    if (!this.db.messages.some((x) => x.message_id === m.message_id)) this.db.messages.push(m);
    if (!stopping) {
      if (!INCREMENTAL) this.track(this.refreshChats().catch(() => {})); // old store: all chats on every message
      else if (!this.db.conversations.some((c) => c.conversation_id === m.conversation_id))
        this.track(this.fetchConversation(m.conversation_id).catch(() => {})); // new store: only an unknown chat
    }
    // The seller (or buyer) reads it and answers: a question gets one reply
    if (m.sender_id !== this.me && /^\[q\]/.test(m.body ?? "") && !draining) {
      const conv = m.conversation_id;
      this.track(
        (async () => {
          await sleep(rand(...THINK));
          if (draining) return;
          await rpcCall(this, "rpc_mark_conversation_read", "mark_conversation_read", { p_conversation_id: conv }).catch(() => {});
          await this.sendMessage(conv, `[r] Yes, still available. Meet at the library? (${Date.now()})`, vuById.get(m.sender_id));
        })().catch(() => {}),
      );
    }
  }

  onTx(tx) {
    rt.eventsReceived++;
    if (tx?.transaction_id) {
      const exp = rt.expectedTx.get(`${tx.transaction_id}:${tx.status}`);
      if (exp && exp.to === this.n && !exp.delivered) {
        exp.delivered = true;
        exp.ms = now() - exp.t0;
      }
    }
    if (stopping) return;
    if (!INCREMENTAL) this.track(this.refreshDeals().catch(() => {}));
    else if (tx?.transaction_id) {
      // new store: merge the row; fetch the one deal only for rental hand-over/return (new rental terms)
      const prev = this.db.transactions.find((t) => t.transaction_id === tx.transaction_id);
      const stale = tx.type === "rental" && ["handed_over", "returned", "completed"].includes(tx.status);
      if (stale || !prev) this.track(this.fetchDeal(tx.transaction_id).catch(() => {}));
      else this.db.transactions = this.db.transactions.map((t) => (t.transaction_id === tx.transaction_id ? { ...t, ...tx } : t));
    }
    if (tx?.item_id) this.track(this.refreshItems([tx.item_id]).catch(() => {}));
    // React to deal changes that need this student, like a person seeing the notification
    const step = this.stepFor(tx);
    if (step && !this.scheduledTx.has(`${tx.transaction_id}:${tx.status}`)) {
      this.scheduledTx.add(`${tx.transaction_id}:${tx.status}`);
      this.track(
        (async () => {
          await sleep(rand(...THINK));
          if (draining) return;
          await this.doStep(tx, step);
        })().catch(() => {}),
      );
    }
  }

  ownsItem(itemId) {
    return this.db.items.some((i) => i.item_id === itemId && i.owner_id === this.me);
  }
  // What this student does next on a deal (sale): owner accepts and hands over, buyer confirms
  stepFor(tx) {
    if (!tx?.transaction_id || tx.type !== "sale") return null;
    const owner = this.ownsItem(tx.item_id);
    if (owner && tx.status === "requested") return "accept_deal";
    if (owner && tx.status === "accepted") return "hand_over";
    if (!owner && tx.buyer_id === this.me && tx.status === "handed_over") return "confirm_received";
    return null;
  }
  async doStep(tx, fn) {
    const counterpart = this.ownsItem(tx.item_id) ? vuById.get(tx.buyer_id) : this.partner;
    const next = { accept_deal: "accepted", hand_over: "handed_over", confirm_received: "completed" }[fn];
    const t0 = now();
    await rpcCall(this, `rpc_${fn}`, fn, { p_tx: tx.transaction_id });
    if (counterpart?.rtReadyAt && !draining) rt.expectedTx.set(`${tx.transaction_id}:${next}`, { to: counterpart.n, t0, delivered: false });
    await Promise.all([this.refreshDeals(), this.refreshItems([tx.item_id])]);
    deals.steps[fn] = (deals.steps[fn] ?? 0) + 1;
    if (fn === "confirm_received") deals.completed++;
    // The seller relists after a sale, so the pair always has something to trade
    if (fn === "hand_over") this.track(sleep(rand(...THINK)).then(() => !draining && this.createListing()).catch(() => {}));
  }

  // ---------- writes ----------
  async sendMessage(conversationId, body, to) {
    const t0 = now();
    const data = await sbCall("insert_message", () =>
      this.sb.from("messages").insert({ conversation_id: conversationId, sender_id: this.me, body: body.slice(0, 2000) }).select().single(),
    );
    if (to && to !== this && to.rtReadyAt && to.rtReadyAt < t0 && !draining) {
      rt.expectedMsgs.set(data.message_id, { to: to.n, from: this.n, t0, t1: now(), delivered: false });
    }
    if (!this.db.messages.some((m) => m.message_id === data.message_id)) this.db.messages.push(data);
  }

  async createListing() {
    const paths = [];
    if (Math.random() < 0.25) {
      const path = `${this.me}/${randomUUID()}.webp`;
      await sbCall("storage_upload", () => this.sb.storage.from("item-images").upload(path, PHOTO, { contentType: "image/webp" }));
      paths.push(path);
    }
    const rent = Math.random() < 0.3;
    const id = await rpcCall(this, "rpc_create_listing", "create_listing", {
      p_title: `Load test ${pick(["desk lamp", "calculus text", "mini fridge", "bike lock", "rice cooker", "hoodie"])} ${this.n}-${Math.floor(rand(100, 999))}`,
      p_description: "Listed by the load test. Lightly used.",
      p_category: pick(CATEGORIES),
      p_condition: pick(CONDITIONS),
      p_meetup_spot_id: pick(SPOTS),
      p_sale_price: Math.round(rand(5, 120)),
      p_rent_price: rent ? Math.round(rand(3, 25)) : null,
      p_deposit: rent ? 20 : 0,
      p_image_paths: paths,
    });
    await this.refreshItems([id]);
    return id;
  }

  // ---------- the loop ----------
  async browse() {
    const kind = Math.random();
    const available = this.db.items.filter((i) => i.status === "available" && i.owner_id !== this.me);
    if (kind < 0.4) {
      // Home or a category page: client navigation, then the card photos it shows
      const category = Math.random() < 0.6 ? pick(CATEGORIES) : null;
      await timedFetch("nav_rsc", `${APP}/${category ? `?category=${category}&_rsc` : "?_rsc"}`, { headers: { RSC: "1" } });
      const shown = available.filter((i) => !category || i.category === category).slice(-24);
      await this.loadImages(shown.slice(0, 12).map((i) => i.images[0]).filter(Boolean));
    } else if (kind < 0.7) {
      // Search filters the store's items in the browser: no request, then the result photos
      const word = pick(["lamp", "desk", "book", "bike", "chair", "fridge", "calculator", "jacket", "mug", "monitor"]);
      const t = now();
      const hits = available.filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(word));
      rec("search_local", now() - t);
      await this.loadImages(hits.slice(0, 12).map((i) => i.images[0]).filter(Boolean));
    } else {
      // Open an item: client navigation + its photos
      const item = pick(available);
      if (!item) return;
      await timedFetch("nav_rsc", `${APP}/item/${item.item_id}?_rsc`, { headers: { RSC: "1" } });
      await this.loadImages(item.images);
    }
  }
  async loadImages(paths) {
    const fresh = paths.filter((p) => !this.seenImages.has(p));
    fresh.forEach((p) => this.seenImages.add(p));
    await pool(fresh, 6, (p) => timedFetch(p.startsWith("items/") ? "image_static" : "image_storage", photoUrl(p), {}, "buf").catch(() => {}));
  }

  async save() {
    const item = pick(this.db.items.filter((i) => i.status === "available" && i.owner_id !== this.me));
    if (!item) return;
    const has = this.db.saved.some((s) => s.item_id === item.item_id);
    if (has) {
      await sbCall("save_delete", () => this.sb.from("saved_items").delete().eq("user_id", this.me).eq("item_id", item.item_id));
      this.db.saved = this.db.saved.filter((s) => s.item_id !== item.item_id);
    } else {
      await sbCall("save_insert", () => this.sb.from("saved_items").insert({ user_id: this.me, item_id: item.item_id }));
      this.db.saved.push({ user_id: this.me, item_id: item.item_id });
    }
  }

  partnerItems() {
    const p = this.partner;
    if (!p?.ready) return [];
    return p.db.items.filter((i) => i.owner_id === p.me);
  }

  async chat() {
    const p = this.partner;
    const items = this.partnerItems();
    if (!p || !items.length || draining) return this.browse();
    const item = pick(items);
    const id = await rpcCall(this, "rpc_open_conversation", "open_conversation", { p_item_id: item.item_id, p_buyer_id: null });
    if (!this.db.conversations.some((c) => c.conversation_id === id)) await (INCREMENTAL ? this.fetchConversation(id) : this.refreshChats());
    await this.sendMessage(id, `[q] Hi! Is "${item.title}" still available? (${Date.now()})`, p);
  }

  async deal() {
    // A step that's waiting on me and not already queued as a reaction
    for (const tx of this.db.transactions) {
      const step = this.stepFor(tx);
      const key = `${tx.transaction_id}:${tx.status}`;
      if (step && !this.scheduledTx.has(key)) {
        this.scheduledTx.add(key);
        return this.doStep(tx, step);
      }
    }
    // Otherwise ask to buy one of my partner's listings
    const open = new Set(this.db.transactions.filter((t) => t.buyer_id === this.me && ["requested", "accepted", "handed_over"].includes(t.status)).map((t) => t.item_id));
    const item = pick(this.partnerItems().filter((i) => i.status === "available" && i.sale && !open.has(i.item_id)));
    if (!item || draining) return this.browse();
    const t0 = now();
    const txId = await rpcCall(this, "rpc_request_deal", "request_deal", { p_item_id: item.item_id, p_type: "sale" });
    if (this.partner?.rtReadyAt) rt.expectedTx.set(`${txId}:requested`, { to: this.partner.n, t0, delivered: false });
    deals.steps.request_deal = (deals.steps.request_deal ?? 0) + 1;
    await Promise.all([this.refreshDeals(), this.refreshItems([item.item_id])]);
  }

  async askLoop() {
    if (!ASK_APP) return;
    const count = Math.floor(rand(Number(A["ask-min"]), Number(A["ask-max"]) + 1));
    const start = RAMP_MS + 20_000;
    const end = DURATION_MS - 45_000;
    // Spread over the run, at least 25 s apart (the route allows 3 a minute)
    const times = Array.from({ length: count }, () => rand(start, end)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1] + 25_000);
    for (const at of times) {
      const wait = at - (now() - T0);
      if (wait > 0) await sleep(wait);
      if (stopping) return;
      await this.askOnce().catch(() => {});
    }
  }

  async askOnce() {
    const fixed = Math.random() < 0.25;
    const question = fixed ? pick(QUESTIONS_FIXED) : pick(QUESTIONS_NUM)(Math.floor(rand(5, 300)));
    const { data } = await this.sb.auth.getSession();
    const t = now();
    ask.asked++;
    let res;
    try {
      res = await fetch(`${ASK_APP}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}` },
        body: JSON.stringify({ question }),
        signal: AbortSignal.timeout(130_000),
      });
    } catch (e) {
      ask.httpErr++;
      ask.errors[e.message] = (ask.errors[e.message] ?? 0) + 1;
      rec("ask_total", now() - t, "system", e.message);
      return;
    }
    if (res.status === 429) {
      ask.http429++;
      await res.text().catch(() => "");
      rec("ask_total", now() - t, "ratelimit", "429");
      return;
    }
    if (!res.ok || !res.body) {
      ask.httpErr++;
      const msg = `HTTP ${res.status}`;
      ask.errors[msg] = (ask.errors[msg] ?? 0) + 1;
      rec("ask_total", now() - t, "system", msg);
      return;
    }
    let first = null;
    let buffer = "";
    let done = null;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      first ??= now() - t;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const ev = JSON.parse(line);
        if (ev.type === "done") done = ev;
      }
    }
    if (buffer.trim()) {
      const ev = JSON.parse(buffer);
      if (ev.type === "done") done = ev;
    }
    const total = now() - t;
    ask.ttfb.push(first ?? total);
    ask.total.push(total);
    const status = done?.status ?? "no_done_event";
    ask.statuses[status] = (ask.statuses[status] ?? 0) + 1;
    if (done?.cacheHit) ask.cacheHits++;
    ask.modelCalls += done?.modelCalls ?? 0;
    if (status === "answered") rec("ask_total", total);
    else rec("ask_total", total, "system", `status ${status}${done?.error ? `: ${done.error}` : ""}`);
  }

  async loop() {
    while (!deadline() && !stopping) {
      await sleep(rand(...THINK));
      if (deadline() || stopping) break;
      const r = Math.random();
      const action = r < 0.5 ? "browse" : r < 0.65 ? "save" : r < 0.85 ? "chat" : r < 0.95 ? "deal" : "create";
      actions[action] = (actions[action] ?? 0) + 1;
      try {
        await this.track(
          action === "browse" ? this.browse() : action === "save" ? this.save() : action === "chat" ? this.chat() : action === "deal" ? this.deal() : this.createListing(),
        );
      } catch {
        // recorded by the op wrappers
      }
    }
  }

  async start() {
    try {
      await this.arrive();
    } catch (e) {
      arrivalFailures.push({ vu: this.n, error: e.message });
      return;
    }
    // Everyone has one listing to talk and trade about
    await this.createListing().catch(() => {});
    await Promise.all([this.loop(), this.askLoop()]);
  }
}

const actions = {};
const deals = { steps: {}, completed: 0 };
const arrivalFailures = [];

async function rpcCall(vu, op, fn, args) {
  return sbCall(op, () => vu.sb.rpc(fn, args));
}

// Run fn over items with at most `size` at once (a browser's ~6 connections per host)
async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()).catch(() => {});
    }),
  );
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------
async function pidOnPort(port) {
  try {
    const { stdout } = await run("netstat", ["-ano", "-p", "tcp"], { windowsHide: true });
    const line = stdout.split(/\r?\n/).find((l) => new RegExp(`(0\\.0\\.0\\.0|127\\.0\\.0\\.1):${port}\\s+\\S+\\s+LISTENING`).test(l));
    return line ? Number(line.trim().split(/\s+/).at(-1)) : null;
  } catch {
    return null;
  }
}
const appPid = await pidOnPort(new URL(APP).port || 80);
const askPid = ASK_APP ? await pidOnPort(new URL(ASK_APP).port || 80) : null;

const samples = [];
const outbound = []; // connections from the ask app to non-local hosts
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = now();
const lastProcCpu = new Map();
const monitorDb = new pg.Client({ connectionString: DB_URL, ssl: DB_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false } });
await monitorDb.connect();

async function sample() {
  const s = { t: Math.round(since()), activeVUs: vus.filter((v) => v.ready).length };
  const jobs = [
    monitorDb
      .query("select coalesce(usename, '(background)') as usename, coalesce(state, '') as state, count(*)::int as n from pg_stat_activity group by 1, 2 order by 3 desc")
      .then(({ rows }) => (s.pg = rows))
      .catch((e) => (s.pgError = e.message)),
    run("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"], { windowsHide: true, timeout: 15_000 })
      .then(({ stdout }) => {
        s.docker = stdout
          .split(/\r?\n/)
          .filter((l) => l.includes("huskyswap-test"))
          .map((l) => {
            const [name, cpu, mem] = l.split("|");
            return { name: name.replace(/^supabase_/, "").replace(/_huskyswap-test$/, ""), cpu: parseFloat(cpu), mem: mem.split("/")[0].trim() };
          });
      })
      .catch((e) => (s.dockerError = e.message)),
  ];
  const pids = [appPid, askPid].filter(Boolean);
  if (pids.length) {
    jobs.push(
      run("powershell", ["-NoProfile", "-Command", `Get-Process -Id ${pids.join(",")} | ForEach-Object { "$($_.Id)|$($_.CPU)|$($_.WorkingSet64)" }`], { windowsHide: true, timeout: 15_000 })
        .then(({ stdout }) => {
          s.procs = stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => {
              const [pid, cpu, ws] = l.split("|");
              const at = now();
              const prev = lastProcCpu.get(pid);
              lastProcCpu.set(pid, { cpu: Number(cpu), at });
              return {
                pid: Number(pid),
                role: Number(pid) === appPid ? "app" : "ask-app",
                cpuPctOfOneCore: prev ? Math.round(((Number(cpu) - prev.cpu) / ((at - prev.at) / 1000)) * 100) : null,
                rssMB: Math.round(Number(ws) / 1048576),
              };
            });
        })
        .catch((e) => (s.procError = e.message)),
    );
  }
  if (askPid) {
    jobs.push(
      run("netstat", ["-ano", "-p", "tcp"], { windowsHide: true })
        .then(({ stdout }) => {
          for (const l of stdout.split(/\r?\n/)) {
            const parts = l.trim().split(/\s+/);
            if (parts.length < 5 || Number(parts[4]) !== askPid) continue;
            const foreign = parts[2];
            const host = foreign.replace(/:\d+$/, "");
            if (!["127.0.0.1", "[::1]", "0.0.0.0", "[::]", "*"].includes(host)) outbound.push({ t: s.t, foreign, state: parts[3] });
          }
        })
        .catch(() => {}),
    );
  }
  if (STUB) jobs.push(fetch(`${STUB}/stats`).then((r) => r.json()).then((j) => (s.stub = j)).catch(() => {}));
  await Promise.all(jobs);
  const cpu = process.cpuUsage(lastCpu);
  const at = now();
  s.generator = {
    cpuPctOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / (at - lastCpuAt)) * 100),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    loopDelayP99ms: Math.round(loopDelay.percentile(99) / 1e6),
    loopDelayMaxMs: Math.round(loopDelay.max / 1e6),
  };
  lastCpu = process.cpuUsage();
  lastCpuAt = at;
  loopDelay.reset();
  samples.push(s);
  const conns = (s.pg ?? []).reduce((a, r) => a + r.n, 0);
  const w = windows.at(-2) ?? windows.at(-1);
  const wp95 = w ? summarize(w.lat).p95 : null;
  console.log(
    `[${s.t}s] vus=${s.activeVUs} ops/10s=${w?.n ?? 0} err=${w?.err ?? 0} p95=${wp95 ? Math.round(wp95) : "-"}ms pg=${conns} ` +
      `${(s.docker ?? []).map((d) => `${d.name}:${d.cpu}%/${d.mem}`).join(" ")} ` +
      `${(s.procs ?? []).map((p) => `${p.role}:${p.cpuPctOfOneCore}%/${p.rssMB}MB`).join(" ")} gen:${s.generator.cpuPctOfOneCore}% lag99=${s.generator.loopDelayP99ms}ms` +
      (s.stub ? ` stub=${s.stub.requests}` : ""),
  );
}

let sampling = false;
const sampler = setInterval(() => {
  if (sampling) return;
  sampling = true;
  sample().finally(() => (sampling = false));
}, SAMPLE_MS);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log(
  `Load test "${LABEL}": ${USERS} users, ${A.minutes} min, ramp ${A.ramp} s, app ${APP}${ASK_APP ? `, assistant ${ASK_APP}` : ""}; app pid ${appPid ?? "?"}${askPid ? `, ask pid ${askPid}` : ""}`,
);
const offset = Number(A["user-offset"]);
for (let i = 1; i <= USERS; i++) vus.push(new VU(offset + i));
// Pairs are (1,2), (3,4), ...: index by position, not email number
for (const [i, vu] of vus.entries()) vu.partnerN = i % 2 === 0 ? i + 2 : i;

await sample();
const started = vus.map((vu, i) => sleep((RAMP_MS * i) / USERS + rand(0, RAMP_MS / USERS)).then(() => vu.start()));

await sleep(DURATION_MS);
draining = true; // stop sending messages and starting deals; let deliveries land
stopping = true;
console.log(`[${Math.round(since())}s] stopping: waiting for in-flight actions and realtime deliveries`);
await Promise.race([Promise.all(started), sleep(60_000)]);
await Promise.race([Promise.all(vus.flatMap((v) => [...v.pending])), sleep(30_000)]);
await sleep(10_000); // late realtime deliveries
await sample();
clearInterval(sampler);

for (const vu of vus) {
  try {
    if (vu.channel) await vu.sb.removeChannel(vu.channel);
    vu.sb?.realtime.disconnect();
    await vu.sb?.auth.stopAutoRefresh();
  } catch {}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const elapsedS = since();
const opTable = [...ops.entries()]
  .map(([op, o]) => ({ op, ...summarize(o.lat), ok: o.ok, errors: o.err, business: o.business, rateLimited: o.rateLimited, perSec: o.lat.length / (DURATION_MS / 1000) }))
  .sort((a, b) => b.n - a.n);

const msgs = [...rt.expectedMsgs.values()];
const txs = [...rt.expectedTx.values()];
const rtSummary = {
  messagesExpected: msgs.length,
  messagesDelivered: msgs.filter((m) => m.delivered).length,
  deliveryPct: msgs.length ? (100 * msgs.filter((m) => m.delivered).length) / msgs.length : null,
  latencyFromSend: summarize(msgs.filter((m) => m.delivered).map((m) => m.ms)),
  latencyFromCommit: summarize(msgs.filter((m) => m.delivered && m.msAfterCommit !== null).map((m) => Math.max(0, m.msAfterCommit))),
  dealEventsExpected: txs.length,
  dealEventsDelivered: txs.filter((m) => m.delivered).length,
  dealDeliveryPct: txs.length ? (100 * txs.filter((m) => m.delivered).length) / txs.length : null,
  dealLatency: summarize(txs.filter((m) => m.delivered).map((m) => m.ms)),
  channelStatus: rt.status,
  channelErrors: rt.subscribeErrors,
  eventsReceived: rt.eventsReceived,
};

const networkOps = opTable.filter((o) => !LOCAL_OPS.has(o.op) && !o.op.startsWith("initial_") && !["page_assets", "store_load", "ask_total", "rt_subscribe", "rt_postgres_ready"].includes(o.op));
const totalOps = opTable.filter((o) => !LOCAL_OPS.has(o.op) && !o.op.startsWith("initial_") && o.op !== "page_assets" && o.op !== "store_load").reduce((a, o) => a + o.n, 0);
const totalSystemErr = opTable.filter((o) => !o.op.startsWith("initial_") && o.op !== "page_assets" && o.op !== "store_load").reduce((a, o) => a + o.errors, 0);
const initial = opTable.find((o) => o.op === "initial_load_total");
const gates = {
  "p95 < 1000 ms for every DB/API op": { pass: networkOps.every((o) => o.p95 < 1000), worst: networkOps.reduce((w, o) => (o.p95 > (w?.p95 ?? -1) ? o : w), null)?.op },
  "p95 < 2500 ms initial load": { pass: (initial?.p95 ?? Infinity) < 2500, value: initial?.p95 },
  "error rate < 0.5%": { pass: totalOps ? totalSystemErr / totalOps < 0.005 : false, value: totalOps ? (100 * totalSystemErr) / totalOps : null },
  "realtime delivery >= 99%": { pass: (rtSummary.deliveryPct ?? 0) >= 99, value: rtSummary.deliveryPct },
};

const peakConn = {};
for (const s of samples) {
  const byUser = {};
  for (const r of s.pg ?? []) byUser[r.usename] = (byUser[r.usename] ?? 0) + r.n;
  byUser.TOTAL = Object.values(byUser).reduce((a, b) => a + b, 0);
  for (const [u, n] of Object.entries(byUser)) peakConn[u] = Math.max(peakConn[u] ?? 0, n);
}
const peakDocker = {};
for (const s of samples)
  for (const d of s.docker ?? []) {
    const mem = parseFloat(d.mem) * (/GiB/.test(d.mem) ? 1024 : /KiB/.test(d.mem) ? 1 / 1024 : 1);
    const p = (peakDocker[d.name] ??= { cpuPct: 0, memMiB: 0 });
    p.cpuPct = Math.max(p.cpuPct, d.cpu || 0);
    p.memMiB = Math.max(p.memMiB, Math.round(mem));
  }
const peakProcs = {};
for (const s of samples)
  for (const p of s.procs ?? []) {
    const q = (peakProcs[p.role] ??= { cpuPctOfOneCore: 0, rssMB: 0 });
    q.cpuPctOfOneCore = Math.max(q.cpuPctOfOneCore, p.cpuPctOfOneCore ?? 0);
    q.rssMB = Math.max(q.rssMB, p.rssMB);
  }
const peakGen = samples.reduce((g, s) => ({ cpu: Math.max(g.cpu, s.generator.cpuPctOfOneCore), lag: Math.max(g.lag, s.generator.loopDelayP99ms), rss: Math.max(g.rss, s.generator.rssMB) }), { cpu: 0, lag: 0, rss: 0 });

const askSummary = ASK_APP
  ? {
      ...ask,
      ttfb: summarize(ask.ttfb),
      total: summarize(ask.total),
      stub: samples.at(-1)?.stub ?? null,
      outboundNonLocal: [...new Set(outbound.map((o) => o.foreign))],
    }
  : null;

const result = {
  label: LABEL,
  config: { users: USERS, minutes: Number(A.minutes), rampS: Number(A.ramp), app: APP, askApp: ASK_APP, think: THINK, appPid, askPid },
  startedAt: new Date(Date.now() - elapsedS * 1000).toISOString(),
  elapsedS,
  arrivalFailures,
  actions,
  deals,
  ops: opTable,
  errors: Object.fromEntries([...errors.entries()].sort((a, b) => b[1] - a[1])),
  realtime: rtSummary,
  assistant: askSummary,
  gates,
  peaks: { connections: peakConn, docker: peakDocker, procs: peakProcs, generator: peakGen },
  timeline: windows.map((w) => ({ t: w.t, n: w.n, err: w.err, p95: summarize(w.lat).p95 })),
  samples,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL}-results.json`), JSON.stringify(result, null, 1));

const f = (v) => (v === null || v === undefined ? "-" : Math.round(v));
const lines = [
  `# Load test ${LABEL}: ${USERS} users, ${A.minutes} min`,
  "",
  `Arrival failures: ${arrivalFailures.length}. Actions: ${JSON.stringify(actions)}. Deals: ${JSON.stringify(deals)}`,
  "",
  "| op | n | /s | p50 | p95 | p99 | max | sys err | business | 429 |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...opTable.map((o) => `| ${o.op} | ${o.n} | ${o.perSec.toFixed(2)} | ${f(o.p50)} | ${f(o.p95)} | ${f(o.p99)} | ${f(o.max)} | ${o.errors} | ${o.business} | ${o.rateLimited} |`),
  "",
  `Realtime: ${rtSummary.messagesDelivered}/${rtSummary.messagesExpected} messages delivered (${rtSummary.deliveryPct?.toFixed(2)}%), p50 ${f(rtSummary.latencyFromSend.p50)} / p95 ${f(rtSummary.latencyFromSend.p95)} / max ${f(rtSummary.latencyFromSend.max)} ms from send; deal events ${rtSummary.dealEventsDelivered}/${rtSummary.dealEventsExpected}; channel status ${JSON.stringify(rt.status)}`,
  askSummary
    ? `Assistant: asked ${ask.asked}, 429 ${ask.http429}, http errors ${ask.httpErr}, statuses ${JSON.stringify(ask.statuses)}, cache hits ${ask.cacheHits}, model calls ${ask.modelCalls}, total p50 ${f(askSummary.total.p50)} p95 ${f(askSummary.total.p95)} max ${f(askSummary.total.max)} ms; stub requests ${askSummary.stub?.requests}; non-local outbound ${JSON.stringify(askSummary.outboundNonLocal)}`
    : "Assistant: not tested",
  `Peak connections: ${JSON.stringify(peakConn)}`,
  `Peak docker: ${JSON.stringify(peakDocker)}`,
  `Peak procs: ${JSON.stringify(peakProcs)}; generator ${JSON.stringify(peakGen)}`,
  "",
  "Gates:",
  ...Object.entries(gates).map(([k, v]) => `- ${v.pass ? "PASS" : "FAIL"} ${k} ${JSON.stringify(v)}`),
  "",
  "Top errors:",
  ...[...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `- ${n} x ${k}`),
];
writeFileSync(join(OUT, `${LABEL}-summary.md`), lines.join("\n"));
console.log(lines.join("\n"));

await monitorDb.end().catch(() => {});
await admin.end().catch(() => {});
process.exit(0);
