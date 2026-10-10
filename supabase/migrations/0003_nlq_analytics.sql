-- =====================================================================
-- 0003: the text-to-SQL schema (nlq). This is everything the model sees.
--
-- Design rules:
--   * star-ish schema: fact views (listings, deals, reviews, conversations,
--     saved_items, reports) joined to dimensions (students, meetup_spots,
--     categories, calendar) through obvious *_id keys
--   * no personal data: no names, no emails, no message text; students are
--     identified only by an opaque student_id
--   * every view and column has a comment; the comments ARE the schema card
--     given to the model
--   * nlq_student sees only what any student could see in the app (current
--     listings + reference tables); nlq_admin sees the full analytics schema
-- Replaces the flat admin_* views from schema.sql v2.1.
-- =====================================================================

drop view if exists nlq.admin_items, nlq.admin_transactions, nlq.admin_reviews, nlq.admin_reports, nlq.listings;

-- ---------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------
create or replace view nlq.students as
select
  p.id                 as student_id,
  p.created_at         as joined_at,
  p.account_status,
  (p.role = 'admin')   as is_moderator
from public.profiles p;
comment on view nlq.students is 'One row per student account. No names or emails, only an opaque id.';
comment on column nlq.students.student_id is 'Opaque student id. Join to listings.seller_id, deals.buyer_id / deals.seller_id, reviews.reviewer_id / reviewee_id, conversations.buyer_id / seller_id, saved_items.student_id.';
comment on column nlq.students.joined_at is 'When the student created their account (usually the start of a semester).';
comment on column nlq.students.account_status is 'active, suspended (by moderators) or deactivated (by the student, often after graduating).';
comment on column nlq.students.is_moderator is 'True for the few student moderators who resolve reports.';

create or replace view nlq.meetup_spots as
select
  spot_id,
  name,
  case when name like '%(off campus)%' then 'off campus' else 'on campus' end as area
from public.meetup_spots;
comment on view nlq.meetup_spots is 'Boston-area places where buyers and sellers hand items over. Every listing names one.';
comment on column nlq.meetup_spots.name is 'For example Snell Library, Curry Student Center, International Village, Mission Hill (off campus).';
comment on column nlq.meetup_spots.area is 'on campus or off campus.';

create or replace view nlq.categories as
select category::text as category, label, category_group
from (values
  ('textbooks',       'Textbooks',         'academic'),
  ('electronics',     'Electronics',       'academic'),
  ('furniture',       'Furniture',         'home'),
  ('kitchen',         'Kitchen',           'home'),
  ('dorm_essentials', 'Dorm essentials',   'home'),
  ('clothing',        'Clothing',          'personal'),
  ('sports_outdoors', 'Sports & outdoors', 'leisure'),
  ('bikes_transport', 'Bikes & transport', 'leisure'),
  ('other',           'Other',             'leisure')
) as c(category, label, category_group);
comment on view nlq.categories is 'Listing categories with display labels and broader groups.';
comment on column nlq.categories.category is 'Category code used in listings.category, e.g. textbooks, dorm_essentials, bikes_transport.';
comment on column nlq.categories.category_group is 'academic, home, personal or leisure.';

-- Calendar: one row per day with Northeastern's academic calendar and US/Massachusetts holidays
create table if not exists nlq.calendar (
  day            date primary key,
  year           int  not null,
  month          int  not null,
  month_name     text not null,
  iso_week       int  not null,
  weekday_name   text not null,
  is_weekend     boolean not null,
  academic_year  text not null,
  semester       text not null,
  period         text not null,
  holiday        text
);
truncate nlq.calendar;
insert into nlq.calendar
select
  d::date,
  extract(year from d)::int,
  extract(month from d)::int,
  to_char(d, 'FMMonth'),
  extract(week from d)::int,
  to_char(d, 'FMDay'),
  extract(isodow from d) in (6, 7),
  -- academic year runs July 1 to June 30, e.g. 2025-26
  case when extract(month from d) >= 7
       then extract(year from d)::int || '-' || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
       else (extract(year from d)::int - 1) || '-' || lpad((extract(year from d)::int % 100)::text, 2, '0') end,
  case
    when to_char(d, 'MM-DD') between '09-03' and '12-18' then 'Fall'
    when to_char(d, 'MM-DD') between '01-07' and '04-25' then 'Spring'
    when to_char(d, 'MM-DD') between '05-06' and '06-25' then 'Summer 1'
    when to_char(d, 'MM-DD') between '06-30' and '08-15' then 'Summer 2'
    else 'Break' end,
  case
    when to_char(d, 'MM-DD') between '08-25' and '09-07' then 'move-in'
    when to_char(d, 'MM-DD') between '12-10' and '12-18' then 'finals'
    when to_char(d, 'MM-DD') between '04-17' and '04-25' then 'finals'
    when to_char(d, 'MM-DD') between '04-26' and '05-10' then 'move-out'
    when to_char(d, 'MM-DD') >= '12-19' or to_char(d, 'MM-DD') <= '01-06' then 'winter break'
    when to_char(d, 'MM-DD') between '06-26' and '06-29' or to_char(d, 'MM-DD') between '08-16' and '08-24' then 'summer break'
    else 'classes' end,
  case
    when to_char(d, 'MM-DD') = '01-01' then 'New Year''s Day'
    when to_char(d, 'MM-DD') = '06-19' then 'Juneteenth'
    when to_char(d, 'MM-DD') = '07-04' then 'Independence Day'
    when to_char(d, 'MM-DD') = '11-11' then 'Veterans Day'
    when to_char(d, 'MM-DD') = '12-25' then 'Christmas Day'
    when extract(month from d) = 1  and extract(isodow from d) = 1 and extract(day from d) between 15 and 21 then 'Martin Luther King Jr. Day'
    when extract(month from d) = 2  and extract(isodow from d) = 1 and extract(day from d) between 15 and 21 then 'Presidents'' Day'
    when extract(month from d) = 4  and extract(isodow from d) = 1 and extract(day from d) between 15 and 21 then 'Patriots'' Day'
    when extract(month from d) = 5  and extract(isodow from d) = 1 and extract(day from d) >= 25 then 'Memorial Day'
    when extract(month from d) = 9  and extract(isodow from d) = 1 and extract(day from d) <= 7 then 'Labor Day'
    when extract(month from d) = 10 and extract(isodow from d) = 1 and extract(day from d) between 8 and 14 then 'Indigenous Peoples'' Day'
    when extract(month from d) = 11 and extract(isodow from d) = 4 and extract(day from d) between 22 and 28 then 'Thanksgiving'
    end
from generate_series('2019-01-01'::date, '2030-12-31'::date, interval '1 day') as g(d);

comment on table nlq.calendar is 'One row per day (2019-2030) with Northeastern''s academic calendar and holidays. Join on a date, e.g. calendar.day = listings.listed_at::date.';
comment on column nlq.calendar.academic_year is 'July-June academic year, e.g. 2025-26.';
comment on column nlq.calendar.semester is 'Fall, Spring, Summer 1, Summer 2, or Break.';
comment on column nlq.calendar.period is 'move-in, classes, finals, move-out, winter break or summer break.';
comment on column nlq.calendar.holiday is 'Holiday name (US and Massachusetts, e.g. Patriots'' Day, Thanksgiving), null on regular days.';
comment on column nlq.calendar.weekday_name is 'Monday ... Sunday.';

-- ---------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------
create or replace view nlq.listings_all as
select
  i.item_id,
  i.owner_id                     as seller_id,
  i.title,
  i.description,
  i.category::text               as category,
  i.condition::text              as condition,
  i.status::text                 as status,
  i.meetup_spot_id               as spot_id,
  b.price                        as sale_price,
  r.price_per_week               as rent_price_per_week,
  r.deposit                      as rent_deposit,
  (b.item_id is not null)        as is_for_sale,
  (r.item_id is not null)        as is_for_rent,
  (select count(*) from public.item_images im where im.item_id = i.item_id)::int as photo_count,
  i.created_at                   as listed_at,
  i.updated_at                   as last_updated_at,
  (i.created_at at time zone 'America/New_York')::date as listed_on
from public.items i
left join public.buyable_items b    on b.item_id = i.item_id
left join public.borrowable_items r on r.item_id = i.item_id;
comment on view nlq.listings_all is 'Every listing ever posted, in any status. Titles and descriptions are written by students and can be messy (typos, abbreviations, all caps). Prices in USD.';
comment on column nlq.listings_all.seller_id is 'Student who posted it. Join to students.student_id.';
comment on column nlq.listings_all.category is 'Join to categories.category.';
comment on column nlq.listings_all.condition is 'new, like_new, good or fair (chosen by the seller).';
comment on column nlq.listings_all.status is 'available, reserved (a buyer was accepted), rented_out, sold, or removed (taken down by the seller).';
comment on column nlq.listings_all.spot_id is 'Meetup spot. Join to meetup_spots.spot_id.';
comment on column nlq.listings_all.sale_price is 'Asking price to buy; null if not for sale. 0 means free.';
comment on column nlq.listings_all.rent_price_per_week is 'Price to rent for one week (every rental lasts exactly 7 days); null if not for rent.';
comment on column nlq.listings_all.rent_deposit is 'Refundable deposit for rentals; 0 if none.';
comment on column nlq.listings_all.listed_at is 'When the listing was posted (timestamp, UTC).';
comment on column nlq.listings_all.listed_on is 'Boston-local date the listing was posted. Join to calendar.day.';

-- Kept for the student role: what is up for grabs right now
create or replace view nlq.listings as
select l.item_id, l.title, l.description, l.category, l.condition, l.sale_price, l.rent_price_per_week, l.rent_deposit,
       s.name as meetup_spot, l.listed_at
from nlq.listings_all l
join public.profiles p on p.id = l.seller_id
join public.meetup_spots s on s.spot_id = l.spot_id
where l.status = 'available' and p.account_status = 'active';
comment on view nlq.listings is 'Listings a student can get right now: available, from active accounts. One row per item. Prices in USD.';
comment on column nlq.listings.sale_price is 'Purchase price; null if the item is not for sale. 0 means free.';
comment on column nlq.listings.rent_price_per_week is 'Weekly rental price; null if the item is not for rent.';
comment on column nlq.listings.meetup_spot is 'Where to pick it up, for example Snell Library.';

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
  coalesce(rn.returned_at::date > rn.due_date, false) as returned_late,
  coalesce(t.status = 'handed_over' and rn.returned_at is null and rn.due_date < current_date, false) as is_overdue,
  (t.created_at at time zone 'America/New_York')::date as requested_on,
  (t.completed_at at time zone 'America/New_York')::date as completed_on
from public.transactions t
join public.items i          on i.item_id = t.item_id
left join public.rentals rn  on rn.transaction_id = t.transaction_id;
comment on view nlq.deals is 'Every purchase or rental request and how it ended. A deal moves requested -> accepted -> handed_over -> completed (rentals pass through returned), or ends declined / cancelled.';
comment on column nlq.deals.buyer_id is 'Student who asked to buy or rent (the borrower for rentals). Join to students.student_id.';
comment on column nlq.deals.seller_id is 'Owner of the item (the lender for rentals).';
comment on column nlq.deals.deal_type is 'sale or rental.';
comment on column nlq.deals.status is 'requested, accepted, declined, handed_over, returned (rentals only), completed or cancelled.';
comment on column nlq.deals.agreed_price is 'Price agreed when requested (USD). For rentals this is the price of the one-week rental. Can be lower than the listing price after negotiation.';
comment on column nlq.deals.requested_at is 'When the buyer sent the request.';
comment on column nlq.deals.completed_at is 'When the deal was completed; null if not completed.';
comment on column nlq.deals.rental_start_date is 'Rentals only: day the item was picked up. Due back exactly 7 days later.';
comment on column nlq.deals.rental_returned_at is 'Rentals only: when the item came back; null if still out.';
comment on column nlq.deals.return_condition is 'Rentals only: as_lent, minor_wear or damaged.';
comment on column nlq.deals.returned_late is 'Rentals only: returned after the due date.';
comment on column nlq.deals.requested_on is 'Boston-local date of the request. Join to calendar.day.';
comment on column nlq.deals.completed_on is 'Boston-local date the deal completed; null if not completed.';
comment on column nlq.deals.is_overdue is 'Rentals only: still out and past the due date as of today.';

create or replace view nlq.reviews as
select
  rv.review_id,
  rv.transaction_id              as deal_id,
  rv.reviewer_id,
  rv.reviewee_id,
  case when rv.reviewer_id = t.buyer_id then 'buyer' else 'seller' end as reviewer_role,
  rv.rating,
  rv.comment,
  rv.created_at                  as reviewed_at,
  (rv.created_at at time zone 'America/New_York')::date as reviewed_on
from public.reviews rv
join public.transactions t on t.transaction_id = rv.transaction_id;
comment on view nlq.reviews is 'Ratings left after completed deals; each side can review the other once.';
comment on column nlq.reviews.deal_id is 'Join to deals.deal_id.';
comment on column nlq.reviews.reviewer_role is 'buyer (the buyer reviewed the seller) or seller (the seller reviewed the buyer).';
comment on column nlq.reviews.rating is '1 to 5 stars.';
comment on column nlq.reviews.comment is 'Optional free text written by the reviewer; often null.';

create or replace view nlq.conversations as
select
  c.conversation_id,
  c.item_id,
  c.buyer_id,
  i.owner_id                     as seller_id,
  c.created_at                   as started_at,
  count(m.message_id)::int       as message_count,
  count(m.message_id) filter (where m.sender_id = c.buyer_id)::int as buyer_message_count,
  count(m.message_id) filter (where m.sender_id = i.owner_id)::int as seller_message_count,
  min(m.sent_at) filter (where m.sender_id = i.owner_id) as first_seller_reply_at,
  max(m.sent_at)                 as last_message_at,
  exists (select 1 from public.transactions t where t.item_id = c.item_id and t.buyer_id = c.buyer_id) as led_to_request,
  (c.created_at at time zone 'America/New_York')::date as started_on
from public.conversations c
join public.items i on i.item_id = c.item_id
left join public.messages m on m.conversation_id = c.conversation_id
group by c.conversation_id, c.item_id, c.buyer_id, i.owner_id, c.created_at;
comment on view nlq.conversations is 'Chats between an interested buyer and a seller about one listing. Message counts and timing only; message text is private and not included.';
comment on column nlq.conversations.first_seller_reply_at is 'When the seller first replied; null if they never did. Reply time = first_seller_reply_at - started_at.';
comment on column nlq.conversations.led_to_request is 'True if this buyer also sent a purchase or rental request for the item.';

create or replace view nlq.saved_items as
select user_id as student_id, item_id, saved_at, (saved_at at time zone 'America/New_York')::date as saved_on from public.saved_items;
comment on view nlq.saved_items is 'Listings students bookmarked (the heart button).';

create or replace view nlq.reports as
select
  rp.report_id,
  case when rp.transaction_id is not null then 'deal'
       when rp.item_id is not null then 'listing'
       else 'student' end        as target_type,
  rp.item_id,
  rp.transaction_id              as deal_id,
  rp.reported_user_id            as reported_student_id,
  rp.reporter_id,
  rp.reason,
  rp.status::text                as status,
  rp.created_at                  as filed_at,
  rp.resolved_at,
  (rp.created_at at time zone 'America/New_York')::date as filed_on
from public.reports rp;
comment on view nlq.reports is 'Moderation reports filed by students about a listing, a deal or another student.';
comment on column nlq.reports.reason is 'Free text from the reporter, e.g. no-shows, duplicate listings, items not as described.';
comment on column nlq.reports.status is 'open, in_review or resolved.';

comment on column nlq.reviews.reviewed_on is 'Boston-local date of the review. Join to calendar.day.';
comment on column nlq.conversations.started_on is 'Boston-local date the chat started. Join to calendar.day.';
comment on column nlq.saved_items.saved_on is 'Boston-local date the listing was saved.';
comment on column nlq.reports.filed_on is 'Boston-local date the report was filed.';

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
revoke all on all tables in schema nlq from nlq_student, nlq_admin;
grant usage on schema nlq to nlq_student, nlq_admin;
grant select on nlq.listings, nlq.meetup_spots, nlq.categories, nlq.calendar to nlq_student;
grant select on all tables in schema nlq to nlq_admin;
