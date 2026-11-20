# HuskySwap

**Live at [huskyswap.vercel.app](https://huskyswap.vercel.app), in active testing with 50+ Northeastern students.**

https://github.com/user-attachments/assets/14ecfc57-e97d-4536-988a-8990b7918412

HuskySwap is a marketplace for Northeastern students. You can buy, sell, or borrow something for a week, and you pay in person at a campus meetup spot. It also has an assistant, **Ask HuskySwap**: you ask a question in plain English ("cheapest graphing calculators right now?", "how much have I made selling this semester?"), and it writes the SQL, runs it, and answers. The assistant runs on a small model distilled from a 120B one.

Sign in with your `@northeastern.edu` email and pick a display name. On a phone, use Share → **Add to Home Screen** (iPhone) or **Install app** (Android) and it works like a normal app.

## Why I built it

At every move-out, good stuff (mini fridges, monitors, textbooks) ends up in group chats or on the curb. I wanted one place for it that's just for Northeastern students, with rentals for things you only need for a week.

The assistant came from a second question: how close can a 4B model get to a 120B one at text-to-SQL if it learns from the big model's work? I had no budget, so everything runs on free tiers: Supabase, Vercel, Groq for the teacher model, and Colab plus Northeastern's Explorer cluster for training.

## How it works

**The marketplace** is Next.js 16 (React 19, TypeScript, Tailwind 4) on Supabase: Postgres, Auth, Storage for photos, and Realtime for chat. The rules live in the database. Row-level security decides what each student can see, and every write goes through a Postgres function that checks things like "you can't buy your own item" and "one active deal per item".

**The assistant** (`src/lib/agent/`) is a fixed graph rather than a free-running agent:

```
question → cache → retrieve context → clarify if ambiguous → write SQL (tool calls) → guard → run → answer
```

The model is treated as untrusted, so it never decides whose data it sees. Student questions run on a separate read-only database login that can't switch to the admin role, the `my_*` views filter on the user id from the verified session, and every query goes through Postgres's own parser before it runs. More in [docs/ASSISTANT.md](docs/ASSISTANT.md).

**The distilled model** (`ml/`): gpt-oss-120b generated multi-step tool-calling traces, and Qwen3-4B was fine-tuned on them with LoRA in two stages. Scored by execution accuracy on 318 held-out, hand-written questions, each with two independently written gold queries:

| Model | Size | Overall | SQL answers | Refusals | Tokens / question |
|---|---|---|---|---|---|
| Teacher: gpt-oss-120b | 120B | 85.2% | 83.8% | 85.7% | 4,229 |
| Qwen3-4B, untrained | 4B | 56.4% | 57.4% | 25.0% | 8,299 |
| **HuskySwap student (r3)** | **4B** | **75.9%** | **72.0%** | **92.9%** | **~3,800** |
| HuskySwap student, Qwen3-8B (r3-8b) | 8B | 75.8% | 71.0% | – | – |

The student and base rows are the mean of 3 runs; the teacher row is one run. The 4B student closes about two-thirds of the gap to a model 30× its size and refuses unsafe questions more often than the teacher does. The 8B student scored about the same as the 4B, so the 4B is the one I use. Reports are in `eval/reports/`, and `ml/registry.json` tracks model versions.

## Things that broke along the way

- **The inbox under load.** In a 50-user load test, database CPU hit 392% and some requests took 8.4 s. Every live update made each phone reload its whole inbox, and the security policy behind that query scanned every message in the marketplace. Rewriting the policies around indexed lookups (`supabase/migrations/0010_rls_performance.sql`) and merging live updates in place instead of refetching (`src/lib/realtime-merge.ts`) brought CPU down to 88% and p95 under 400 ms.
- **Rental hand-overs.** Handing over a rental crashed the buyer's deal screen: the status update arrived over Realtime before the rental details did. The screen now keeps the previous state until the details load, and a unit test covers it.
- **Free-tier limits.** Groq's free tier allows about 200K tokens a day, which is only 25–30 assistant questions. Each student gets one question at a time and a daily limit, reserved in the database before the run starts so parallel requests can't get around it.

## Testing

All of this runs against a local copy of the stack in Docker, never production ([docs/TESTING.md](docs/TESTING.md)).

| Check | Result |
|---|---|
| Load test: 50 concurrent users for 10 minutes (browsing, chat, deals, listings, the assistant) | 0 errors in ~27,000 requests, p95 under 400 ms, every chat message delivered live |
| Red team: a fully compromised model attacks through `/api/ask` | 0 leaks of another student's data in 232 runs |
| Unit tests (Vitest) | 777 passing |
| End-to-end tests (Playwright, phone and desktop) | 61 passing |
| Database security rules and the SQL guard | `npm run test:rls`, `npm run test:agent-guard` |

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

You'll need a `.env.local` with your Supabase keys. Sign-in options, seeding the database, setting up the assistant and running the evals are in [docs/SETUP.md](docs/SETUP.md).

## Where things are

| Path | What |
|---|---|
| `src/app/` | Pages: home, item, sell, chats, deals, saved, profile, sign-in, `/api/ask` |
| `src/lib/store.tsx` | App data: loads what the signed-in student can see, live updates |
| `src/lib/agent/` | The assistant |
| `supabase/` | Schema, migrations, security rules |
| `ml/` | Training data generation, LoRA training, cluster jobs, model registry |
| `eval/` | Eval sets, reports and gates |
| `scripts/` | Seeding, SQL CLI, load test, red team, test helpers |
| `tests/` | Unit and end-to-end tests |

Listing photos are openly licensed (Openverse and Wikimedia Commons), reviewed by hand, and credited in the app under **Profile → Photo credits**.

## What's next

- Google sign-in (the code is done; it needs the OAuth setup)
- Offers and counter-offers, editing a listing, photos in chat
- Rental dates and deposit tracking
