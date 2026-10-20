// The semantic layer: business meaning the schema comments don't carry.
// Indexed into ops.rag_docs by `npm run rag:index`; the context retriever
// hands the matching entries to the SQL node.
//
// Change SEMANTIC_VERSION whenever this file changes: it is part of the cache
// key and of each run's record, like PROMPT_VERSION and SCHEMA_HASH.

export const SEMANTIC_VERSION = "s5";

// Words students use -> what they mean in the data. `views` decides which
// roles can retrieve the entry (a role must be able to read every view).
export const GLOSSARY: { terms: string[]; meaning: string; views: string[] }[] = [
  { terms: ["borrow", "rent", "rental", "lend", "loan"], meaning: "A rental: deals.deal_type = 'rental'; a listing is rentable when rent_price_per_week is not null. The borrower is deals.buyer_id, the lender is deals.seller_id. Every rental lasts 7 days.", views: ["deals"] },
  { terms: ["rent", "for rent", "rentable", "per week"], meaning: "Listings that can be rented have rent_price_per_week not null (weekly price, USD) and rent_deposit (0 if none).", views: ["listings"] },
  { terms: ["buy", "purchase", "sale", "sold", "bought"], meaning: "A purchase: deals.deal_type = 'sale'. A listing is for sale when sale_price is not null; a sold listing has status 'sold'.", views: ["deals"] },
  { terms: ["when sold", "sold this semester", "sales in", "sold in", "best sellers", "top sellers"], meaning: "When something sold is deals.completed_on of a completed sale (deal_type = 'sale', status = 'completed'); count sales and sellers from deals (seller_id). Never use listings_all.last_updated_at as a sale date.", views: ["deals"] },
  { terms: ["free", "giveaway", "for nothing"], meaning: "Free items have sale_price = 0.", views: ["listings"] },
  { terms: ["available", "listed now", "right now", "currently", "on the market"], meaning: "What is available right now is exactly the listings view (status available, seller account active).", views: ["listings"] },
  { terms: ["went through", "completed", "finished", "closed deal", "successful"], meaning: "A deal that went through has deals.status = 'completed' (completed_at / completed_on set).", views: ["deals"] },
  { terms: ["late", "returned late", "late return"], meaning: "deals.returned_late is true when a rental came back after rental_due_date. Late-return rate = avg(returned_late::int) over rentals with rental_returned_at not null.", views: ["deals"] },
  { terms: ["overdue", "not returned", "still out"], meaning: "deals.is_overdue: a rental still out and past its due date as of today.", views: ["deals"] },
  { terms: ["damaged", "broken", "as lent", "wear", "returned", "came back", "on time"], meaning: "deals.return_condition for returned rentals: as_lent, minor_wear or damaged. A returned rental is one with rental_returned_at (or return_condition) not null; most of them then end with status 'completed', so don't filter on status = 'returned' (only rentals not yet closed). On time = returned_late is false.", views: ["deals"] },
  { terms: ["reply time", "response time", "responsiveness", "slow to reply"], meaning: "Seller reply time = conversations.first_seller_reply_at - started_at (null if the seller never replied). In hours: extract(epoch from first_seller_reply_at - started_at) / 3600.", views: ["conversations"] },
  { terms: ["conversion", "chat to request", "led to a request", "serious buyers"], meaning: "Chat-to-request conversion = share of conversations with led_to_request = true: avg(led_to_request::int).", views: ["conversations"] },
  { terms: ["revenue", "gmv", "sales volume", "money", "total value", "earned", "spent"], meaning: "Money that changed hands = sum(agreed_price) over deals with status 'completed'. Listing prices are asking prices, not what was paid.", views: ["deals"] },
  { terms: ["sell-through", "sell through", "sold rate"], meaning: "Sell-through = share of listings_all that ended with status 'sold'.", views: ["listings_all"] },
  { terms: ["decline", "rejected", "turned down"], meaning: "A request the seller turned down: deals.status = 'declined'. Cancelled (by the buyer) is status 'cancelled'.", views: ["deals"] },
  { terms: ["signup", "joined", "new students", "new users", "registered"], meaning: "When a student joined: students.joined_at (timestamp); use (joined_at at time zone 'America/New_York')::date to join calendar.day.", views: ["students", "calendar"] },
  { terms: ["active", "deactivated", "suspended", "graduated", "left"], meaning: "students.account_status: active, suspended (by moderators) or deactivated (by the student, often after graduating).", views: ["students"] },
  { terms: ["moderator", "admin", "mod"], meaning: "students.is_moderator is true for the student moderators who resolve reports.", views: ["students"] },
  { terms: ["rating", "stars", "reviewed", "score"], meaning: "reviews.rating is 1-5 stars. reviewer_role = 'seller' means the seller (lender, for rentals) rated the buyer (borrower); 'buyer' means the buyer rated the seller.", views: ["reviews"] },
  { terms: ["saved", "favorited", "hearted", "bookmarked", "wishlist", "liked"], meaning: "Saved listings (the heart button) are in saved_items.", views: ["saved_items"] },
  { terms: ["report", "flag", "complaint", "moderation"], meaning: "Moderation reports are in reports: target_type deal, listing or student; status open, in_review or resolved.", views: ["reports"] },
  { terms: ["spot", "meetup", "pickup", "where", "location", "place"], meaning: "Where an item is handed over. listings has the spot name in meetup_spot; listings_all has spot_id, joined to meetup_spots.spot_id for the name.", views: ["listings", "meetup_spots"] },
  { terms: ["on campus", "off campus"], meaning: "meetup_spots.area is 'on campus' or 'off campus'.", views: ["meetup_spots"] },
  { terms: ["semester", "term", "move-in", "move-out", "finals", "break", "summer", "holiday", "weekend", "weekday"], meaning: "Join a Boston-local date column to calendar.day and filter on calendar.semester, period, academic_year (July-June, e.g. '2024-25'), holiday, weekday_name or is_weekend.", views: ["calendar"] },
  { terms: ["textbook", "orgo", "calc", "bio", "chem", "physics", "edition"], meaning: "Course books are category 'textbooks'. Students abbreviate titles: orgo = organic chemistry, calc = calculus, bio = biology, chem = chemistry. Search title and description with ILIKE.", views: ["listings"] },
  { terms: ["graphing calculator", "ti-84", "calculator"], meaning: "Graphing calculators are category 'electronics' with titles like \"TI-84 Plus CE graphing calculator\": search title ILIKE '%graphing%' or '%ti-8%'. Don't use '%calc%' alone: \"calc\" usually means a calculus textbook.", views: ["listings"] },
  { terms: ["time to sell", "days to sell", "how long to sell", "listing to sale"], meaning: "Time from listing to sale = deals.completed_at - listings_all.listed_at for completed sales (deal_type 'sale', status 'completed'); in days: extract(epoch from completed_at - listed_at) / 86400.", views: ["deals", "listings_all"] },
  { terms: ["my listings", "my items", "what i'm selling", "i listed", "i posted"], meaning: "The asking student's own listings are in my_listings.", views: ["my_listings"] },
  { terms: ["my deals", "i bought", "i sold", "i rented", "i earned", "i spent", "my purchases", "my sales"], meaning: "The asking student's own deals are in my_deals; my_role says whether they were the buyer or the seller. Bought / purchases = my_role 'buyer' and deal_type 'sale'; rented or borrowed = my_role 'buyer' and deal_type 'rental'; sold = my_role 'seller' and deal_type 'sale'; lent = my_role 'seller' and deal_type 'rental'. Count completed deals (status 'completed') unless asked otherwise. Earned = sum(agreed_price) where my_role = 'seller' and status = 'completed'.", views: ["my_deals"] },
  { terms: ["my saved", "my favorites", "my wishlist"], meaning: "The asking student's saved listings are in my_saved_items.", views: ["my_saved_items"] },
  { terms: ["my rating", "my reviews", "how am i rated"], meaning: "Ratings the asking student received or gave are in my_reviews (direction received / given).", views: ["my_reviews"] },
];

// Exact words -> a stored value (matched as whole words, case-insensitive)
export const VALUE_ALIASES: { aliases: string[]; view: string; column: string; value: string }[] = [
  { aliases: ["curry", "curry center", "csc"], view: "meetup_spots", column: "name", value: "Curry Student Center" },
  { aliases: ["snell", "the library", "library"], view: "meetup_spots", column: "name", value: "Snell Library" },
  { aliases: ["iv", "international village"], view: "meetup_spots", column: "name", value: "International Village" },
  { aliases: ["marino", "the gym", "gym"], view: "meetup_spots", column: "name", value: "Marino Recreation Center" },
  { aliases: ["west village", "wv", "west vill"], view: "meetup_spots", column: "name", value: "West Village" },
  { aliases: ["fenway"], view: "meetup_spots", column: "name", value: "Fenway (off campus)" },
  { aliases: ["mission hill"], view: "meetup_spots", column: "name", value: "Mission Hill (off campus)" },
  { aliases: ["bike", "bikes", "scooter", "scooters", "transport"], view: "categories", column: "category", value: "bikes_transport" },
  { aliases: ["book", "books", "textbook", "textbooks"], view: "categories", column: "category", value: "textbooks" },
  { aliases: ["dorm stuff", "dorm essentials", "dorm"], view: "categories", column: "category", value: "dorm_essentials" },
  { aliases: ["sports", "outdoors", "gear"], view: "categories", column: "category", value: "sports_outdoors" },
  { aliases: ["clothes", "clothing", "jacket", "jackets"], view: "categories", column: "category", value: "clothing" },
  { aliases: ["tech", "electronics", "gadgets"], view: "categories", column: "category", value: "electronics" },
  { aliases: ["furniture", "desk", "chair", "couch"], view: "categories", column: "category", value: "furniture" },
  { aliases: ["kitchen", "cooking"], view: "categories", column: "category", value: "kitchen" },
];

// Columns whose stored values are indexed for value linking
// (my_* views are per student, so their values are listed here instead of read)
export const VALUE_COLUMNS: { view: string; column: string; titles?: boolean; values?: string[] }[] = [
  { view: "categories", column: "category" },
  { view: "categories", column: "label" },
  { view: "categories", column: "category_group" },
  { view: "meetup_spots", column: "name" },
  { view: "meetup_spots", column: "area" },
  { view: "listings_all", column: "status" },
  { view: "listings_all", column: "condition" },
  { view: "deals", column: "deal_type" },
  { view: "deals", column: "status" },
  { view: "deals", column: "return_condition" },
  { view: "reviews", column: "reviewer_role" },
  { view: "reports", column: "status" },
  { view: "reports", column: "target_type" },
  { view: "students", column: "account_status" },
  { view: "calendar", column: "semester" },
  { view: "calendar", column: "period" },
  { view: "calendar", column: "holiday" },
  { view: "my_deals", column: "my_role", values: ["buyer", "seller"] },
  { view: "my_reviews", column: "direction", values: ["received", "given"] },
  // Item titles (lowercased, distinct): what kinds of things are listed
  { view: "listings", column: "title", titles: true },
  { view: "listings_all", column: "title", titles: true },
];

// How the views connect
export const JOIN_PATHS: { from: string; to: string; on: string }[] = [
  { from: "deals", to: "listings_all", on: "deals.item_id = listings_all.item_id" },
  { from: "listings_all", to: "meetup_spots", on: "listings_all.spot_id = meetup_spots.spot_id" },
  { from: "listings_all", to: "categories", on: "listings_all.category = categories.category" },
  { from: "listings", to: "categories", on: "listings.category = categories.category" },
  { from: "reviews", to: "deals", on: "reviews.deal_id = deals.deal_id" },
  { from: "conversations", to: "listings_all", on: "conversations.item_id = listings_all.item_id" },
  { from: "saved_items", to: "listings_all", on: "saved_items.item_id = listings_all.item_id" },
  { from: "reports", to: "listings_all", on: "reports.item_id = listings_all.item_id" },
  { from: "students", to: "listings_all", on: "students.student_id = listings_all.seller_id" },
  { from: "students", to: "deals", on: "students.student_id = deals.buyer_id (or deals.seller_id)" },
  { from: "my_deals", to: "listings_all", on: "my_deals.item_id = listings_all.item_id" },
];
