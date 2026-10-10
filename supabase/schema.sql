-- =====================================================================
-- Northeastern Marketplace: database schema v2.1 (Supabase / Postgres)
-- Matches EER_v2.1.drawio.
--
-- Run on a fresh Supabase project, either in the SQL editor or as a
-- migration (`supabase migration new init`, paste this, `supabase db push`).
--
-- Conventions: plural table names, snake_case, lowercase enum values.
--
-- IMPORTANT: Row Level Security is enabled on every table but no policies
-- exist yet, so the app cannot read or write anything through the API
-- until policies are added. That is intentional: secure by default.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Value lists (enums)
-- ---------------------------------------------------------------------
create type public.user_role          as enum ('student', 'admin');
create type public.account_status     as enum ('active', 'suspended', 'deactivated');
create type public.item_category      as enum ('textbooks', 'electronics', 'furniture', 'kitchen',
                                               'clothing', 'dorm_essentials', 'sports_outdoors',
                                               'bikes_transport', 'other');
create type public.item_condition     as enum ('new', 'like_new', 'good', 'fair');
create type public.item_status        as enum ('available', 'reserved', 'rented_out', 'sold', 'removed');
create type public.transaction_type   as enum ('sale', 'rental');
create type public.transaction_status as enum ('requested', 'accepted', 'declined', 'handed_over',
                                               'returned', 'completed', 'cancelled');
create type public.return_condition   as enum ('as_lent', 'minor_wear', 'damaged');
create type public.report_status      as enum ('open', 'in_review', 'resolved');


-- ---------------------------------------------------------------------
-- 2. Users
-- Supabase Auth owns the email and its verification
-- (auth.users.email, auth.users.email_confirmed_at).
-- Everything else from the EER's User entity lives here.
-- Deactivate accounts instead of deleting them, so past
-- transactions and reviews stay intact.
-- ---------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 80),
  role           public.user_role      not null default 'student',
  account_status public.account_status not null default 'active',
  created_at     timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 3. Meetup spots (Boston only in v1)
-- To expand to other campuses later, add:  campus text not null default 'Boston'
-- ---------------------------------------------------------------------
create table public.meetup_spots (
  spot_id smallint generated always as identity primary key,
  name    text not null unique
);


-- ---------------------------------------------------------------------
-- 4. Items and their sale / rental terms
-- Every item must have a row in buyable_items and/or borrowable_items.
-- Plain constraints can't check that across tables, so the
-- create-listing database function (next step) enforces it.
-- ---------------------------------------------------------------------
create table public.items (
  item_id        bigint generated always as identity primary key,
  owner_id       uuid     not null references public.profiles (id),
  meetup_spot_id smallint not null references public.meetup_spots (spot_id),
  title          text not null check (char_length(title) between 3 and 100),
  description    text not null default '' check (char_length(description) <= 2000),
  category       public.item_category  not null,
  condition      public.item_condition not null,
  status         public.item_status    not null default 'available',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- full-text search over title + description
  search         tsvector generated always as
                   (to_tsvector('english', title || ' ' || description)) stored
);

create table public.buyable_items (
  item_id bigint primary key references public.items (item_id) on delete cascade,
  price   numeric(8,2) not null check (price >= 0)
);

create table public.borrowable_items (
  item_id        bigint primary key references public.items (item_id) on delete cascade,
  price_per_week numeric(8,2) not null check (price_per_week >= 0),
  deposit        numeric(8,2) not null default 0 check (deposit >= 0)
);

create table public.item_images (
  image_id     bigint generated always as identity primary key,
  item_id      bigint   not null references public.items (item_id) on delete cascade,
  storage_path text     not null,            -- path inside the Supabase Storage bucket
  position     smallint not null default 0,  -- display order, 0 = cover photo
  unique (item_id, position)
);

create table public.saved_items (
  user_id  uuid   not null references public.profiles (id) on delete cascade,
  item_id  bigint not null references public.items (item_id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (user_id, item_id)
);


-- ---------------------------------------------------------------------
-- 5. Messaging
-- One conversation per item per interested buyer. The seller is the
-- item's owner, so it isn't stored again here.
-- ---------------------------------------------------------------------
create table public.conversations (
  conversation_id bigint generated always as identity primary key,
  item_id         bigint not null references public.items (item_id),
  buyer_id        uuid   not null references public.profiles (id),
  created_at      timestamptz not null default now(),
  unique (item_id, buyer_id)
);

create table public.messages (
  message_id      bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations (conversation_id) on delete cascade,
  sender_id       uuid   not null references public.profiles (id),
  body            text   not null check (char_length(body) between 1 and 2000),
  sent_at         timestamptz not null default now(),
  read_at         timestamptz
);


-- ---------------------------------------------------------------------
-- 6. Transactions and rentals
-- ---------------------------------------------------------------------
create table public.transactions (
  transaction_id bigint generated always as identity primary key,
  item_id        bigint not null references public.items (item_id),
  buyer_id       uuid   not null references public.profiles (id),   -- buyer or borrower
  type           public.transaction_type   not null,
  agreed_price   numeric(8,2) not null check (agreed_price >= 0),   -- snapshot; listing price can change later
  status         public.transaction_status not null default 'requested',
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (transaction_id, type),                        -- lets rentals require type = 'rental'
  check (completed_at is null or status = 'completed'),
  check (type = 'rental' or status <> 'returned')       -- sales are never "returned"
);

-- A buyer can have only one open request per item.
create unique index transactions_one_open_request
  on public.transactions (item_id, buyer_id)
  where status in ('requested', 'accepted', 'handed_over');

-- At most one accepted / in-progress deal per item at a time,
-- so two buyers can never both be accepted.
create unique index transactions_one_active_deal
  on public.transactions (item_id)
  where status in ('accepted', 'handed_over');

create table public.rentals (
  transaction_id   bigint primary key,
  type             public.transaction_type not null default 'rental' check (type = 'rental'),
  start_date       date not null,
  due_date         date not null,
  deposit_agreed   numeric(8,2) not null default 0 check (deposit_agreed >= 0),
  returned_at      timestamptz,
  return_condition public.return_condition,
  -- composite key guarantees a rental can only attach to a rental transaction
  foreign key (transaction_id, type)
    references public.transactions (transaction_id, type) on delete cascade,
  -- v1: every rental lasts exactly one week, so agreed_price = price_per_week
  check (due_date = start_date + 7)
);


-- ---------------------------------------------------------------------
-- 7. Reviews (one per side per completed transaction)
-- That the reviewer and reviewee are the transaction's two parties,
-- and that it's completed, is enforced by a database function (next step).
-- ---------------------------------------------------------------------
create table public.reviews (
  review_id      bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (transaction_id),
  reviewer_id    uuid   not null references public.profiles (id),
  reviewee_id    uuid   not null references public.profiles (id),
  rating         smallint not null check (rating between 1 and 5),
  comment        text check (char_length(comment) <= 1000),
  created_at     timestamptz not null default now(),
  unique (transaction_id, reviewer_id),
  check (reviewer_id <> reviewee_id)
);


-- ---------------------------------------------------------------------
-- 8. Reports (moderation)
-- ---------------------------------------------------------------------
create table public.reports (
  report_id        bigint generated always as identity primary key,
  reporter_id      uuid   not null references public.profiles (id),
  item_id          bigint references public.items (item_id),
  transaction_id   bigint references public.transactions (transaction_id),
  reported_user_id uuid   references public.profiles (id),
  reason           text   not null check (char_length(reason) between 5 and 1000),
  status           public.report_status not null default 'open',
  admin_notes      text,
  resolved_by      uuid   references public.profiles (id),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  check (num_nonnulls(item_id, transaction_id, reported_user_id) >= 1),
  check ((status = 'resolved') = (resolved_at is not null))
);


-- ---------------------------------------------------------------------
-- 9. Indexes (Postgres does not index foreign keys automatically)
-- ---------------------------------------------------------------------
create index on public.items (owner_id);
create index on public.items (meetup_spot_id);
create index on public.items (status, category);
create index on public.items using gin (search);
create index on public.saved_items (item_id);
create index on public.conversations (buyer_id);
create index on public.messages (conversation_id, sent_at);
create index on public.transactions (item_id);
create index on public.transactions (buyer_id);
create index on public.reviews (reviewee_id);
create index on public.reports (status);


-- ---------------------------------------------------------------------
-- 10. Triggers
-- ---------------------------------------------------------------------

-- Only @northeastern.edu addresses can sign up or switch their email.
-- (Alternative: Supabase's "Before User Created" auth hook, which gives
-- the app a cleaner error message than a failed trigger.)
create or replace function public.enforce_nu_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is null or lower(new.email) !~ '^[^@]+@northeastern\.edu$' then
    raise exception 'Only @northeastern.edu email addresses can register';
  end if;
  return new;
end;
$$;

create trigger enforce_nu_email
  before insert or update of email on auth.users
  for each row execute function public.enforce_nu_email();

-- Create a profile automatically when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data ->> 'name', ''),
                  split_part(new.email, '@', 1)), 80)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep items.updated_at current.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger items_set_updated_at
  before update on public.items
  for each row execute function public.set_updated_at();

-- Trigger-only functions: nobody should call them through the API
-- (Supabase advisor: SECURITY DEFINER function executable by anon/authenticated)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.enforce_nu_email() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 11. Row Level Security: on for every table, no policies yet
-- ---------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.meetup_spots     enable row level security;
alter table public.items            enable row level security;
alter table public.buyable_items    enable row level security;
alter table public.borrowable_items enable row level security;
alter table public.item_images      enable row level security;
alter table public.saved_items      enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.transactions     enable row level security;
alter table public.rentals          enable row level security;
alter table public.reviews          enable row level security;
alter table public.reports          enable row level security;


-- ---------------------------------------------------------------------
-- 12. Text-to-SQL layer: read-only views in their own schema
-- Keep the nlq schema OUT of Supabase's exposed API schemas
-- (Project Settings > API). The model only ever sees these views:
-- flat, no emails or user names, and only rows that are safe to show.
-- The gateway should also wrap every generated query in a LIMIT.
-- ---------------------------------------------------------------------
create schema if not exists nlq;

-- What students can search: available items from active accounts.
create view nlq.listings as
select
  i.item_id,
  i.title,
  i.description,
  i.category,
  i.condition,
  b.price          as sale_price,
  r.price_per_week as rent_price_per_week,
  r.deposit        as rent_deposit,
  s.name           as meetup_spot,
  i.created_at     as listed_at
from public.items i
join public.profiles p             on p.id = i.owner_id
join public.meetup_spots s         on s.spot_id = i.meetup_spot_id
left join public.buyable_items b   on b.item_id = i.item_id
left join public.borrowable_items r on r.item_id = i.item_id
where i.status = 'available'
  and p.account_status = 'active';

comment on view nlq.listings is
  'Items students can currently get. One row per item. Prices are in USD.';
comment on column nlq.listings.sale_price is
  'Purchase price; null if the item is not for sale.';
comment on column nlq.listings.rent_price_per_week is
  'Weekly rental price; null if the item is not for rent.';
comment on column nlq.listings.meetup_spot is
  'Boston-area handoff location, for example Snell Library.';

-- Admin analytics views.
create view nlq.admin_items as
select
  i.item_id,
  i.category,
  i.condition,
  i.status,
  s.name           as meetup_spot,
  b.price          as sale_price,
  r.price_per_week as rent_price_per_week,
  i.created_at     as listed_at
from public.items i
join public.meetup_spots s          on s.spot_id = i.meetup_spot_id
left join public.buyable_items b    on b.item_id = i.item_id
left join public.borrowable_items r on r.item_id = i.item_id;

create view nlq.admin_transactions as
select
  t.transaction_id,
  t.item_id,
  i.category,
  t.type,
  t.status,
  t.agreed_price,
  t.created_at,
  t.completed_at,
  rn.start_date,
  rn.due_date,
  rn.returned_at,
  rn.return_condition,
  coalesce(rn.returned_at::date > rn.due_date, false) as returned_late,
  coalesce(t.status = 'handed_over'
           and rn.returned_at is null
           and rn.due_date < current_date, false)    as is_overdue
from public.transactions t
join public.items i        on i.item_id = t.item_id
left join public.rentals rn on rn.transaction_id = t.transaction_id;

create view nlq.admin_reviews as
select
  rv.review_id,
  rv.transaction_id,
  t.type,
  i.category,
  rv.rating,
  rv.created_at
from public.reviews rv
join public.transactions t on t.transaction_id = rv.transaction_id
join public.items i        on i.item_id = t.item_id;

create view nlq.admin_reports as
select
  rp.report_id,
  rp.status,
  case
    when rp.transaction_id is not null then 'transaction'
    when rp.item_id is not null        then 'item'
    else 'user'
  end              as target_type,
  rp.item_id,
  rp.transaction_id,
  i.category       as item_category,
  rp.created_at,
  rp.resolved_at
from public.reports rp
left join public.items i on i.item_id = rp.item_id;

-- Read-only roles the text-to-SQL gateway connects as.
-- Give them a password OUTSIDE version control, for example in the SQL editor:
--   alter role nlq_student login password '...';
--   alter role nlq_admin   login password '...';
create role nlq_student nologin;
create role nlq_admin   nologin;
-- lets the admin connection test queries as these roles (scripts/sql.mjs --as=...)
grant nlq_student, nlq_admin to postgres;

grant usage on schema nlq to nlq_student, nlq_admin;
grant select on nlq.listings to nlq_student, nlq_admin;
grant select on nlq.admin_items, nlq.admin_transactions,
                nlq.admin_reviews, nlq.admin_reports to nlq_admin;

alter role nlq_student set default_transaction_read_only = on;
alter role nlq_student set statement_timeout = '3s';
alter role nlq_admin   set default_transaction_read_only = on;
alter role nlq_admin   set statement_timeout = '5s';


-- ---------------------------------------------------------------------
-- 13. Seed: Boston meetup spots (edit freely)
-- ---------------------------------------------------------------------
insert into public.meetup_spots (name) values
  ('Snell Library'),
  ('Curry Student Center'),
  ('Marino Recreation Center'),
  ('International Village'),
  ('West Village'),
  ('Mission Hill (off campus)'),
  ('Fenway (off campus)');


-- ---------------------------------------------------------------------
-- Next step (not in this file):
--   * RLS policies for each table
--   * Database functions for rules that span tables:
--       - create listing (item + buyable/borrowable rows together)
--       - request / accept / hand over / return / complete a transaction
--         (buyer can't be the owner; keeps item.status in sync)
--       - leave a review (only the two parties, only when completed)
--       - message sender must be the buyer or the item's owner
-- =====================================================================
