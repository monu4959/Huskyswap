// Verified question -> SQL examples: the starting contents of the query memory
// ("queries similar to previous ones"). Each was checked against the data by
// an independent query; `npm run rag:index` runs every one and refuses to
// build the index if any fails.
//
// Never put eval-set questions (or close paraphrases) here: the retriever would
// hand the answer to the model and inflate the scores.

import type { DbRole } from "./types.ts";

export const EXAMPLES: { role: DbRole; question: string; sql: string }[] = [
  {
    role: "nlq_admin",
    question: "how many rentals came back late during spring move-out 2025, and what share of all rentals due then is that?",
    sql: `select count(*) filter (where d.returned_late) as late_returns, count(*) as rentals_due,
       round(100.0 * count(*) filter (where d.returned_late) / nullif(count(*), 0), 1) as pct_late
from nlq.deals d
join nlq.calendar c on c.day = d.rental_due_date
where d.deal_type = 'rental' and c.period = 'move-out' and c.academic_year = '2024-25'`,
  },
  {
    role: "nlq_admin",
    question: "how many listings were posted during fall 2025 move-in?",
    sql: `select count(*) as listings
from nlq.listings_all l
join nlq.calendar c on c.day = l.listed_on
where c.period = 'move-in' and c.academic_year = '2025-26'`,
  },
  {
    role: "nlq_admin",
    question: "which category had the most completed sales in the 2024-25 academic year?",
    sql: `select l.category, count(*) as completed_sales
from nlq.deals d
join nlq.listings_all l on l.item_id = d.item_id
join nlq.calendar c on c.day = d.completed_on
where d.deal_type = 'sale' and d.status = 'completed' and c.academic_year = '2024-25'
group by l.category
order by completed_sales desc
limit 1`,
  },
  {
    role: "nlq_admin",
    question: "average seller reply time in hours for conversations started in september 2025",
    sql: `select round(avg(extract(epoch from first_seller_reply_at - started_at) / 3600)::numeric, 2) as avg_reply_hours
from nlq.conversations
where first_seller_reply_at is not null and started_on >= '2025-09-01' and started_on < '2025-10-01'`,
  },
  {
    role: "nlq_admin",
    question: "top 5 meetup spots by number of completed deals",
    sql: `select s.name as meetup_spot, count(*) as completed_deals
from nlq.deals d
join nlq.listings_all l on l.item_id = d.item_id
join nlq.meetup_spots s on s.spot_id = l.spot_id
where d.status = 'completed'
group by s.name
order by completed_deals desc
limit 5`,
  },
  {
    role: "nlq_admin",
    question: "how many listings were posted on patriots day 2025",
    sql: `select count(*) as listings
from nlq.listings_all l
join nlq.calendar c on c.day = l.listed_on
where c.holiday = 'Patriots'' Day' and c.year = 2025`,
  },
  {
    role: "nlq_admin",
    question: "how many saved listings never got any purchase or rental request",
    sql: `select count(distinct s.item_id) as saved_never_requested
from nlq.saved_items s
where not exists (select 1 from nlq.deals d where d.item_id = s.item_id)`,
  },
  {
    role: "nlq_admin",
    question: "what percent of conversations started in spring 2025 led to a request",
    sql: `select count(*) as conversations, count(*) filter (where cv.led_to_request) as led_to_request,
       round(100.0 * count(*) filter (where cv.led_to_request) / nullif(count(*), 0), 1) as pct
from nlq.conversations cv
join nlq.calendar c on c.day = cv.started_on
where c.semester = 'Spring' and c.academic_year = '2024-25'`,
  },
  {
    role: "nlq_admin",
    question: "average rating lenders gave for rentals returned damaged vs returned as lent",
    sql: `select d.return_condition, round(avg(r.rating), 2) as avg_rating, count(*) as reviews
from nlq.reviews r
join nlq.deals d on d.deal_id = r.deal_id
where r.reviewer_role = 'seller' and d.deal_type = 'rental' and d.return_condition in ('damaged', 'as_lent')
group by d.return_condition`,
  },
  {
    role: "nlq_admin",
    question: "how many reports are still open, by target type",
    sql: `select target_type, count(*) as open_reports
from nlq.reports
where status = 'open'
group by target_type
order by open_reports desc`,
  },
  {
    role: "nlq_student",
    question: "whats free right now",
    sql: `select title, category, meetup_spot, listed_at
from nlq.listings
where sale_price = 0
order by listed_at desc`,
  },
  {
    role: "nlq_student",
    question: "any mini fridges for rent at curry?",
    sql: `select title, rent_price_per_week, rent_deposit, meetup_spot
from nlq.listings
where rent_price_per_week is not null
  and meetup_spot = 'Curry Student Center'
  and (title ilike '%fridge%' or description ilike '%fridge%')
order by rent_price_per_week`,
  },
  {
    role: "nlq_student",
    question: "how much have I earned from selling stuff?",
    sql: `select coalesce(sum(agreed_price), 0) as earned, count(*) as completed_sales
from nlq.my_deals
where my_role = 'seller' and status = 'completed'`,
  },
];
