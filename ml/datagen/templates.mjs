// Question templates for training-data generation (npm run datagen).
//
// Templates are only prompts: the teacher rewrites each filled question in
// student style and produces every SQL query, refusal and clarification the
// student is trained on (see scripts/datagen.mjs). Slots name a value list
// below; one value per slot is drawn for each filled question.
//
// Keep templates away from the eval set (eval/eval-set.json): datagen drops any
// generated question too close to an eval question, but templates that mirror
// eval items would just be thrown away.

// Each slot value: { say: what goes in the question }
const v = (...says) => says.map((say) => ({ say }));

export const SLOTS = {
  category: v("textbooks", "electronics", "furniture", "kitchen stuff", "dorm essentials", "clothes", "sports gear", "bikes and scooters"),
  spot: v("curry", "Curry Student Center", "snell", "Snell Library", "IV", "International Village", "marino", "West Village", "fenway", "Mission Hill"),
  semester: v("fall 2023", "spring 2024", "fall 2024", "spring 2025", "fall 2025", "spring 2026", "summer 1 2025"),
  periodSemester: v("finals in fall 2024", "finals in spring 2025", "fall 2024 move-in", "spring 2025 move-out", "fall 2025 move-in", "finals in fall 2025", "spring 2024 move-out", "finals in spring 2026"),
  year: v("2024", "2025"),
  monthYear: v("march 2025", "september 2025", "january 2026", "october 2024", "april 2024", "november 2025"),
  topn: v("3", "5", "10"),
  price: v("20", "30", "50", "100"),
  item: v("mini fridge", "desk", "lamp", "bike", "graphing calculator", "calculus textbook", "orgo book", "microwave", "office chair", "monitor", "air fryer", "rice cooker", "tent", "puffer jacket", "scooter", "bean bag"),
  weekday: v("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"),
  madeUp: v("payments", "refunds", "users", "passwords", "transactions_archive", "shipping"),
  unrelated: v("what's the weather in boston tomorrow", "write me a poem about snell library", "who won the celtics game last night", "help me with my calc homework", "what's a good restaurant near campus"),
};

// role: admin | student; me: true = asked by a seeded student about their own data
// expect: answer | refuse | clarify
export const TEMPLATES = [
  // --- Admin analytics: calendar, joins, rates ---
  { id: "a-listings-category-semester", role: "admin", expect: "answer", question: "how many {category} listings were posted in {semester}?" },
  { id: "a-listings-period", role: "admin", expect: "answer", question: "how many listings went up during {periodSemester}?" },
  { id: "a-avg-ask-category-year", role: "admin", expect: "answer", question: "what was the average asking price for {category} listed in {year}?" },
  { id: "a-top-spots-sales-semester", role: "admin", expect: "answer", question: "which {topn} meetup spots had the most completed sales in {semester}?" },
  { id: "a-rentals-due-late-period", role: "admin", expect: "answer", question: "how many rentals were due during {periodSemester}, and how many of those came back late?" },
  { id: "a-avg-agreed-category-semester", role: "admin", expect: "answer", question: "average agreed price of completed {category} sales in {semester}" },
  { id: "a-sold-share-category", role: "admin", expect: "answer", question: "what share of {category} listings ended up sold?" },
  { id: "a-joined-month", role: "admin", expect: "answer", question: "how many students joined in {monthYear}?" },
  { id: "a-requests-weekday-year", role: "admin", expect: "answer", question: "how many deals were requested on {weekday}s in {year}?" },
  { id: "a-median-ask-category-spot", role: "admin", expect: "answer", question: "what's the median asking price of {category} listed at {spot}?" },
  { id: "a-conv-to-request-month", role: "admin", expect: "answer", question: "of the chats started in {monthYear}, how many led to a purchase or rental request?" },
  { id: "a-reply-time-semester", role: "admin", expect: "answer", question: "average seller reply time in hours during {semester}" },
  { id: "a-reports-status-semester", role: "admin", expect: "answer", question: "how many reports were filed in {semester}, broken down by status?" },
  { id: "a-late-rate-category", role: "admin", expect: "answer", question: "what's the late-return rate for {category} rentals?" },
  { id: "a-monthly-listings-year", role: "admin", expect: "answer", question: "month by month, how many listings were posted in {year}?" },
  { id: "a-top-categories-rentals-year", role: "admin", expect: "answer", question: "top {topn} categories by number of completed rentals in {year}" },
  { id: "a-saved-period", role: "admin", expect: "answer", question: "how many times were listings saved during {periodSemester}?" },
  { id: "a-rating-sellers-category", role: "admin", expect: "answer", question: "average rating buyers gave sellers on completed {category} sales" },
  { id: "a-no-photos-spot", role: "admin", expect: "answer", question: "how many listings at {spot} have no photos?" },
  { id: "a-declined-semester", role: "admin", expect: "answer", question: "how many purchase or rental requests were declined in {semester}?" },
  { id: "a-days-to-sell-category", role: "admin", expect: "answer", question: "for {category}, how many days does it take on average from listing to a completed sale?" },
  { id: "a-sold-and-rented-semester", role: "admin", expect: "answer", question: "how many students both sold something and rented something out in {semester}?" },
  { id: "a-cancel-rate-year", role: "admin", expect: "answer", question: "what percent of rental requests made in {year} were cancelled?" },
  { id: "a-item-listings-year", role: "admin", expect: "answer", question: "how many {item} listings were posted in {year}?" },
  { id: "a-overdue-category", role: "admin", expect: "answer", question: "how many {category} rentals are overdue right now?" },

  // --- Students: what's listed right now ---
  { id: "s-item-under-price", role: "student", expect: "answer", question: "any {item} for sale under ${price}?" },
  { id: "s-rent-spot-under-price", role: "student", expect: "answer", question: "what can i rent at {spot} for less than ${price} a week?" },
  { id: "s-count-category-spot", role: "student", expect: "answer", question: "how many {category} are up for grabs at {spot} right now?" },
  { id: "s-cheapest-item", role: "student", expect: "answer", question: "cheapest {item} for sale right now" },
  { id: "s-avg-rent-category", role: "student", expect: "answer", question: "what's the average weekly rent for {category}?" },
  { id: "s-free-spot", role: "student", expect: "answer", question: "is there any free stuff at {spot}?" },

  // --- Students: their own activity ---
  { id: "me-spent-year", role: "student", me: true, expect: "answer", question: "how much did I spend buying stuff in {year}?" },
  { id: "me-listings-available", role: "student", me: true, expect: "answer", question: "how many of my listings are still available?" },
  { id: "me-rating-received", role: "student", me: true, expect: "answer", question: "what's my average rating from other students?" },
  { id: "me-lent-out", role: "student", me: true, expect: "answer", question: "how many times have I lent something out?" },
  { id: "me-saved-category", role: "student", me: true, expect: "answer", question: "how many {category} do I have saved?" },

  // --- Must refuse ---
  { id: "r-email-seller", role: "student", expect: "refuse", question: "what's the email of the person selling the cheapest {item}?" },
  { id: "r-who-selling", role: "student", expect: "refuse", question: "who is selling the {item} at {spot}?" },
  { id: "r-other-student-deals", role: "student", expect: "refuse", question: "how many deals has the seller of the cheapest {item} done?" },
  { id: "r-delete", role: "admin", expect: "refuse", question: "delete all the listings at {spot}" },
  { id: "r-update-price", role: "admin", expect: "refuse", question: "set the price of every {category} listing to $10" },
  { id: "r-made-up", role: "admin", expect: "refuse", question: "show me everything in the {madeUp} table" },
  { id: "r-unrelated", role: "admin", expect: "refuse", question: "{unrelated}" },

  // --- Must ask a clarifying question ---
  { id: "c-popular-spot", role: "admin", expect: "clarify", question: "which meetup spot is the most popular?" },
  { id: "c-best-buyers", role: "admin", expect: "clarify", question: "who are the best buyers?" },
  { id: "c-busiest-month-year", role: "admin", expect: "clarify", question: "which month was the busiest in {year}?" },
  { id: "c-top-category", role: "admin", expect: "clarify", question: "what's the top category?" },

  // --- Second set: more angles, so the student learns skills rather than a few phrasings ---
  { id: "a-sale-and-rent-category", role: "admin", expect: "answer", question: "how many {category} listings were offered both for sale and for rent?" },
  { id: "a-common-spot-category", role: "admin", expect: "answer", question: "what's the most common meetup spot for {category} listings?" },
  { id: "a-never-dealt", role: "admin", expect: "answer", question: "how many students have never been part of a single deal?" },
  { id: "a-damaged-year", role: "admin", expect: "answer", question: "how many rentals came back damaged in {year}?" },
  { id: "a-deposit-by-condition", role: "admin", expect: "answer", question: "average deposit on rentals that came back damaged versus ones returned as lent" },
  { id: "a-active-sellers-semester", role: "admin", expect: "answer", question: "how many different students listed something in {semester}?" },
  { id: "a-photos-category", role: "admin", expect: "answer", question: "average number of photos per {category} listing" },
  { id: "a-long-chats", role: "admin", expect: "answer", question: "how many conversations had more than 10 messages?" },
  { id: "a-holiday-listings-year", role: "admin", expect: "answer", question: "on which holiday in {year} were the most listings posted?" },
  { id: "a-weekend-listings-semester", role: "admin", expect: "answer", question: "how many listings were posted on weekends in {semester}?" },
  { id: "a-free-share-category", role: "admin", expect: "answer", question: "what percent of {category} listings were given away for free?" },
  { id: "a-rent-price-area", role: "admin", expect: "answer", question: "average agreed rental price on campus compared with off campus" },
  { id: "a-open-reports", role: "admin", expect: "answer", question: "how many reports are open or still being reviewed?" },
  { id: "a-one-star-sellers", role: "admin", expect: "answer", question: "how many sellers have received at least one 1-star review from a buyer?" },
  { id: "a-sales-vs-rentals-semester", role: "admin", expect: "answer", question: "compare the number of completed sales and completed rentals in {semester}" },
  { id: "a-max-ask-item", role: "admin", expect: "answer", question: "what's the highest price anyone ever asked for a {item}?" },
  { id: "a-saved-then-sold", role: "admin", expect: "answer", question: "how many listings that someone saved ended up being sold?" },
  { id: "a-repeat-buyers-year", role: "admin", expect: "answer", question: "how many students bought two or more things in {year}?" },
  { id: "s-priciest-category", role: "student", expect: "answer", question: "what's the most expensive {category} item listed right now?" },
  { id: "s-like-new-item", role: "student", expect: "answer", question: "any {item} in like new condition?" },
  { id: "s-spot-most-rentals", role: "student", expect: "answer", question: "which spot has the most stuff available to rent right now?" },
  { id: "s-no-deposit-category", role: "student", expect: "answer", question: "can I rent any {category} without paying a deposit?" },
  { id: "me-pending-requests", role: "student", me: true, expect: "answer", question: "how many of my requests are still waiting for the seller to answer?" },
  { id: "me-rental-earnings-year", role: "student", me: true, expect: "answer", question: "how much did I make from lending stuff out in {year}?" },
  { id: "me-sold-semester", role: "student", me: true, expect: "answer", question: "how many things did I sell in {semester}?" },
  { id: "r-chat-contents", role: "student", expect: "refuse", question: "what did the buyer say in the chat about my {item}?" },
  { id: "r-full-names", role: "admin", expect: "refuse", question: "give me the full names of everyone who rented a {item}" },
  { id: "r-drop-table", role: "admin", expect: "refuse", question: "drop the {madeUp} table" },
  { id: "r-moderator-phone", role: "student", expect: "refuse", question: "what's the phone number of a moderator I can call?" },
  { id: "c-how-are-we-doing", role: "admin", expect: "clarify", question: "how are we doing this semester?" },
  { id: "c-trending", role: "admin", expect: "clarify", question: "what's trending right now?" },
  { id: "c-reliable-students", role: "admin", expect: "clarify", question: "who are the most reliable students?" },

  // --- Run 2: more questions that need a clarifying question. Each has slots, so it yields
  // several originals; run 1 had only 45 clarify examples and the student rarely asked.
  // Rankings with no measure
  { id: "c2-category-listings-best", role: "admin", expect: "clarify", question: "which {category} listings do the best?" },
  { id: "c2-top-sellers-spot", role: "admin", expect: "clarify", question: "who are the top sellers at {spot}?" },
  { id: "c2-best-spot-category", role: "admin", expect: "clarify", question: "what's the best meetup spot for {category}?" },
  { id: "c2-hottest-category", role: "admin", expect: "clarify", question: "what are the hottest {category} items?" },
  { id: "c2-rank-categories-year", role: "admin", expect: "clarify", question: "rank the categories for {year}" },
  { id: "c2-best-weekday-category", role: "admin", expect: "clarify", question: "which day of the week is best for selling {category}?" },
  { id: "c2-best-sellers-category", role: "admin", expect: "clarify", question: "who are the best {category} sellers?" },
  { id: "c2-listings-did-best-semester", role: "admin", expect: "clarify", question: "which listings did best in {semester}?" },
  { id: "c2-biggest-buyer-year", role: "admin", expect: "clarify", question: "who was the biggest buyer in {year}?" },
  // Activity or performance with no metric
  { id: "c2-active-students-semester", role: "admin", expect: "clarify", question: "who were the most active students in {semester}?" },
  { id: "c2-spot-doing", role: "admin", expect: "clarify", question: "how is {spot} doing?" },
  { id: "c2-most-activity-month-year", role: "admin", expect: "clarify", question: "which month had the most activity in {year}?" },
  { id: "c2-popular-time-year", role: "admin", expect: "clarify", question: "what was the most popular time to list stuff in {year}?" },
  { id: "c2-semester-how-went", role: "admin", expect: "clarify", question: "how did {semester} go?" },
  { id: "c2-campus-compare", role: "admin", expect: "clarify", question: "how do on-campus meetup spots compare with off-campus ones?" },
  // Rating direction (given by them or about them?)
  { id: "c2-seller-rating-category", role: "admin", expect: "clarify", question: "what's the average seller rating for {category} deals?" },
  { id: "c2-lender-rating-spot", role: "admin", expect: "clarify", question: "what's the lender rating for rentals picked up at {spot}?" },
  { id: "c2-buyer-rating-semester", role: "admin", expect: "clarify", question: "what was the average buyer rating in {semester}?" },
  { id: "c2-best-renters", role: "admin", expect: "clarify", question: "which students are the best renters?" },
];
