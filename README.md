# HuskySwap

> ### 👉 Try it live: [huskyswap.vercel.app](https://huskyswap.vercel.app)
>
> Sign in with your `@northeastern.edu` email; new users choose a display name, then the marketplace opens.
> Currently in testing with **50+ student users**.
> Tap the husky in the corner to ask the marketplace questions in plain English.
> **On a phone:** open the link, then Share → **Add to Home Screen** (iPhone) or **Install app** (Android) to use it like an app.

A marketplace for Northeastern students: buy, sell, and borrow things for a week, paying in person at a campus meetup spot. Its assistant, **Ask HuskySwap**, answers questions about the marketplace in plain English by writing and running SQL, and is served by a small model distilled from a 120B one.

## Highlights

**A text-to-SQL agent** (`src/lib/agent/`): an explicit graph (semantic cache → retrieval → clarifying questions → SQL with tool calls → guardrails → grounded answer) that runs on read-only, role-scoped Postgres views. It uses Postgres's own parser to allow only safe SELECTs, masks personal data, and keeps each student's private data to that student.

**Distilling gpt-oss-120b into Qwen3-4B** (`ml/`): the teacher generated multi-step tool-calling traces, and the student was fine-tuned on them with LoRA. On a held-out test set of 318 hand-written questions, scored by execution accuracy against two independent gold queries:

| Model | Size | Overall | SQL answers | Refusals | Tokens / question |
|---|---|---|---|---|---|
| Teacher: gpt-oss-120b | 120B | 85.2% | 83.8% | 85.7% | 4,229 |
| Qwen3-4B, untrained | 4B | 56.4% | 57.4% | 25.0% | 8,299 |
| **HuskySwap student (r3)** | **4B** | **75.9%** | **72.0%** | **92.9%** | **~3,800** |
| HuskySwap student, Qwen3-8B (r3-8b) | 8B | 75.8% | 71.0% | – | – |

Student and base rows are the mean of 3 runs; the teacher row is a single run. The 4B student closes about two-thirds of the gap to a model 30× its size and refuses unsafe questions more reliably than the teacher. Reports are in `eval/reports/` and the model registry in `ml/registry.json`.

**Tested and hardened for real users.** HuskySwap is in testing with 50+ students. Before opening it up, every layer was tested end to end on a local copy of the stack (`docs/TESTING.md`):

| Check | Result |
|---|---|
| Load: 50 concurrent users for 10 minutes (browsing, chat, deals, listings, the assistant) | 0 errors in ~27,000 requests; p95 under 400 ms for every database call; 100% of chat messages delivered live; page load p95 0.76 s |
| Assistant red team: a fully compromised LLM attacks through the real `/api/ask` route (113 attacks as a student, the same as an admin, plus cache poisoning) | 0 leaks of another student's data in 232 runs |
| Unit tests (Vitest) | 777 passing |
| End-to-end browser tests (Playwright, phone and desktop): sign-up, listings with photos, live chat, full sale and rental deals, reviews, profile, accessibility | 61 passing |
| Database security rules and assistant guardrails (`test:rls`, `test:agent-guard`) | all passing |

Load testing found that every live update made each phone reload its whole inbox through a security policy that scanned every message in the marketplace. Rewriting the policies to use indexes (`0010_rls_performance.sql`) and merging live updates in place cut the database's peak CPU from 392% to 88% and p95 latency from up to 8.4 s to under 400 ms.

The app runs on **Supabase** (Postgres, Auth, Storage, Realtime). The database holds three academic years of marketplace activity (see [Supabase database](#supabase-database)): realistic, messy data for the agent to work on.

Design: warm off-white pages, white cards, Fraunces headings with DM Sans text, and Northeastern red for actions. The tokens live in `src/app/globals.css`. The app follows the device's light or dark setting; change it under **Profile → App theme**.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

Needs `.env.local` (git-ignored) with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `DATABASE_URL` for the scripts. On a phone, open `http://<your-computer's-IP>:3000` on the same Wi-Fi and use **Add to Home Screen**.

### Sign-in

**Sign in with Google** (ready in the code, switched on with `NEXT_PUBLIC_GOOGLE_LOGIN=true` once set up) is the intended way in: Google proves the person owns the account, so nobody can sign in as someone else. A new account gets the "What should we call you?" step, prefilled with its Google name. Google accounts may use any email; everything else stays `@northeastern.edu`-only (`supabase/migrations/0012_google_sign_in.sql`).

One-time setup (free):

1. **Google Cloud Console → APIs & Services → OAuth consent screen**: external, app name HuskySwap, your email as support contact; publish it (no sensitive scopes, so no review).
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. Copy the client ID and secret.
3. **Supabase dashboard → Authentication → Sign In / Providers → Google**: enable it and paste the client ID and secret.
4. **Supabase → Authentication → URL Configuration**: Site URL `https://huskyswap.vercel.app`; redirect URLs `https://huskyswap.vercel.app/login` and `http://localhost:3000/login`.
5. **Vercel → Environment Variables**: `NEXT_PUBLIC_GOOGLE_LOGIN=true` shows the Google button (until then the sign-in screen is the Northeastern email form only), then redeploy.

**Demo sign-in (testing only).** With `DEMO_LOGIN=true` and `NEXT_PUBLIC_DEMO_LOGIN=true`, the sign-in screen also offers a Northeastern email form whose code screen accepts any 6 digits; no email is sent (`src/app/api/demo-login/route.ts`). It doesn't prove anyone owns the email, so anyone could sign in as anyone: the local test stack uses it (`.env.test`), but remove both settings from production once Google sign-in works. Admin and suspended accounts can't use it, and it's rate-limited per IP.

### Northeastern email codes (optional, later; one-time setup in the Supabase dashboard)

To offer real email codes for `@northeastern.edu` addresses alongside Google, set `NEXT_PUBLIC_EMAIL_LOGIN=true` and:

1. **Authentication → Emails → Templates**: in both **Magic link** and **Confirm signup**, add the code, e.g. `<p>Your HuskySwap code: <strong>{{ .Token }}</strong></p>`. Without `{{ .Token }}`, Supabase sends a link instead of a code.
2. **Authentication → Emails → SMTP settings**: Supabase's built-in email only sends to your own organization's members and only a few emails per hour. To email any student, add Resend as the SMTP server: host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key. Resend needs a verified sending domain to email anyone besides you.

## How it's built

| Path | What |
|---|---|
| `supabase/schema.sql` | Postgres schema v2.1: tables, rules, `nlq` text-to-SQL views and roles |
| `supabase/migrations/0002_app_access.sql` | Row-level security policies, the functions every write goes through, photo bucket, realtime |
| `docs/EER_v2.1.drawio` | ER diagram |
| `src/lib/supabase.ts` | Browser Supabase client and photo URLs |
| `src/lib/store.tsx` | App data: loads what the signed-in student can see, calls database functions, live updates |
| `src/app/(app)/…` | Signed-in screens: home, item, sell, chats, deals, saved, profile |
| `src/app/login` | Email + one-time code sign-in |
| `scripts/seed-supabase.mjs` | Generates and loads the seed dataset |
| `scripts/sql.mjs` | Run SQL from the terminal, optionally as a text-to-SQL role |
| `scripts/test-rls.mjs`, `scripts/smoke-client.mjs` | Security and end-to-end checks (they change nothing permanently) |
| `scripts/catalog.mjs` | Item templates (titles, prices, photo search terms) |
| `scripts/fetch-images.mjs`, `fetch-commons.mjs`, `make-variants.mjs` | Stand-in listing photos (`public/items/`, credits in `src/data/photos.json`) |

Stack: Next.js 16 (App Router, React 19, TypeScript), Tailwind CSS 4, Supabase, lucide-react icons.

**Security model.** Signed-out visitors get nothing. Signed-in students can read marketplace data (listings, profiles, reviews) and only their own private data (chats, deals, saved items, reports). Every change goes through a database function that enforces the rules: no buying your own item, one active deal per item, 7-day rentals, reviews only after a completed deal. Check it with `npm run test:rls` and `node scripts/smoke-client.mjs`.

**The assistant can't reveal another student's data, even if its model is tricked.** The model is treated as untrusted; the walls are below it:

1. Student questions run on a database login that can only read current listings, meetup spots, categories, the calendar, and that student's own `my_*` views (no view holds other students' deals, earnings or chats), and can't switch to the admin role (`0011_assistant_hardening.sql`).
2. `my_*` views filter on the student id the server takes from the verified session; the model never sets it.
3. The `nlq` views hold no names, emails or message text, and are security barriers, so a crafted query can't make an error message quote hidden rows.
4. Every query passes Postgres's own parser first: one read-only SELECT, allowed views and functions only, no role or setting changes, no size-bomb functions; it runs read-only with a timeout and a row cap.
5. Results, errors, clarifying questions and answers are masked for emails, phone numbers and links.
6. Cached answers are never shown to a different student: their SQL re-runs as the new asker.

`npm run test:env -- npm run test:redteam` replays the attack set against the local stack.

## Supabase database

Project `huskyswap` (`kjjfyfkkmrpasdesgqib`, us-east-1).

```bash
npm run seed -- --dry-run    # generate and print stats only
npm run seed -- --reset      # replace the seed data in the database
```

The seed (`scripts/seed-supabase.mjs`, about 30 s) creates three academic years of activity, starting at Fall 2023 move-in:

| | |
|---|---|
| Students | 3,000. They join at semester starts and graduate after 4–5 years (co-op), then stop trading; some deactivate. |
| Listings | ~13,300 with photos, including ~500 reposts at a lower price. Graduating seniors clear out their rooms in late April. |
| Deals | ~13,700: sales (some negotiated down), 7-day rentals (~18% returned late, a few overdue now), declined, cancelled and open requests |
| Conversations / messages | ~22,000 / ~99,000 |
| Reviews | ~15,000. Lenders rate late (3.4) and damaged (3.0) returns lower than on-time ones (4.4), and slow-replying sellers rate lower. |
| Saved items / reports | ~9,000 / 160 |

User-written text is deliberately messy (`scripts/messy.mjs`): typos, abbreviations ("graphing calc", "Orgo"), lowercase or ALL CAPS, emoji, "**everything must go**" suffixes, empty or one-word descriptions, chat slang ("thx", "lmk"), a few free items and wildly overpriced outliers. Activity follows the academic calendar: move-in, finals, move-out, quiet summers. The seed runs in one transaction, and `--reset` keeps real (non-seeded) accounts.

Seeded accounts have no password and are never emailed. Their emails use the real Northeastern format, so run `--reset` before opening sign-ups to real students.

### Daily activity and drift

```bash
node scripts/simulate-day.mjs                     # add the last 24 hours of activity (run daily)
node scripts/simulate-day.mjs --days=7 --dry-run  # preview a week without writing
node scripts/simulate-day.mjs --trend=vision-pro --new-spot="ISEC Building" --inflation=1.2 --surge=3
```

Each run adds new students, listings, chats, saves and requests, moves deals forward, checks in rentals that are due, and adds reviews and reports, at rates that follow the academic calendar. The drift knobs inject things the model has never seen: new product types (`vision-pro`, `stanley-cup`, `e-bike`, `ai-pin`), a new meetup spot, price inflation, or an activity surge. Every run, including any drift, is logged in `ops.simulation_runs`.

`npm run test:rls` and `node scripts/smoke-client.mjs` check the security rules and the app's queries (they leave no changes).

## Running SQL

- **Supabase dashboard → SQL Editor**: full access, good for exploring.
- **Terminal**:
  ```bash
  npm run sql -- "select category, count(*) from public.items group by 1 order by 2 desc"
  npm run sql -- --as=nlq_student "select title, sale_price from nlq.listings order by sale_price limit 5"
  ```
  `--as` runs the query as a text-to-SQL role in a read-only transaction.
- **Any Postgres client** (DBeaver, TablePlus, VS Code, Python `psycopg`) with the `DATABASE_URL` connection string.

### The text-to-SQL schema (`nlq`)

The model only ever queries the `nlq` schema (`supabase/migrations/0003_nlq_analytics.sql`). It's a small star schema with no personal data: no names, no emails, no message text. Every view and column carries a comment, and those comments are the model's schema guide.

| Kind | Views |
|---|---|
| Facts | `listings_all`, `deals`, `reviews`, `conversations` (counts and reply times only), `saved_items`, `reports` |
| Dimensions | `students` (opaque id, joined_at, status), `meetup_spots` (on or off campus), `categories` (with groups), `calendar` (2019–2030: semester, move-in / finals / move-out periods, US and Massachusetts holidays such as Patriots' Day) |
| Student-facing | `listings`: what's available right now |

Every timestamp also has a Boston-local `*_on` date (e.g. `listed_on`) that joins to `calendar.day`, so "last Tuesday" is unambiguous. `nlq_student` sees only `listings`, `meetup_spots`, `categories` and `calendar`; `nlq_admin` sees everything. Both roles are read-only with 3–5 s timeouts. Give them a login password before connecting directly (see `schema.sql`).

## Text-to-SQL agent (Ask HuskySwap)

Students and admins ask questions in plain English on the **Ask** screen (sparkle button on Home). The agent is an explicit graph (`src/lib/agent/graph.ts`), the same for the app, the CLI, training-data generation and evals:

```
question → [1] semantic cache ──hit──► re-run stored SQL → answer
         → [3] context retriever (views, values, definitions, past queries; no model)
         → [2] ambiguous? (sees what [3] found) ──yes──► clarifying question
         → [4] SQL node → [5] guardrails → [6] execute ──error / empty──► back to [4]
         → [7] answer + grounding check → stored in the cache
```

| File | Node | What |
|---|---|---|
| `cache.ts` | 1 | Similarity ≥ 0.95 *and* the same numbers, polarity (cheapest / most expensive, not), time words and key terms. Scoped by role, and by student for `my_*` SQL; re-runs the SQL on hit; "today / this week" entries expire at midnight; a thumbs-down removes the entry |
| `retrieve.ts` | 3 | pgvector (gte-small, local) over `ops.rag_docs` + trigram matching of stored values + exact aliases; picks 5–10 views and their joins. Every entry is tagged with the roles allowed to see it |
| `clarify.ts` | 2 | Asks only when readings give materially different answers (max 2 rounds); never for requests for personal information; returns the resolved question |
| `sql-node.ts` | 4–6 | Tools `lookup_values`, `run_sql`, `submit_sql`; ≤ 6 model calls, ≤ 3 failed queries, ≤ 2 lookups, repeated calls deduplicated; empty results questioned once |
| `answer.ts` | 7 | One to three sentences; every number must appear in the result (one retry); contact details masked |
| `guard.ts` | 5 | Postgres's own parser: one SELECT, `nlq` views and columns the role may see, allowlisted functions |
| `db.ts` | 6 | Student questions run on the `nlq_agent_student` login (can only become `nlq_student`), admin questions on `nlq_agent`: read-only transaction, role switch, server-set `app.user_id` for `my_*` views, timeout, 200-row cap, PII masking (results and error messages), rollback |
| `semantic-layer.ts`, `examples.ts` | – | Business terms, value aliases, metrics, join paths; verified example queries (never eval questions) |

The run as a whole has a budget (30K tokens, 110 s). Every run is logged in `ops.agent_runs`, including each node's outcome and every model call. Students can ask about their own listings, deals, saved items and ratings (`my_*` views, migration `0005`); other students' activity stays hidden. The agent never writes data.

Setup: migrations `0004_agent.sql`, `0005_agent_graph.sql` and `0011_assistant_hardening.sql`, then in `.env.local`: `NLQ_DATABASE_URL` (user `nlq_agent.<project-ref>` on the session pooler), `NLQ_STUDENT_DATABASE_URL` (user `nlq_agent_student.<project-ref>` on the transaction pooler, port 6543; without it students fall back to `nlq_agent` and the server logs a warning) and `TEACHER_BASE_URL`, `TEACHER_API_KEY`, `TEACHER_MODEL` (e.g. Groq's free tier with `openai/gpt-oss-120b`). Optional `TEACHER_API_KEYS` (comma-separated) adds keys to a pool: requests go round-robin, and a rate-limited key rests for as long as the server says while the next one takes over. Then build the retrieval index with `npm run rag:index`; rerun it after changing the schema, the semantic layer or the examples.

```bash
npm run ask -- "how many rentals came back late during spring 2025 move-out?"
npm run ask -- --role=student --as-user=<student uuid> "how much have I earned from selling?"
npm run test:agent-guard   # security checks: guard, PII masking, my_* isolation, the student-only login (changes nothing)
npm run test:env -- npm run test:redteam   # rogue-model red team through /api/ask (local test stack only; see docs/TESTING.md)
npm run test:retrieval     # retriever finds the right views and values; no model calls
npm run test:cache         # near-misses never hit, entries stay in their role and student
npm run smoke:agent        # varied questions through the full graph
```

### Evaluation

`eval/eval-set.json` holds hand-written questions, each `answer` item with two independently written gold queries; `refuse` and `clarify` items test behavior. The agent's prompts are frozen at git tag `agent-v2-frozen` (prompt `v2`, semantic layer `s4`): changes after it mean a new version.

```bash
npm run eval:verify              # both gold queries agree, 1-200 rows, no leaks from the verified examples (no model calls)
npm run eval                     # score the teacher; report in eval/reports/
npm run eval -- --model=student  # score a student model (STUDENT_BASE_URL, STUDENT_MODEL, STUDENT_VERSION)
npm run test:compare             # unit checks for the result comparison
```

Scoring is execution accuracy (`src/lib/agent/compare.ts`): the agent's result must match the gold result; column names and order don't matter, numbers match at shared precision, percentages match fractions, row order counts only when the question asks for it. `eval/audit-pilot.md` is the human audit sheet for the pilot.

## Listing photos

Stand-in photos come from Openverse and Wikimedia Commons under licenses that allow reuse and editing (CC0, Public Domain, CC BY, CC BY-SA). Nothing is scraped from marketplaces or social networks. Every photo was reviewed by hand, and only ones that clearly show the item, with no person as the subject, were kept. Each is credited on its listing and under **Profile → Photo credits**. Three edited versions of each (crop, mirror, color) reduce repetition. New uploads from students go to the `item-images` Storage bucket.
