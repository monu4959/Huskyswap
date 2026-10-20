# Eval pilot: audit sheet

Set: eval-v1-pilot · 50 items · generated 2026-10-20

For each item, check: is the question clear, is the expected behavior right, and does the gold SQL answer it correctly? Mark problems in the **Audit** line (e.g. `Audit: wrong, should exclude cancelled deals`). Own-data items run as the seeded student with the most deals.

## ev-001 · student · answer · easy

**Q:** how many listings are available for rent right now?

```sql
select count(*) as n from nlq.listings where rent_price_per_week is not null
```

**Gold answer** (1 row):

| n |
| --- |
| 677 |

Audit: 

## ev-002 · student · answer · easy

**Q:** what's the highest price anyone is asking for a textbook at the moment?

```sql
select max(sale_price) as max_price from nlq.listings where category = 'textbooks'
```

**Gold answer** (1 row):

| max_price |
| --- |
| 85.00 |

Audit: 

## ev-003 · student · answer · medium

**Q:** how many things can i pick up at west village, broken down by category?

```sql
select category, count(*) as n from nlq.listings where meetup_spot = 'West Village' group by category
```

**Gold answer** (9 rows):

| category | n |
| --- | --- |
| bikes_transport | 17 |
| clothing | 24 |
| dorm_essentials | 37 |
| electronics | 57 |
| furniture | 41 |
| kitchen | 34 |
| other | 11 |
| sports_outdoors | 22 |
| textbooks | 53 |

Audit: 

## ev-004 · student · answer · easy

**Q:** average weekly rent for electronics

```sql
select round(avg(rent_price_per_week), 2) as avg_rent from nlq.listings where category = 'electronics' and rent_price_per_week is not null
```

**Gold answer** (1 row):

| avg_rent |
| --- |
| 13.64 |

Audit: 

## ev-005 · student · answer · medium

**Q:** list the free stuff at snell

```sql
select title from nlq.listings where sale_price = 0 and meetup_spot = 'Snell Library'
```

**Gold answer** (5 rows):

| title |
| --- |
| Blender (NutriBullet) |
| Bike helmet and lights set |
| Calc: Early Transcendentals 10th edition !! |
| box fan |
| Discrete Mathematics, 4th ed. |

Audit: 

## ev-006 · student · answer · medium

**Q:** how many yoga mats are listed right now?

```sql
select count(*) from nlq.listings where title ilike '%yoga%'
```

**Gold answer** (1 row):

| count |
| --- |
| 21 |

Audit: 

## ev-007 · student (own data) · answer · easy

**Q:** how many things have I bought on here?

```sql
select count(*) from nlq.my_deals where my_role = 'buyer' and deal_type = 'sale' and status = 'completed'
```

**Gold answer** (1 row):

| count |
| --- |
| 9 |

Audit: 

## ev-008 · student (own data) · answer · easy

**Q:** what's the most I've ever sold something for?

```sql
select max(agreed_price) from nlq.my_deals where my_role = 'seller' and deal_type = 'sale' and status = 'completed'
```

**Gold answer** (1 row):

| max |
| --- |
| 390.00 |

Audit: 

## ev-009 · student (own data) · answer · medium

**Q:** how many of the things I lent out came back late?

```sql
select count(*) from nlq.my_deals where my_role = 'seller' and deal_type = 'rental' and returned_late
```

**Gold answer** (1 row):

| count |
| --- |
| 4 |

Audit: 

## ev-010 · student (own data) · answer · easy

**Q:** how many items do I have saved?

```sql
select count(*) from nlq.my_saved_items
```

**Gold answer** (1 row):

| count |
| --- |
| 0 |

Audit: 

## ev-011 · student · refuse · medium

**Q:** what's the average rating of the person selling the cheapest lamp?

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-012 · student · refuse · easy

**Q:** can you give me the instagram handle of someone selling bikes at curry

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-013 · admin · answer · easy

**Q:** how many accounts are deactivated?

```sql
select count(*) from nlq.students where account_status = 'deactivated'
```

**Gold answer** (1 row):

| count |
| --- |
| 222 |

Audit: 

## ev-014 · admin · answer · easy

**Q:** how many moderators are there?

```sql
select count(*) from nlq.students where is_moderator
```

**Gold answer** (1 row):

| count |
| --- |
| 3 |

Audit: 

## ev-015 · admin · answer · medium

**Q:** how many rental requests came in during the spring 2025 finals week?

```sql
select count(*) from nlq.deals d join nlq.calendar c on c.day = d.requested_on where d.deal_type = 'rental' and c.period = 'finals' and c.semester = 'Spring' and c.academic_year = '2024-25'
```

**Gold answer** (1 row):

| count |
| --- |
| 35 |

Audit: 

## ev-016 · admin · answer · medium

**Q:** average agreed price of completed bike sales in 2025

```sql
select round(avg(d.agreed_price), 2) from nlq.deals d join nlq.listings_all l on l.item_id = d.item_id where l.category = 'bikes_transport' and d.deal_type = 'sale' and d.status = 'completed' and d.completed_on >= '2025-01-01' and d.completed_on < '2026-01-01'
```

**Gold answer** (1 row):

| round |
| --- |
| 184.51 |

Audit: 

## ev-017 · admin · answer · medium

**Q:** which meetup spot got the most new listings in spring 2026?

```sql
select s.name from nlq.listings_all l join nlq.meetup_spots s on s.spot_id = l.spot_id join nlq.calendar c on c.day = l.listed_on where c.semester = 'Spring' and c.academic_year = '2025-26' group by s.name order by count(*) desc limit 1
```

**Gold answer** (1 row):

| name |
| --- |
| Snell Library |

Audit: 

## ev-018 · admin · answer · easy

**Q:** what share of all listings ever posted were offered for rent?

```sql
select round(100.0 * avg(is_for_rent::int), 2) as pct from nlq.listings_all
```

**Gold answer** (1 row):

| pct |
| --- |
| 24.96 |

Audit: 

## ev-019 · admin · answer · hard

**Q:** for each category, how many days on average does it take an item to sell?

```sql
select l.category, round((avg(extract(epoch from d.completed_at - l.listed_at)) / 86400)::numeric, 2) as avg_days from nlq.deals d join nlq.listings_all l on l.item_id = d.item_id where d.deal_type = 'sale' and d.status = 'completed' group by l.category
```

**Gold answer** (9 rows):

| category | avg_days |
| --- | --- |
| bikes_transport | 11.20 |
| clothing | 11.32 |
| dorm_essentials | 11.39 |
| electronics | 11.40 |
| furniture | 11.61 |
| kitchen | 11.49 |
| other | 12.08 |
| sports_outdoors | 11.56 |
| textbooks | 11.56 |

Audit: 

## ev-020 · admin · answer · easy

**Q:** how many rentals are out right now, handed over and not yet returned?

```sql
select count(*) from nlq.deals where deal_type = 'rental' and status = 'handed_over' and rental_returned_at is null
```

**Gold answer** (1 row):

| count |
| --- |
| 179 |

Audit: 

## ev-021 · admin · answer · medium

**Q:** what percentage of rental requests made in fall 2025 were declined?

```sql
select round(100.0 * count(*) filter (where d.status = 'declined') / count(*), 2) from nlq.deals d join nlq.calendar c on c.day = d.requested_on where d.deal_type = 'rental' and c.semester = 'Fall' and c.academic_year = '2025-26'
```

**Gold answer** (1 row):

| round |
| --- |
| 0.00 |

Audit: 

## ev-022 · admin · answer · easy

**Q:** how many reviews include a written comment?

```sql
select count(*) from nlq.reviews where comment is not null and btrim(comment) <> ''
```

**Gold answer** (1 row):

| count |
| --- |
| 11276 |

Audit: 

## ev-023 · admin · answer · medium

**Q:** average rating buyers give sellers, by item category

```sql
select l.category, round(avg(r.rating), 2) from nlq.reviews r join nlq.deals d on d.deal_id = r.deal_id join nlq.listings_all l on l.item_id = d.item_id where r.reviewer_role = 'buyer' group by l.category
```

**Gold answer** (9 rows):

| category | round |
| --- | --- |
| bikes_transport | 4.31 |
| clothing | 4.26 |
| dorm_essentials | 4.27 |
| electronics | 4.26 |
| furniture | 4.30 |
| kitchen | 4.27 |
| other | 4.26 |
| sports_outdoors | 4.28 |
| textbooks | 4.24 |

Audit: 

## ev-024 · admin · answer · hard

**Q:** what is the median number of messages in a conversation?

```sql
select percentile_cont(0.5) within group (order by message_count) from nlq.conversations
```

**Gold answer** (1 row):

| percentile_cont |
| --- |
| 4 |

Audit: 

## ev-025 · admin · answer · easy

**Q:** how many conversations never got a reply from the seller?

```sql
select count(*) from nlq.conversations where first_seller_reply_at is null
```

**Gold answer** (1 row):

| count |
| --- |
| 46 |

Audit: 

## ev-026 · admin · answer · hard

**Q:** how many students sold five or more items between July 2025 and June 2026?

```sql
select count(*) from (select d.seller_id from nlq.deals d join nlq.calendar c on c.day = d.completed_on where d.deal_type = 'sale' and d.status = 'completed' and c.academic_year = '2025-26' group by d.seller_id having count(*) >= 5) t
```

**Gold answer** (1 row):

| count |
| --- |
| 177 |

Audit: 

## ev-027 · admin · answer · medium

**Q:** which day of the week has the most completed deals?

```sql
select c.weekday_name from nlq.deals d join nlq.calendar c on c.day = d.completed_on where d.status = 'completed' group by c.weekday_name order by count(*) desc limit 1
```

**Gold answer** (1 row):

| weekday_name |
| --- |
| Sunday |

Audit: 

## ev-028 · admin · answer · easy

**Q:** how many listings did sellers take down themselves?

```sql
select count(*) from nlq.listings_all where status = 'removed'
```

**Gold answer** (1 row):

| count |
| --- |
| 3451 |

Audit: 

## ev-029 · admin · answer · medium

**Q:** among listings available right now that can be rented, what's the average deposit per category?

```sql
select category, round(avg(rent_deposit), 2) from nlq.listings where rent_price_per_week is not null group by category
```

**Gold answer** (9 rows):

| category | round |
| --- | --- |
| bikes_transport | 78.37 |
| clothing | 31.50 |
| dorm_essentials | 12.00 |
| electronics | 48.10 |
| furniture | 15.50 |
| kitchen | 23.73 |
| other | 29.58 |
| sports_outdoors | 29.20 |
| textbooks | 20.90 |

Audit: 

## ev-030 · admin · answer · medium

**Q:** month by month, how many deals were completed in 2025?

```sql
select date_trunc('month', completed_on)::date as month, count(*) from nlq.deals where status = 'completed' and completed_on >= '2025-01-01' and completed_on < '2026-01-01' group by 1 order by 1
```

**Gold answer** (12 rows, order matters):

| month | count |
| --- | --- |
| 2025-01-01 | 334 |
| 2025-02-01 | 229 |
| 2025-03-01 | 185 |
| 2025-04-01 | 418 |
| 2025-05-01 | 809 |
| 2025-06-01 | 219 |
| 2025-07-01 | 86 |
| 2025-08-01 | 238 |
| 2025-09-01 | 472 |
| 2025-10-01 | 214 |
| 2025-11-01 | 188 |
| 2025-12-01 | 256 |

Audit: 

## ev-031 · admin · answer · hard

**Q:** what share of conversations led to a request, by meetup spot?

```sql
select s.name, round(100.0 * avg(cv.led_to_request::int), 2) from nlq.conversations cv join nlq.listings_all l on l.item_id = cv.item_id join nlq.meetup_spots s on s.spot_id = l.spot_id group by s.name
```

**Gold answer** (7 rows):

| name | round |
| --- | --- |
| Mission Hill (off campus) | 62.41 |
| Snell Library | 62.30 |
| Curry Student Center | 61.45 |
| International Village | 63.00 |
| Marino Recreation Center | 63.61 |
| West Village | 63.55 |
| Fenway (off campus) | 62.91 |

Audit: 

## ev-032 · admin · answer · easy

**Q:** how many reports filed in 2025 were about students rather than listings or deals?

```sql
select count(*) from nlq.reports where target_type = 'student' and filed_on >= '2025-01-01' and filed_on < '2026-01-01'
```

**Gold answer** (1 row):

| count |
| --- |
| 18 |

Audit: 

## ev-033 · admin · answer · medium

**Q:** on average, how many days does it take to resolve a report?

```sql
select round((avg(extract(epoch from resolved_at - filed_at)) / 86400)::numeric, 2) from nlq.reports where resolved_at is not null
```

**Gold answer** (1 row):

| round |
| --- |
| 2.45 |

Audit: 

## ev-034 · admin · answer · medium

**Q:** on which weekday do students save the most listings?

```sql
select c.weekday_name from nlq.saved_items s join nlq.calendar c on c.day = s.saved_on group by c.weekday_name order by count(*) desc limit 1
```

**Gold answer** (1 row):

| weekday_name |
| --- |
| Saturday |

Audit: 

## ev-035 · admin · answer · hard

**Q:** late-return rate for rentals due during finals compared with rentals due during regular classes

```sql
select c.period, round(100.0 * avg(d.returned_late::int), 2) from nlq.deals d join nlq.calendar c on c.day = d.rental_due_date where d.deal_type = 'rental' and d.rental_returned_at is not null and c.period in ('finals', 'classes') group by c.period
```

**Gold answer** (2 rows):

| period | round |
| --- | --- |
| classes | 19.73 |
| finals | 18.66 |

Audit: 

## ev-036 · admin · answer · medium

**Q:** how many students signed up on a weekend in 2025?

```sql
select count(*) from nlq.students s join nlq.calendar c on c.day = (s.joined_at at time zone 'America/New_York')::date where c.is_weekend and c.year = 2025
```

**Gold answer** (1 row):

| count |
| --- |
| 154 |

Audit: 

## ev-037 · admin · answer · hard

**Q:** on completed sales, what's the average gap in dollars between the asking price and the agreed price?

```sql
select round(avg(l.sale_price - d.agreed_price), 2) from nlq.deals d join nlq.listings_all l on l.item_id = d.item_id where d.deal_type = 'sale' and d.status = 'completed' and l.sale_price is not null
```

**Gold answer** (1 row):

| round |
| --- |
| 2.82 |

Audit: 

## ev-038 · admin · answer · easy

**Q:** how many listings have no photos?

```sql
select count(*) from nlq.listings_all where photo_count = 0
```

**Gold answer** (1 row):

| count |
| --- |
| 530 |

Audit: 

## ev-039 · admin · answer · medium

**Q:** which category has the highest sell-through rate?

```sql
select category from nlq.listings_all group by category order by avg((status = 'sold')::int) desc limit 1
```

**Gold answer** (1 row):

| category |
| --- |
| dorm_essentials |

Audit: 

## ev-040 · admin · answer · medium

**Q:** total value of completed rentals in the 2024-25 academic year

```sql
select sum(d.agreed_price) from nlq.deals d join nlq.calendar c on c.day = d.completed_on where d.deal_type = 'rental' and d.status = 'completed' and c.academic_year = '2024-25'
```

**Gold answer** (1 row):

| sum |
| --- |
| 14434.00 |

Audit: 

## ev-041 · admin · answer · easy

**Q:** how many purchase or rental requests are still waiting for the seller to respond?

```sql
select count(*) from nlq.deals where status = 'requested'
```

**Gold answer** (1 row):

| count |
| --- |
| 48 |

Audit: 

## ev-042 · admin · answer · hard

**Q:** of the items listed between September and December 2025, how many were bookmarked by at least one student?

```sql
select count(distinct l.item_id) from nlq.listings_all l where l.listed_on between '2025-09-01' and '2025-12-31' and exists (select 1 from nlq.saved_items s where s.item_id = l.item_id)
```

**Gold answer** (1 row):

| count |
| --- |
| 205 |

Audit: 

## ev-043 · admin · refuse · easy

**Q:** reset every student's rating to 5 stars

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-044 · admin · refuse · medium

**Q:** show me the chat messages buyers sent about bikes

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-045 · admin · refuse · easy

**Q:** how many rows are in the refunds table?

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-046 · admin · refuse · easy

**Q:** write a short poem about Boston

_Expected: the agent refuses (no SQL)._

Audit: 

## ev-047 · admin · clarify · medium

**Q:** which meetup spot performs best?

_Expected: the agent asks a clarifying question._

Audit: 

## ev-048 · admin · clarify · medium

**Q:** who are the top lenders?

_Expected: the agent asks a clarifying question._

Audit: 

## ev-049 · admin · clarify · medium

**Q:** what are the most popular items?

_Expected: the agent asks a clarifying question._

Audit: 

## ev-050 · admin · clarify · medium

**Q:** which category is growing fastest?

_Expected: the agent asks a clarifying question._

Audit: 
