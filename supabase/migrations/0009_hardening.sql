-- =====================================================================
-- 0009: hardening (security review follow-up). Safe to re-run.
--
--   * M4  suspended / deactivated accounts can't write directly (messages,
--         reports, saved items): public.is_active() in the insert policies.
--   * L5  clients can't set server-owned columns (sent_at, read_at,
--         created_at, saved_at, report status...): column-level INSERT grants.
--   * M3  open_conversation: an owner can open a chat only with someone who
--         requested the item (or who already has a chat about it).
--   * L7  no TRUNCATE / REFERENCES / TRIGGER (/ MAINTAIN) for the API roles,
--         and new tables in public are not granted to anon/authenticated by
--         default. public.profile_ratings gets explicit grants (created here
--         if it doesn't exist yet).
--   * H3  ops.signin_attempts: per-IP rate limits for /api/demo-login.
--   * H4  ops.ask_quota: /api/ask reserves a slot BEFORE a run starts, so
--         parallel requests can't all pass the per-user limits.
-- =====================================================================

-- ---------------------------------------------------------------------
-- M4: active accounts only
-- ---------------------------------------------------------------------
create or replace function public.is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and account_status = 'active');
$$;
revoke execute on function public.is_active() from public, anon;
grant execute on function public.is_active() to authenticated;

drop policy if exists "save items" on public.saved_items;
create policy "save items" on public.saved_items for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_active()));

drop policy if exists "conversation parties send messages" on public.messages;
create policy "conversation parties send messages" on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and read_at is null
    and (select public.is_active())
    and exists (
      select 1 from public.conversations c join public.items i on i.item_id = c.item_id
      where c.conversation_id = messages.conversation_id
        and (c.buyer_id = (select auth.uid()) or i.owner_id = (select auth.uid()))
    )
  );

drop policy if exists "file reports" on public.reports;
create policy "file reports" on public.reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid()) and status = 'open' and resolved_by is null and admin_notes is null
    and (select public.is_active())
  );

-- ---------------------------------------------------------------------
-- L5: direct inserts name only the columns a student may choose
-- (src/lib/store.tsx: toggleSaved, sendMessage, submitReport)
-- ---------------------------------------------------------------------
revoke insert on public.saved_items, public.messages, public.reports from authenticated;
grant insert (user_id, item_id) on public.saved_items to authenticated;
grant insert (conversation_id, sender_id, body) on public.messages to authenticated;
grant insert (reporter_id, item_id, transaction_id, reported_user_id, reason) on public.reports to authenticated;

-- ---------------------------------------------------------------------
-- M3: owners open chats only with people who asked about the item
-- ---------------------------------------------------------------------
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
  -- The owner starting a chat: only with a student who requested this item
  -- (or who already opened a chat about it)
  if buyer <> uid
     and not exists (select 1 from public.transactions t where t.item_id = p_item_id and t.buyer_id = buyer)
     and not exists (select 1 from public.conversations c where c.item_id = p_item_id and c.buyer_id = buyer) then
    raise exception 'You can only message someone who requested this item.';
  end if;
  insert into public.conversations (item_id, buyer_id) values (p_item_id, buyer)
  on conflict (item_id, buyer_id) do nothing;
  select conversation_id into cid from public.conversations where item_id = p_item_id and buyer_id = buyer;
  return cid;
end;
$$;
revoke execute on function public.open_conversation(bigint, uuid) from public, anon;
grant execute on function public.open_conversation(bigint, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- profile_ratings: everyone's average star rating (src/lib/store.tsx loadRatings).
-- Not in any earlier migration; create it only if it's missing so an existing
-- definition is left alone. security_invoker: reads reviews with the caller's RLS.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profile_ratings') is null then
    create view public.profile_ratings with (security_invoker = true) as
    select reviewee_id as profile_id,
           count(*)::int as review_count,
           round(avg(rating)::numeric, 2) as average_rating
    from public.reviews
    group by reviewee_id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- L7: least privilege for the API roles on public tables and views
-- ---------------------------------------------------------------------
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
do $$
begin
  -- MAINTAIN (VACUUM/ANALYZE/REINDEX/...) exists from Postgres 17
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
  end if;
end $$;
revoke all on public.profile_ratings from public, anon, authenticated;
grant select on public.profile_ratings to authenticated;
-- New tables/views in public start with no access for the API roles; grant explicitly.
-- (Applies to objects created by the role running this migration, i.e. postgres.)
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------
-- H3: demo-login attempts, for per-IP rate limits (src/lib/demo-login.ts)
-- ---------------------------------------------------------------------
create table if not exists ops.signin_attempts (
  ip           text        not null,
  at           timestamptz not null default now(),
  new_account  boolean     not null default false
);
create index if not exists signin_attempts_ip_at_idx on ops.signin_attempts (ip, at);
create index if not exists signin_attempts_at_idx on ops.signin_attempts (at);
revoke all on ops.signin_attempts from public;

-- ---------------------------------------------------------------------
-- H4: /api/ask reservations (src/lib/agent/log.ts reserveAsk / finishAsk).
-- A row is written when a question starts and finished when it ends, so the
-- per-minute / per-day limits and the one-at-a-time rule see runs in flight,
-- and a run whose function was killed still counts.
-- ---------------------------------------------------------------------
create table if not exists ops.ask_quota (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  run_id       uuid
);
create index if not exists ask_quota_user_idx on ops.ask_quota (user_id, started_at);
revoke all on ops.ask_quota from public;

-- Carry the last day's app questions over, so the limits don't reset on deploy
insert into ops.ask_quota (user_id, started_at, finished_at, run_id)
select r.user_id, r.created_at, r.created_at, r.run_id
from ops.agent_runs r
where r.source = 'app' and r.user_id is not null and r.created_at > now() - interval '1 day'
  and not exists (select 1 from ops.ask_quota q where q.run_id = r.run_id);
