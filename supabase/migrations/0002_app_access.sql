-- =====================================================================
-- 0002: app access. Row Level Security policies, the database functions
-- every write goes through, the photo bucket, and realtime.
-- Applies on top of supabase/schema.sql (v2.1).
--
-- Model: signed-in students can READ marketplace data (listings, profiles,
-- reviews) and only their own private data (chats, deals, saved items,
-- reports). They WRITE only through the functions below, which enforce the
-- same rules the demo app had (no buying your own item, one active deal per
-- item, 7-day rentals, reviews only after completion...).
-- =====================================================================

-- ---------- grants: nothing for anon, reads for authenticated ----------
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
-- the few direct writes the app makes (still filtered by RLS below)
grant insert, delete on public.saved_items to authenticated;
grant insert on public.messages to authenticated;
grant insert on public.reports to authenticated;

-- ---------- helpers ----------
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

create or replace function public.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Sign in first.';
  end if;
  if not exists (select 1 from public.profiles where id = uid and account_status = 'active') then
    raise exception 'Your account is not active.';
  end if;
  return uid;
end;
$$;

-- ---------- policies ----------
-- Marketplace data: any signed-in student can read
create policy "students read profiles" on public.profiles for select to authenticated using (true);
create policy "students read meetup spots" on public.meetup_spots for select to authenticated using (true);
create policy "students read items" on public.items for select to authenticated using (true);
create policy "students read sale terms" on public.buyable_items for select to authenticated using (true);
create policy "students read rental terms" on public.borrowable_items for select to authenticated using (true);
create policy "students read item images" on public.item_images for select to authenticated using (true);
create policy "students read reviews" on public.reviews for select to authenticated using (true);

-- Saved items: your own only
create policy "own saved items" on public.saved_items for select to authenticated
  using (user_id = (select auth.uid()));
create policy "save items" on public.saved_items for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "unsave items" on public.saved_items for delete to authenticated
  using (user_id = (select auth.uid()));

-- Conversations and messages: only the buyer and the item's owner
create policy "conversation parties read" on public.conversations for select to authenticated
  using (
    buyer_id = (select auth.uid())
    or exists (select 1 from public.items i where i.item_id = conversations.item_id and i.owner_id = (select auth.uid()))
  );
create policy "conversation parties read messages" on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c join public.items i on i.item_id = c.item_id
    where c.conversation_id = messages.conversation_id
      and (c.buyer_id = (select auth.uid()) or i.owner_id = (select auth.uid()))
  ));
create policy "conversation parties send messages" on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and read_at is null
    and exists (
      select 1 from public.conversations c join public.items i on i.item_id = c.item_id
      where c.conversation_id = messages.conversation_id
        and (c.buyer_id = (select auth.uid()) or i.owner_id = (select auth.uid()))
    )
  );

-- Deals: only the two parties (admins see all for moderation)
create policy "deal parties read" on public.transactions for select to authenticated
  using (
    buyer_id = (select auth.uid())
    or exists (select 1 from public.items i where i.item_id = transactions.item_id and i.owner_id = (select auth.uid()))
    or (select public.current_user_is_admin())
  );
create policy "deal parties read rentals" on public.rentals for select to authenticated
  using (exists (
    select 1 from public.transactions t join public.items i on i.item_id = t.item_id
    where t.transaction_id = rentals.transaction_id
      and (t.buyer_id = (select auth.uid()) or i.owner_id = (select auth.uid()) or (select public.current_user_is_admin()))
  ));

-- Reports: file your own; see your own; admins see everything
create policy "file reports" on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open' and resolved_by is null and admin_notes is null);
create policy "read own reports" on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.current_user_is_admin()));

-- ---------- functions: every other write ----------
create or replace function public.update_my_name(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  clean text := btrim(p_name);
begin
  if clean = '' or char_length(clean) > 80 then
    raise exception 'Enter a name up to 80 characters.';
  end if;
  update public.profiles set name = clean where id = uid;
end;
$$;

create or replace function public.create_listing(
  p_title text,
  p_description text,
  p_category public.item_category,
  p_condition public.item_condition,
  p_meetup_spot_id smallint,
  p_sale_price numeric default null,
  p_rent_price numeric default null,
  p_deposit numeric default 0,
  p_image_paths text[] default '{}'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  new_id bigint;
begin
  if p_sale_price is null and p_rent_price is null then
    raise exception 'Choose sell, rent, or both.';
  end if;
  insert into public.items (owner_id, meetup_spot_id, title, description, category, condition)
  values (uid, p_meetup_spot_id, btrim(p_title), coalesce(btrim(p_description), ''), p_category, p_condition)
  returning item_id into new_id;
  if p_sale_price is not null then
    insert into public.buyable_items (item_id, price) values (new_id, p_sale_price);
  end if;
  if p_rent_price is not null then
    insert into public.borrowable_items (item_id, price_per_week, deposit) values (new_id, p_rent_price, coalesce(p_deposit, 0));
  end if;
  -- photos must live in the uploader's own folder of the item-images bucket
  insert into public.item_images (item_id, storage_path, position)
  select new_id, path, (ord - 1)::smallint
  from unnest(p_image_paths) with ordinality as t(path, ord)
  where path like uid::text || '/%';
  return new_id;
end;
$$;

create or replace function public.remove_listing(p_item_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  it public.items;
begin
  select * into it from public.items where item_id = p_item_id for update;
  if not found then raise exception 'That listing no longer exists.'; end if;
  if it.owner_id <> uid then raise exception 'Only the owner can remove a listing.'; end if;
  if it.status in ('reserved', 'rented_out') then raise exception 'Finish or cancel the current deal first.'; end if;
  update public.items set status = 'removed' where item_id = p_item_id;
end;
$$;

-- One conversation per (item, buyer). Buyers open their own; owners can open one with a buyer who requested.
create or replace function public.open_conversation(p_item_id bigint, p_buyer_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  buyer uuid := coalesce(p_buyer_id, uid);
  owner uuid;
  cid bigint;
begin
  select owner_id into owner from public.items where item_id = p_item_id;
  if owner is null then raise exception 'That listing no longer exists.'; end if;
  if buyer = uid and owner = uid then raise exception 'This is your own listing.'; end if;
  if buyer <> uid and owner <> uid then raise exception 'You''re not part of this conversation.'; end if;
  insert into public.conversations (item_id, buyer_id) values (p_item_id, buyer)
  on conflict (item_id, buyer_id) do nothing;
  select conversation_id into cid from public.conversations where item_id = p_item_id and buyer_id = buyer;
  return cid;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  update public.messages m set read_at = now()
  from public.conversations c join public.items i on i.item_id = c.item_id
  where m.conversation_id = p_conversation_id
    and c.conversation_id = m.conversation_id
    and (c.buyer_id = uid or i.owner_id = uid)
    and m.sender_id <> uid
    and m.read_at is null;
end;
$$;

create or replace function public.request_deal(p_item_id bigint, p_type public.transaction_type)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  it public.items;
  price numeric;
  new_id bigint;
begin
  select * into it from public.items where item_id = p_item_id for update;
  if not found then raise exception 'That listing no longer exists.'; end if;
  if it.owner_id = uid then raise exception 'You can''t request your own listing.'; end if;
  if it.status <> 'available' then raise exception 'This item isn''t available right now.'; end if;
  if p_type = 'sale' then
    select b.price into price from public.buyable_items b where b.item_id = p_item_id;
    if price is null then raise exception 'This item isn''t for sale.'; end if;
  else
    -- rentals are always one week, so the weekly price is the agreed price
    select r.price_per_week into price from public.borrowable_items r where r.item_id = p_item_id;
    if price is null then raise exception 'This item isn''t for rent.'; end if;
  end if;
  if exists (select 1 from public.transactions where item_id = p_item_id and buyer_id = uid
             and status in ('requested', 'accepted', 'handed_over')) then
    raise exception 'You already have an open request for this item.';
  end if;
  insert into public.transactions (item_id, buyer_id, type, agreed_price)
  values (p_item_id, uid, p_type, price)
  returning transaction_id into new_id;
  return new_id;
end;
$$;

-- Loads a deal plus its item, locked, and checks who may act on it
create or replace function public.deal_for_update(p_tx bigint, out tx public.transactions, out it public.items)
language plpgsql
security definer
set search_path = ''
as $$
begin
  select * into tx from public.transactions where transaction_id = p_tx for update;
  if not found then raise exception 'That deal no longer exists.'; end if;
  select * into it from public.items where item_id = tx.item_id for update;
end;
$$;
revoke execute on function public.deal_for_update(bigint) from public, anon, authenticated;

create or replace function public.accept_deal(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if (d.it).owner_id <> uid then raise exception 'Only the owner can accept.'; end if;
  if (d.tx).status <> 'requested' then raise exception 'This request was already answered.'; end if;
  if (d.it).status <> 'available' then raise exception 'This item already has an active deal.'; end if;
  update public.transactions set status = 'accepted' where transaction_id = p_tx;
  -- accepting one request declines the others for the same item
  update public.transactions set status = 'declined'
  where item_id = (d.it).item_id and status = 'requested' and transaction_id <> p_tx;
  update public.items set status = 'reserved' where item_id = (d.it).item_id;
end;
$$;

create or replace function public.decline_deal(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if (d.it).owner_id <> uid then raise exception 'Only the owner can decline.'; end if;
  if (d.tx).status <> 'requested' then raise exception 'This request was already answered.'; end if;
  update public.transactions set status = 'declined' where transaction_id = p_tx;
end;
$$;

create or replace function public.cancel_deal(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if uid not in ((d.tx).buyer_id, (d.it).owner_id) then raise exception 'You''re not part of this deal.'; end if;
  if (d.tx).status not in ('requested', 'accepted') then raise exception 'A deal can''t be cancelled after the hand-off.'; end if;
  update public.transactions set status = 'cancelled' where transaction_id = p_tx;
  if (d.tx).status = 'accepted' then
    update public.items set status = 'available' where item_id = (d.it).item_id;
  end if;
end;
$$;

create or replace function public.hand_over(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
  dep numeric;
begin
  if (d.it).owner_id <> uid then raise exception 'The owner confirms the hand-off.'; end if;
  if (d.tx).status <> 'accepted' then raise exception 'Accept the request first.'; end if;
  update public.transactions set status = 'handed_over' where transaction_id = p_tx;
  if (d.tx).type = 'rental' then
    select deposit into dep from public.borrowable_items where item_id = (d.it).item_id;
    insert into public.rentals (transaction_id, start_date, due_date, deposit_agreed)
    values (p_tx, current_date, current_date + 7, coalesce(dep, 0));
    update public.items set status = 'rented_out' where item_id = (d.it).item_id;
  end if;
end;
$$;

-- Sale: the buyer confirms they have the item
create or replace function public.confirm_received(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if (d.tx).buyer_id <> uid then raise exception 'The buyer confirms they got the item.'; end if;
  if (d.tx).type <> 'sale' or (d.tx).status <> 'handed_over' then raise exception 'Nothing to confirm yet.'; end if;
  update public.transactions set status = 'completed', completed_at = now() where transaction_id = p_tx;
  update public.items set status = 'sold' where item_id = (d.it).item_id;
end;
$$;

-- Rental: the owner records the item coming back
create or replace function public.mark_returned(p_tx bigint, p_condition public.return_condition)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if (d.it).owner_id <> uid then raise exception 'The owner records the return.'; end if;
  if (d.tx).type <> 'rental' or (d.tx).status <> 'handed_over' then raise exception 'This rental isn''t out.'; end if;
  update public.transactions set status = 'returned' where transaction_id = p_tx;
  update public.rentals set returned_at = now(), return_condition = p_condition where transaction_id = p_tx;
  update public.items set status = 'available' where item_id = (d.it).item_id;
end;
$$;

-- Rental: the owner settles the deposit and closes the deal
create or replace function public.close_rental(p_tx bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  d record := public.deal_for_update(p_tx);
begin
  if (d.it).owner_id <> uid then raise exception 'The owner closes the rental.'; end if;
  if (d.tx).status <> 'returned' then raise exception 'Record the return first.'; end if;
  update public.transactions set status = 'completed', completed_at = now() where transaction_id = p_tx;
end;
$$;

create or replace function public.leave_review(p_tx bigint, p_rating smallint, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := public.require_active_user();
  tx public.transactions;
  owner uuid;
begin
  select * into tx from public.transactions where transaction_id = p_tx;
  if not found then raise exception 'That deal no longer exists.'; end if;
  select owner_id into owner from public.items where item_id = tx.item_id;
  if tx.status <> 'completed' then raise exception 'You can review once the deal is completed.'; end if;
  if uid not in (tx.buyer_id, owner) then raise exception 'Only the two people in the deal can review.'; end if;
  if exists (select 1 from public.reviews where transaction_id = p_tx and reviewer_id = uid) then
    raise exception 'You already reviewed this deal.';
  end if;
  insert into public.reviews (transaction_id, reviewer_id, reviewee_id, rating, comment)
  values (p_tx, uid, case when uid = owner then tx.buyer_id else owner end, p_rating, nullif(btrim(p_comment), ''));
end;
$$;

-- Functions are for signed-in students only
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.update_my_name(text),
  public.create_listing(text, text, public.item_category, public.item_condition, smallint, numeric, numeric, numeric, text[]),
  public.remove_listing(bigint),
  public.open_conversation(bigint, uuid),
  public.mark_conversation_read(bigint),
  public.request_deal(bigint, public.transaction_type),
  public.accept_deal(bigint), public.decline_deal(bigint), public.cancel_deal(bigint),
  public.hand_over(bigint), public.confirm_received(bigint),
  public.mark_returned(bigint, public.return_condition), public.close_rental(bigint),
  public.leave_review(bigint, smallint, text),
  public.current_user_is_admin(), public.require_active_user()
to authenticated;

-- ---------- photo uploads: public bucket, each student writes to their own folder ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-images', 'item-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "students upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "students delete own photos" on storage.objects for delete to authenticated
  using (bucket_id = 'item-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- realtime: live chat and deal updates (RLS still applies) ----------
alter publication supabase_realtime add table public.messages, public.transactions;
