# HuskySwap

A marketplace for Northeastern students: buy, sell, and borrow things for a week. Sign-in needs an `@northeastern.edu` email. Payment happens in person at a campus meetup spot.

The app runs on **Supabase** (Postgres, Auth, Storage, Realtime). The database holds ~1,000 synthetic students and their listings, deals and chats, which makes it a ready dataset for a text-to-SQL project.

Design: `app-design.html` (navy surfaces, cyan-to-indigo action gradient, Sora + Figtree). Dark is the default theme. Switch to light under **Profile → App theme**.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

Needs `.env.local` (git-ignored) with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `DATABASE_URL` for the scripts. On a phone, open `http://<your-computer's-IP>:3000` on the same Wi-Fi and use **Add to Home Screen**.

### Demo sign-in (current)

Email codes aren't set up yet. With `DEMO_LOGIN=true` and `NEXT_PUBLIC_DEMO_LOGIN=true`, any `@northeastern.edu` email gets in and the code screen accepts any 6 digits; no email is sent (`src/app/api/demo-login/route.ts`). It works for new accounts and for any seeded student, which is handy for playing the seller in a deal. It doesn't prove anyone owns their email, so turn it off before real students use the app: remove both settings and set up the email codes below.

### Sign-in emails (one-time setup in the Supabase dashboard)

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
| `scripts/seed-supabase.mjs` | Generates and loads the synthetic dataset |
| `scripts/sql.mjs` | Run SQL from the terminal, optionally as a text-to-SQL role |
| `scripts/test-rls.mjs`, `scripts/smoke-client.mjs` | Security and end-to-end checks (they change nothing permanently) |
| `scripts/catalog.mjs` | Item templates (titles, prices, photo search terms) |
| `scripts/fetch-images.mjs`, `fetch-commons.mjs`, `make-variants.mjs` | Stand-in listing photos (`public/items/`, credits in `src/data/photos.json`) |

Stack: Next.js 16 (App Router, React 19, TypeScript), Tailwind CSS 4, Supabase, lucide-react icons.

**Security model.** Signed-out visitors get nothing. Signed-in students can read marketplace data (listings, profiles, reviews) and only their own private data (chats, deals, saved items, reports). Every change goes through a database function that enforces the rules: no buying your own item, one active deal per item, 7-day rentals, reviews only after a completed deal. Check it with `npm run test:rls` and `node scripts/smoke-client.mjs`.

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

### Daily simulator and drift

```bash
node scripts/simulate-day.mjs                     # simulate the last 24 hours (run daily)
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

## Listing photos

Stand-in photos come from Openverse and Wikimedia Commons under licenses that allow reuse and editing (CC0, Public Domain, CC BY, CC BY-SA). Nothing is scraped from marketplaces or social networks. Every photo was reviewed by hand, and only ones that clearly show the item, with no person as the subject, were kept. Each is credited on its listing and under **Profile → Photo credits**. Three edited versions of each (crop, mirror, color) reduce repetition. New uploads from students go to the `item-images` Storage bucket.
