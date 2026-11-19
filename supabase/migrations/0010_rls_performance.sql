-- =====================================================================
-- 0010: cheaper row-level security (load-test follow-up). Safe to re-run.
-- Apply AFTER 0009_hardening.sql, in one transaction (begin; ... commit;).
--
-- Same rows visible to every user as before; only HOW the check runs changes.
--
-- Before: the SELECT policies on messages / conversations / transactions /
-- rentals were correlated EXISTS joins. Postgres never turns a policy's
-- sub-select into a join, so it ran once per row of the table: every
-- `select * from messages` (the store reloads it after each realtime event)
-- walked all ~108k messages and looked up a conversation + item for each,
-- whatever the user's own chat count. Cost grew with the whole table.
--
-- After: the policy is `<key> = any ((select <helper>())::bigint[])`.
--   * `(select helper())` is an InitPlan: it runs ONCE per statement and
--     returns only the caller's own ids, through the buyer_id / owner_id
--     indexes.
--   * `<key> = any (<that array>)` is then an index condition on the
--     table's own key, so only the caller's rows are read.
--   (The `::bigint[]` is needed: without it `= any ((select ...))` would
--   parse as "= any (subquery)" and compare a bigint to an array.)
-- Cost now grows with the user's own chats / deals, not with the table.
--
-- The helpers are plpgsql, not sql: plpgsql caches its query plans per
-- connection. Realtime runs the policy once per subscriber per change, and a
-- sql function would be re-planned on every one of those checks.
--
-- They are SECURITY DEFINER so they read conversations / transactions
-- without re-entering those tables' RLS; each filters on auth.uid() itself,
-- exactly like the policies they replace, and only `authenticated` may run
-- them. They return ids only.
--
-- Not touched: every INSERT / DELETE policy (including 0009's WITH CHECKs
-- with public.is_active()), and the policies that are already `true` or a
-- plain `column = (select auth.uid())` test.
-- =====================================================================

-- Policies first: they depend on the helpers (an earlier draft of this file
-- returned setof bigint; a return-type change needs drop + create).
drop policy if exists "conversation parties read" on public.conversations;
drop policy if exists "conversation parties read messages" on public.messages;
drop policy if exists "deal parties read" on public.transactions;
drop policy if exists "deal parties read rentals" on public.rentals;
drop function if exists public.my_conversation_ids();
drop function if exists public.my_transaction_ids();

-- ---------------------------------------------------------------------
-- Helpers: "my" ids for the signed-in user
-- ---------------------------------------------------------------------

-- Conversations I'm a party to: I'm the buyer, or I own the item.
-- (= the old "conversation parties read" / "... read messages" conditions)
-- union all: a duplicate id can't change `= any`, and skipping the dedup is cheaper.
create function public.my_conversation_ids()
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  return array(
    select c.conversation_id
    from public.conversations c
    where c.buyer_id = uid
    union all
    select c.conversation_id
    from public.items i
    join public.conversations c on c.item_id = i.item_id
    where i.owner_id = uid
  );
end;
$$;

-- Deals I may read: I'm the buyer, or I own the item; admins read all.
-- (= the old "deal parties read" / "deal parties read rentals" conditions)
create function public.my_transaction_ids()
returns bigint[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if public.current_user_is_admin() then
    return array(select t.transaction_id from public.transactions t order by 1);
  end if;
  return array(
    select t.transaction_id
    from public.transactions t
    where t.buyer_id = uid
    union all
    select t.transaction_id
    from public.items i
    join public.transactions t on t.item_id = i.item_id
    where i.owner_id = uid
  );
end;
$$;

revoke execute on function public.my_conversation_ids() from public, anon;
revoke execute on function public.my_transaction_ids() from public, anon;
grant execute on function public.my_conversation_ids() to authenticated;
grant execute on function public.my_transaction_ids() to authenticated;

-- ---------------------------------------------------------------------
-- SELECT policies, rewritten (same names, same roles, same meaning)
-- ---------------------------------------------------------------------
create policy "conversation parties read" on public.conversations for select to authenticated
  using (conversation_id = any ((select public.my_conversation_ids())::bigint[]));

create policy "conversation parties read messages" on public.messages for select to authenticated
  using (conversation_id = any ((select public.my_conversation_ids())::bigint[]));

create policy "deal parties read" on public.transactions for select to authenticated
  using (transaction_id = any ((select public.my_transaction_ids())::bigint[]));

-- Rentals are only ever read one at a time (embedded under their deal), so
-- the admin test goes first as a plain OR: an admin then never builds the
-- every-deal array, which btree would otherwise re-sort on each lookup.
create policy "deal parties read rentals" on public.rentals for select to authenticated
  using (
    (select public.current_user_is_admin())
    or transaction_id = any ((select public.my_transaction_ids())::bigint[])
  );

-- ---------------------------------------------------------------------
-- Indexes
-- Already in schema.sql, and what the helpers and policies above use:
-- conversations(buyer_id), conversations(item_id, buyer_id), items(owner_id),
-- messages(conversation_id, sent_at), transactions(buyer_id), transactions(item_id).
-- ---------------------------------------------------------------------

-- store.tsx loadMyReviews: reviewer_id = me OR reviewee_id = me. Only
-- reviewee_id had an index, so every load scanned all reviews.
create index if not exists reviews_reviewer_id_idx on public.reviews (reviewer_id);

-- (items: its read policy is `using (true)`, so RLS costs nothing there. A
-- partial index for the "listed items" page was tried and dropped: PostgREST
-- sends the status list as a parameter, which can't match a partial index's
-- predicate, and the page's time is the three embeds + JSON, not the scan.)
drop index if exists public.items_listed_item_id_idx;
