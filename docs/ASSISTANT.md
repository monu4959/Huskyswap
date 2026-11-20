# Ask HuskySwap: how the assistant works

Students and admins ask questions in plain English on the **Ask** screen (the husky button). The agent is a fixed graph (`src/lib/agent/graph.ts`), and the same code runs in the app, the CLI, training-data generation and the evals:

```
question → [1] semantic cache ──hit──► re-run stored SQL → answer
         → [3] context retriever (views, values, definitions, past queries; no model)
         → [2] ambiguous? (sees what [3] found) ──yes──► clarifying question
         → [4] SQL node → [5] guardrails → [6] execute ──error / empty──► back to [4]
         → [7] answer + grounding check → stored in the cache
```

| File | Node | What it does |
|---|---|---|
| `cache.ts` | 1 | Hits only on similarity ≥ 0.95 *and* the same numbers, polarity (cheapest vs most expensive), time words and key terms. Scoped by role, and by student for `my_*` SQL. Re-runs the SQL on a hit; "today / this week" entries expire at midnight; a thumbs-down removes the entry |
| `retrieve.ts` | 3 | pgvector (gte-small, run locally) over `ops.rag_docs`, plus trigram matching of stored values and exact aliases; picks 5–10 views and their joins. Every entry is tagged with the roles allowed to see it |
| `clarify.ts` | 2 | Asks only when the readings give materially different answers (at most 2 rounds), never for requests for personal information |
| `sql-node.ts` | 4–6 | Tools `lookup_values`, `run_sql`, `submit_sql`; at most 6 model calls, 3 failed queries and 2 lookups; repeated calls deduplicated; an empty result is questioned once |
| `answer.ts` | 7 | One to three sentences; every number must appear in the result (one retry); contact details masked |
| `guard.ts` | 5 | Postgres's own parser: one SELECT, `nlq` views and columns the role may see, allowlisted functions |
| `db.ts` | 6 | Student questions run on the `nlq_agent_student` login, admin questions on `nlq_agent`: read-only transaction, role switch, server-set `app.user_id` for `my_*` views, timeout, 200-row cap, PII masking |
| `semantic-layer.ts`, `examples.ts` | – | Business terms, value aliases, metrics, join paths; verified example queries (never eval questions) |

Each run has a budget (30K tokens, 110 s) and is logged in `ops.agent_runs`, with each node's outcome and every model call. Each student can ask one question at a time, with per-minute and per-day limits (`ops.ask_quota`). The agent never writes data.

## Keeping other students' data private

The model is treated as untrusted, so the protections sit below it:

1. Student questions run on a database login that can only read current listings, meetup spots, categories, the calendar, and that student's own `my_*` views. No view it can see holds other students' deals, earnings or chats, and it can't switch to the admin role (`0011_assistant_hardening.sql`).
2. `my_*` views filter on the student id the server takes from the verified session; the model never sets it.
3. The `nlq` views hold no names, emails or message text, and are security barriers, so a crafted query can't make an error message quote hidden rows.
4. Every query passes Postgres's own parser first: one read-only SELECT, allowed views and functions only, no role or setting changes, no size-bomb functions. It runs read-only with a timeout and a row cap.
5. Results, errors, clarifying questions and answers are masked for emails, phone numbers and links.
6. A cached answer is never shown to a different student: its SQL re-runs as the new asker.

`npm run test:env -- npm run test:redteam` replays the attack set (a fully compromised model attacking through `/api/ask`) against the local stack.

## The `nlq` schema

The model only ever queries the `nlq` schema (`supabase/migrations/0003_nlq_analytics.sql`): a small star schema with no personal data. Every view and column has a comment, and those comments are the model's schema guide.

| Kind | Views |
|---|---|
| Facts | `listings_all`, `deals`, `reviews`, `conversations` (counts and reply times only), `saved_items`, `reports` |
| Dimensions | `students` (opaque id, joined_at, status), `meetup_spots` (on or off campus), `categories` (with groups), `calendar` (2019–2030: semester, move-in / finals / move-out periods, US and Massachusetts holidays such as Patriots' Day) |
| Student-facing | `listings`: what's available right now |

Every timestamp also has a Boston-local `*_on` date (e.g. `listed_on`) that joins to `calendar.day`, so "last Tuesday" is unambiguous. `nlq_student` sees only `listings`, `meetup_spots`, `categories`, `calendar` and its own `my_*` views; `nlq_admin` sees everything. Both roles are read-only with 3–5 s timeouts.

## Evaluation

`eval/eval-set.json` (dev) and `eval/test-set.json` (318 held-out questions) are hand-written. Each `answer` item has two independently written gold queries; `refuse` and `clarify` items test behavior. Prompts are frozen at git tags (`agent-v2-frozen` … `agent-v4-frozen`); any change after a tag means a new version.

Scoring is execution accuracy (`src/lib/agent/compare.ts`): the agent's result must match the gold result. Column names and order don't matter, numbers match at shared precision, percentages match fractions, and row order counts only when the question asks for it. `eval/audit-pilot.md` is the human audit sheet for the pilot. Model versions, their eval reports and which one is serving are tracked in `ml/registry.json` (`npm run registry`).
