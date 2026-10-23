-- =====================================================================
-- 0006: deals.returned_late and deals.is_overdue in Boston time.
--
-- 0003 compared returned_at::date (the UTC day) with the due date, so a
-- rental returned at 9 pm in Boston on its due day counted as late, and
-- is_overdue used the UTC current_date. Both now use the Boston-local date,
-- like every *_on column. Same columns and types, so my_deals (built on
-- deals) needs no change.
-- =====================================================================

create or replace view nlq.deals as
select
  t.transaction_id               as deal_id,
  t.item_id,
  t.buyer_id,
  i.owner_id                     as seller_id,
  t.type::text                   as deal_type,
  t.status::text                 as status,
  t.agreed_price,
  t.created_at                   as requested_at,
  t.completed_at,
  rn.start_date                  as rental_start_date,
  rn.due_date                    as rental_due_date,
  rn.returned_at                 as rental_returned_at,
  rn.return_condition::text      as return_condition,
  rn.deposit_agreed              as rental_deposit,
  coalesce((rn.returned_at at time zone 'America/New_York')::date > rn.due_date, false) as returned_late,
  coalesce(t.status = 'handed_over' and rn.returned_at is null
           and rn.due_date < (now() at time zone 'America/New_York')::date, false) as is_overdue,
  (t.created_at at time zone 'America/New_York')::date as requested_on,
  (t.completed_at at time zone 'America/New_York')::date as completed_on
from public.transactions t
join public.items i          on i.item_id = t.item_id
left join public.rentals rn  on rn.transaction_id = t.transaction_id;
