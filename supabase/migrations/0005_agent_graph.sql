-- =====================================================================
-- 0005: agent v2 (the graph): students' own data, the retrieval index,
-- the semantic cache, and richer run logs.
--
--   * my_* views: a student's own listings, deals, saved items and reviews.
--     Filtered by app.user_id, which only the server sets (per transaction,
--     from the verified session); the model can't read or set it (the SQL
--     guard blocks set_config/current_setting and SET). Unset = no rows.
--     The other party in a deal is never shown. security_barrier keeps the
--     planner from running a user's filter (e.g. a division that errors on
--     one row) before the user filter, which could reveal others' rows.
--   * ops.rag_docs: what the context retriever searches: views, columns,
--     stored values, glossary entries and verified example queries, each
--     tagged with the roles allowed to see it. Vector (gte-small, 384) plus
--     trigram search.
--   * ops.query_cache: resolved question -> SQL, scoped by role, and by
--     user when the SQL reads my_* views.
-- =====================================================================

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- Students' own data
-- ---------------------------------------------------------------------
create or replace view nlq.my_listings with (security_barrier) as
select l.item_id, l.title, l.description, l.category, l.condition, l.status,
       l.sale_price, l.rent_price_per_week, l.rent_deposit, l.is_for_sale, l.is_for_rent,
       s.name as meetup_spot, l.listed_at, l.listed_on
from nlq.listings_all l
join public.meetup_spots s on s.spot_id = l.spot_id
where l.seller_id = nullif(current_setting('app.user_id', true), '')::uuid;
comment on view nlq.my_listings is 'The asking student''s own listings, in any status (available, reserved, rented_out, sold, removed). Prices in USD.';
comment on column nlq.my_listings.status is 'available, reserved, rented_out, sold or removed.';
comment on column nlq.my_listings.listed_on is 'Boston-local date the listing was posted. Join to calendar.day.';

create or replace view nlq.my_deals with (security_barrier) as
select d.deal_id, d.item_id, l.title as item_title, l.category,
       case when d.buyer_id = me.id then 'buyer' else 'seller' end as my_role,
       d.deal_type, d.status, d.agreed_price, d.requested_at, d.completed_at,
       d.rental_start_date, d.rental_due_date, d.rental_returned_at, d.return_condition,
       d.returned_late, d.is_overdue, d.requested_on, d.completed_on
from nlq.deals d
join nlq.listings_all l on l.item_id = d.item_id
cross join (select nullif(current_setting('app.user_id', true), '')::uuid as id) me
where me.id in (d.buyer_id, d.seller_id);
comment on view nlq.my_deals is 'Purchases and rentals the asking student took part in, as buyer (borrower) or seller (lender). The other student is never shown. A deal moves requested -> accepted -> handed_over -> completed (rentals pass through returned), or ends declined / cancelled.';
comment on column nlq.my_deals.my_role is 'buyer: the student bought or borrowed the item. seller: the student sold or lent it.';
comment on column nlq.my_deals.status is 'requested, accepted, declined, handed_over, returned (rentals only), completed or cancelled.';
comment on column nlq.my_deals.agreed_price is 'Price agreed (USD); for rentals the price of the one-week rental. What the student earned (as seller) or paid (as buyer) on completed deals.';
comment on column nlq.my_deals.requested_on is 'Boston-local date of the request. Join to calendar.day.';
comment on column nlq.my_deals.completed_on is 'Boston-local date the deal completed; null if not completed.';

create or replace view nlq.my_saved_items with (security_barrier) as
select s.item_id, l.title, l.category, l.status, l.sale_price, l.rent_price_per_week, s.saved_at, s.saved_on
from nlq.saved_items s
join nlq.listings_all l on l.item_id = s.item_id
where s.student_id = nullif(current_setting('app.user_id', true), '')::uuid;
comment on view nlq.my_saved_items is 'Listings the asking student saved (the heart button), with their current status and price.';
comment on column nlq.my_saved_items.saved_on is 'Boston-local date the listing was saved.';

create or replace view nlq.my_reviews with (security_barrier) as
select r.review_id, r.deal_id,
       case when r.reviewee_id = me.id then 'received' else 'given' end as direction,
       r.rating, r.reviewed_at, r.reviewed_on
from nlq.reviews r
cross join (select nullif(current_setting('app.user_id', true), '')::uuid as id) me
where me.id in (r.reviewer_id, r.reviewee_id);
comment on view nlq.my_reviews is 'Star ratings the asking student received from others or gave to others after completed deals. Who wrote them is not shown.';
comment on column nlq.my_reviews.direction is 'received (someone rated this student) or given (this student rated someone).';
comment on column nlq.my_reviews.rating is '1 to 5 stars.';

grant select on nlq.my_listings, nlq.my_deals, nlq.my_saved_items, nlq.my_reviews to nlq_student, nlq_admin;

-- ---------------------------------------------------------------------
-- Retrieval index
-- ---------------------------------------------------------------------
create table if not exists ops.rag_docs (
  doc_id         bigserial primary key,
  kind           text not null check (kind in ('view', 'column', 'value', 'glossary', 'example')),
  roles          text[] not null,            -- nlq roles allowed to retrieve it
  view_name      text,
  column_name    text,
  value          text,                       -- kind = value: the stored value
  content        text not null,              -- the text that was embedded
  meta           jsonb not null default '{}',
  embedding      extensions.vector(384) not null,
  index_version  text not null
);
create index if not exists rag_docs_embedding_idx on ops.rag_docs using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists rag_docs_value_trgm_idx on ops.rag_docs using gin (lower(value) extensions.gin_trgm_ops) where kind = 'value';

-- ---------------------------------------------------------------------
-- Semantic cache
-- ---------------------------------------------------------------------
create table if not exists ops.query_cache (
  cache_id       bigserial primary key,
  created_at     timestamptz not null default now(),
  last_hit_at    timestamptz,
  hits           int not null default 0,
  db_role        text not null,
  user_id        uuid,                       -- set when the SQL reads my_* views: only this student can hit it
  question       text not null,              -- the resolved question (after any clarification)
  slots          jsonb not null,             -- numbers, superlatives, negations, time words, key terms
  sql            text not null,
  answer         text not null,
  result_hash    text not null,              -- reuse the answer text only while the result is unchanged
  valid_until    timestamptz,                -- questions about "today", "this week"... expire
  run_id         uuid,
  cache_version  text not null,              -- prompt + schema + semantic layer versions
  embedding      extensions.vector(384) not null
);
create index if not exists query_cache_embedding_idx on ops.query_cache using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------
-- Run log: the graph's path
-- ---------------------------------------------------------------------
alter table ops.agent_runs
  add column if not exists resolved_question text,
  add column if not exists cache_hit boolean not null default false,
  add column if not exists clarification jsonb,   -- what was asked and the options
  add column if not exists retrieval jsonb,       -- views, values, glossary, examples (with scores)
  add column if not exists nodes jsonb,           -- [{node, ms, outcome}]
  add column if not exists calls jsonb;           -- every model call: node, messages, reply, tokens
alter table ops.agent_runs drop constraint if exists agent_runs_status_check;
alter table ops.agent_runs add constraint agent_runs_status_check
  check (status in ('answered', 'refused', 'clarify', 'gave_up', 'error'));
