# Setup

Everything you need to run HuskySwap yourself. For how the tests work, see [TESTING.md](TESTING.md); for how the assistant works, see [ASSISTANT.md](ASSISTANT.md).

## Running locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Needs `.env.local` (git-ignored) with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `DATABASE_URL` for the scripts. To try it on a phone, open `http://<your-computer's-IP>:3000` on the same Wi-Fi and use **Add to Home Screen**.

The app follows the device's light or dark setting; you can change it under **Profile → App theme**. Design tokens (colors, Fraunces headings, DM Sans text, Northeastern red for actions) live in `src/app/globals.css`.

## Sign-in

### Google (planned)

The code is ready (`NEXT_PUBLIC_GOOGLE_LOGIN=true` turns it on). Google proves the person owns the account, so nobody can sign in as someone else. A new account gets the "What should we call you?" step, prefilled with its Google name. Google accounts may use any email; everything else stays `@northeastern.edu`-only (`supabase/migrations/0012_google_sign_in.sql`).

One-time setup (free):

1. **Google Cloud Console → APIs & Services → OAuth consent screen**: external, app name HuskySwap, your email as support contact; publish it (no sensitive scopes, so no review).
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. Copy the client ID and secret.
3. **Supabase dashboard → Authentication → Sign In / Providers → Google**: enable it and paste the client ID and secret.
4. **Supabase → Authentication → URL Configuration**: Site URL `https://huskyswap.vercel.app`; redirect URLs `https://huskyswap.vercel.app/login` and `http://localhost:3000/login`.
5. **Vercel → Environment Variables**: set `NEXT_PUBLIC_GOOGLE_LOGIN=true`, then redeploy.

### Demo sign-in (testing only)

With `DEMO_LOGIN=true` and `NEXT_PUBLIC_DEMO_LOGIN=true`, the sign-in screen offers a Northeastern email form whose code screen accepts any 6 digits; no email is sent (`src/app/api/demo-login/route.ts`). It doesn't verify the email, so turn it off once Google sign-in is live. Admin and suspended accounts can't use it, and it's rate-limited per IP. The local test stack uses it (`.env.test`).

### Northeastern email codes (optional)

To send real one-time codes to `@northeastern.edu` addresses, set `NEXT_PUBLIC_EMAIL_LOGIN=true` and:

1. **Authentication → Emails → Templates**: in both **Magic link** and **Confirm signup**, add the code, e.g. `<p>Your HuskySwap code: <strong>{{ .Token }}</strong></p>`. Without `{{ .Token }}`, Supabase sends a link instead of a code.
2. **Authentication → Emails → SMTP settings**: Supabase's built-in email only sends to your own organization's members and only a few emails per hour. To email any student, add Resend as the SMTP server: host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key. Resend needs a verified sending domain to email anyone besides you.

## Database

Supabase project `huskyswap` (`kjjfyfkkmrpasdesgqib`, us-east-1). The schema is `supabase/schema.sql` plus the migrations in `supabase/migrations/`; the ER diagram is `docs/EER_v2.1.drawio`.

### Seed data

```bash
npm run seed -- --dry-run    # generate and print stats only
npm run seed -- --reset      # replace the seed data in the database
```

The seed (`scripts/seed-supabase.mjs`, about 30 s) creates three academic years of activity, starting at Fall 2023 move-in, so the assistant has history to answer questions about:

| | |
|---|---|
| Students | 3,000. They join at semester starts and graduate after 4–5 years (co-op), then stop trading; some deactivate. |
| Listings | ~13,300 with photos, including ~500 reposts at a lower price. Graduating seniors clear out their rooms in late April. |
| Deals | ~13,700: sales (some negotiated down), 7-day rentals (~18% returned late, a few overdue now), declined, cancelled and open requests |
| Conversations / messages | ~22,000 / ~99,000 |
| Reviews | ~15,000. Lenders rate late (3.4) and damaged (3.0) returns lower than on-time ones (4.4), and slow-replying sellers rate lower. |
| Saved items / reports | ~9,000 / 160 |

User-written text is deliberately messy (`scripts/messy.mjs`): typos, abbreviations ("graphing calc", "Orgo"), lowercase or ALL CAPS, emoji, "**everything must go**" suffixes, empty or one-word descriptions, chat slang ("thx", "lmk"), a few free items and wildly overpriced outliers. Activity follows the academic calendar: move-in, finals, move-out, quiet summers. The seed runs in one transaction.

Seeded accounts have no password and are never emailed, so nobody can sign in as one. They sit alongside the accounts of the 50+ students testing the app, and `--reset` replaces only seeded data, never a tester's account or activity.

### Daily activity and drift

```bash
node scripts/simulate-day.mjs                     # add the last 24 hours of activity (run daily)
node scripts/simulate-day.mjs --days=7 --dry-run  # preview a week without writing
node scripts/simulate-day.mjs --trend=vision-pro --new-spot="ISEC Building" --inflation=1.2 --surge=3
```

Each run adds new students, listings, chats, saves and requests, moves deals forward, checks in rentals that are due, and adds reviews and reports, at rates that follow the academic calendar. The drift options add things the model has never seen: new product types (`vision-pro`, `stanley-cup`, `e-bike`, `ai-pin`), a new meetup spot, price inflation, or an activity surge. Every run is logged in `ops.simulation_runs`.

### Running SQL

- **Supabase dashboard → SQL Editor**: full access, good for exploring.
- **Terminal**:
  ```bash
  npm run sql -- "select category, count(*) from public.items group by 1 order by 2 desc"
  npm run sql -- --as=nlq_student "select title, sale_price from nlq.listings order by sale_price limit 5"
  ```
  `--as` runs the query as a text-to-SQL role in a read-only transaction.
- **Any Postgres client** (DBeaver, TablePlus, VS Code, Python `psycopg`) with the `DATABASE_URL` connection string.

## The assistant

Apply migrations `0004_agent.sql`, `0005_agent_graph.sql` and `0011_assistant_hardening.sql`, then add to `.env.local`:

- `NLQ_DATABASE_URL`: user `nlq_agent.<project-ref>` on the session pooler.
- `NLQ_STUDENT_DATABASE_URL`: user `nlq_agent_student.<project-ref>` on the transaction pooler, port 6543. Without it, students fall back to `nlq_agent` and the server logs a warning.
- `TEACHER_BASE_URL`, `TEACHER_API_KEY`, `TEACHER_MODEL`: e.g. Groq's free tier with `openai/gpt-oss-120b`. Optional `TEACHER_API_KEYS` (comma-separated) adds keys to a pool: requests go round-robin, and a rate-limited key rests for as long as the server says.
- `STUDENT_BASE_URL`, `STUDENT_MODEL`: the distilled model's server (vLLM).

Then build the retrieval index with `npm run rag:index`. Rerun it after changing the schema, the semantic layer or the examples.

```bash
npm run ask -- "how many rentals came back late during spring 2025 move-out?"
npm run ask -- --role=student --as-user=<student uuid> "how much have I earned from selling?"
npm run test:agent-guard   # guard, PII masking, my_* isolation, the student-only login (changes nothing)
npm run test:retrieval     # retriever finds the right views and values; no model calls
npm run test:cache         # near-misses never hit, entries stay in their role and student
npm run smoke:agent        # varied questions through the full graph
```

### Evaluation

```bash
npm run eval:verify              # both gold queries agree, 1-200 rows, no leaks from the verified examples (no model calls)
npm run eval                     # score the teacher; report in eval/reports/
npm run eval -- --model=student  # score a student model (STUDENT_BASE_URL, STUDENT_MODEL, STUDENT_VERSION)
npm run test:compare             # unit checks for the result comparison
```

The training pipeline (data generation, two-stage LoRA, cluster jobs) is in `ml/`; see `ml/hpc/README.md` for running it on the Explorer cluster.

## Listing photos

Stand-in photos come from Openverse and Wikimedia Commons under licenses that allow reuse and editing (CC0, Public Domain, CC BY, CC BY-SA). Nothing is scraped from marketplaces or social networks. Every photo was reviewed by hand, and only ones that clearly show the item, with no person as the subject, were kept. Each is credited on its listing and under **Profile → Photo credits** (`src/data/photos.json`). Three edited versions of each (crop, mirror, color) reduce repetition. Scripts: `scripts/fetch-images.mjs`, `fetch-commons.mjs`, `make-variants.mjs`, `catalog.mjs`. New uploads from students go to the `item-images` Storage bucket.
