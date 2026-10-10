// Seeds the Supabase database with realistic synthetic marketplace data:
// ~3,000 fictional Northeastern students over three academic years who buy, sell
// and rent, with listings, photos, chats, deals, rentals, reviews, saved items
// and moderation reports. Everything is generated; no real people or scraped data.
//
// Realism the text-to-SQL project depends on:
//   - students join at semester starts and graduate ~4 years later (they stop
//     trading; seniors dump their rooms in late April before graduation)
//   - activity follows the academic calendar (move-in, finals, move-out, quiet summers)
//   - user-written text is messy: typos, abbreviations, ALL CAPS, emoji, empty
//     descriptions, slang in chats, reposted duplicate listings, price outliers
//
//   node scripts/seed-supabase.mjs            # refuses if data already exists
//   node scripts/seed-supabase.mjs --reset    # wipes seeded data first
//   node scripts/seed-supabase.mjs --dry-run  # generate + print stats, no DB
//
// Needs DATABASE_URL in .env.local. Seeded accounts have no password and are never
// emailed (dev sign-in can still act as them for testing).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { makeCatalog } from "./catalog.mjs";
import { messyChat, messyDescription, messyText, messyTitle } from "./messy.mjs";
import { FIRST, LAST, nuEmail } from "./people.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const STUDENTS = 3000;
const SEED = 20261007;

// ---------- deterministic random ----------
let s = SEED >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const weighted = (pairs) => {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};
const nice = (n) => (n < 10 ? Math.max(1, Math.round(n)) : n < 50 ? Math.round(n) : Math.round(n / 5) * 5);
const between = ([a, b]) => nice(a + rand() * (b - a));
const R = { rand, int, pick, chance, weighted };

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const dateOnly = (ms) => iso(ms).slice(0, 10);
// History starts at Fall 2023 move-in: three academic years up to today
const HISTORY_START = Date.UTC(2023, 7, 20);
// Daytime-ish timestamp on a given day (students are awake 9am–1am Boston time)
const atDaytime = (dayMs) => {
  const d = new Date(dayMs);
  d.setUTCHours(13 + int(0, 16), int(0, 59), int(0, 59), 0);
  return Math.min(d.getTime(), NOW - int(5, 60) * 60_000);
};

// ---------- people ----------

// Students join at a semester start (mostly fall) and graduate in May, 4 or 5 years later (co-op)
function enrollment() {
  const year = weighted([[2019, 4], [2020, 7], [2021, 10], [2022, 13], [2023, 16], [2024, 17], [2025, 17], [2026, 11]]);
  const spring = chance(0.15);
  const joined = Date.UTC(year, spring ? 0 : 8, spring ? int(5, 15) : int(1, 10)) + int(0, 20) * DAY;
  const years = chance(0.6) ? 5 : 4; // many Northeastern students do 5-year co-op programs
  const graduates = Date.UTC(year + years, 4, int(1, 12));
  return { joined: Math.min(joined, NOW - int(3, 20) * DAY), graduates };
}

// Listing activity peaks at move-out (late Apr–May), move-in (mid Aug–Sep) and December
function seasonWeight(ms) {
  const d = new Date(ms);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if ((m === 3 && day >= 20) || (m === 4 && day <= 20)) return 4;
  if ((m === 7 && day >= 10) || (m === 8 && day <= 15)) return 3.5;
  if (m === 11 && day <= 22) return 2;
  if (m === 0 && day <= 20) return 1.8;
  if (m === 5 || m === 6) return 0.5; // summer: fewer students on campus
  return 1;
}
function dateIn(start, end) {
  const span = end - start;
  for (let tries = 0; tries < 50; tries++) {
    const t = start + rand() * span;
    if (rand() * 4 < seasonWeight(t)) return atDaytime(t);
  }
  return atDaytime(start + rand() * span);
}

// ---------- listing copy ----------
const CATALOG = makeCatalog(pick);
const CATEGORY_PAIRS = Object.entries(CATALOG).map(([c, v]) => [c, v.weight]);
const CONDITION_PHRASE = {
  new: ["Brand new, never used.", "Still sealed in the box.", "New, bought two by mistake."],
  like_new: ["Like new, barely used.", "Used a handful of times, no visible wear.", "Excellent condition."],
  good: ["Good condition, some normal wear.", "Works perfectly, a few cosmetic scuffs.", "Used for a year, still in good shape."],
  fair: ["Well loved but fully functional.", "Visible wear, priced to match.", "Works fine, looks a bit used."],
};
const REASONS = [
  "Graduating in May and clearing out my room.", "Moving off campus and won't need it.", "Heading out on co-op in another city.",
  "Upgraded, so this one needs a new home.", "Studying abroad next semester.", "Roommate already has one.", "", "", "",
];
const GRAD_REASONS = ["Graduating!! Everything must go.", "Moving out after graduation, need this gone by May 10.", "Senior clearing out the apartment."];
const LOGISTICS = [
  "Can meet most weekday afternoons.", "Flexible on pickup time, just message me.", "Happy to send more photos.",
  "Price is firm.", "Open to reasonable offers.", "Cash or Venmo at pickup.", "",
];

// ---------- chat copy ----------
const OPENERS = [
  "Hi! Is the {item} still available?", "Hey, I'm interested in the {item}. Still available?",
  "Hi, is this still available? Could I pick it up this week?", "Hey! Any chance the {item} is still around?",
  "Hi there, does the {item} come with everything in the photos?", "is this still available", "Hey is the {item} still for sale?",
];
const RENT_OPENERS = [
  "Hi! Could I rent the {item} for a week?", "Hey, is the {item} free to borrow next week?",
  "Hi, I need a {item} for a week. Is it available to rent?", "can i rent this for next week",
];
const SELLER_REPLIES = [
  "Yes, still available!", "Hey! Yep, it's still here.", "Yes it is. When works for you?", "Still available. Happy to meet up.", "yep still have it",
];
const LOGISTIC_ASKS = [
  "Could we meet at {spot} around {time}?", "Does {day} at {time} work? I can come to {spot}.",
  "I'm near {spot} most afternoons. Would {day} work?", "{spot} {day} {time}?",
];
const LOGISTIC_REPLIES = [
  "That works for me. See you then!", "Perfect, see you at {spot}.", "Sounds good. I'll message when I'm there.",
  "Can we do {time2} instead? Otherwise works.", "works for me",
];
const NEGOTIATE = [
  "Would you take {offer}?", "Any flexibility on price? I could do {offer}.", "Would {offer} work if I pick up today?", "would u do {offer}",
];
const NEGOTIATE_REPLIES = ["I can do {offer}, sure.", "Best I can do is {counter}.", "Sorry, price is firm."];
const AFTER = ["Thanks again!", "Got it, thanks so much!", "Appreciate it, everything works great.", "Thanks, nice meeting you!", "thx!"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "tomorrow", "today"];
const TIMES = ["12pm", "1pm", "2:30", "3pm", "4pm", "5pm", "6pm", "7:30"];
const fill = (str, v) => str.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const shortTitle = (t) => t.replace(/,.*$/, "").replace(/\s*\(.*\)/, "").replace(/^\w/, (c) => c.toLowerCase());

const REVIEW = {
  5: ["Super easy handoff, right on time.", "Exactly as described. Would buy from again.", "Really friendly and quick to reply.",
      "Smooth transaction, highly recommend.", "Item was spotless.", "Great communication, made it easy.", "10/10", null, null, null],
  4: ["Smooth pickup, item as described.", "Good communication, a little late to meet.", "Solid deal overall.", "All good, item had minor wear.", null],
  3: ["Item was okay, more wear than the photos showed.", "Took a while to reply but it worked out.", "meh, it's fine", null],
  2: ["Showed up 30 minutes late.", "Not quite as described.", "had to wait forever at Snell"],
  1: ["Didn't show up the first time.", "Item had damage that wasn't mentioned.", "never returned my deposit"],
};
const REPORT_REASONS = {
  item: ["Listing photos don't match the item description.", "This looks like a duplicate listing.", "same item posted 3 times",
         "Price seems like a scam, seller asked for payment upfront.", "Prohibited item for campus housing.", "this is a stock photo not the real item",
         "Counterfeit AirPods.", "selling a textbook access code that was already used"],
  transaction: ["Seller didn't show up to the meetup twice.", "Item was damaged and not as described.",
                "Deposit was not returned after I returned the item on time.", "Buyer kept the item past the due date and stopped replying.",
                "they changed the price at the meetup", "Bike chain was broken, seller said it worked."],
  user: ["Rude messages in chat.", "Asked me to pay outside the app before meeting.", "Keeps spamming the same listing.", "fake account?", "harassing me after I declined"],
};
const ADMIN_NOTES = ["Contacted both parties; resolved.", "Listing removed.", "Warning sent to the user.", "No violation found.", "Refund arranged in person.",
  "Duplicate listings merged.", "Account suspended for repeated no-shows."];

// ---------- photos ----------
const photosFile = join(ROOT, "src", "data", "photos.json");
const PHOTOS = Object.fromEntries(
  Object.entries(existsSync(photosFile) ? JSON.parse(readFileSync(photosFile, "utf8")) : {}).map(([k, l]) => [k, l.filter((p) => p.reviewed)]),
);
const CATEGORY_PHOTOS = Object.fromEntries(
  Object.entries(CATALOG).map(([c, v]) => [c, [...new Set(v.items.map((t) => t.k))].flatMap((k) => PHOTOS[k] ?? [])]),
);
const photoCursor = new Map();
function photosFor(key, category) {
  const own = PHOTOS[key] ?? [];
  const set = own.length ? own : CATEGORY_PHOTOS[category] ?? [];
  if (!set.length || chance(0.04)) return []; // a few lazy sellers post no photo
  const poolKey = own.length ? key : category;
  const start = photoCursor.get(poolKey) ?? int(0, set.length - 1);
  photoCursor.set(poolKey, start + 1);
  const n = Math.min(set.length, weighted([[1, 35], [2, 35], [3, 20], [4, 10]]));
  const stride = Math.max(1, Math.floor(set.length / 4));
  // storage_path inside the item-images bucket (seed photos are served from public/items)
  return Array.from({ length: n }, (_, i) => `items/${set[(start + i * stride) % set.length].src.split("/").pop()}`);
}

// =====================================================================
// Generate
// =====================================================================
const users = [];
const usedEmails = new Set();
for (let n = 0; n < STUDENTS; n++) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const email = nuEmail(first, last, usedEmails);
  const { joined, graduates } = enrollment();
  // Trading window inside the recorded history
  const start = Math.max(joined, HISTORY_START);
  const end = Math.min(graduates, NOW - HOUR);
  const graduated = graduates < NOW;
  users.push({
    id: randomUUID(),
    email,
    name: `${first} ${last}`,
    role: "student",
    // many graduates leave their account alone; some deactivate it
    account_status: graduated && chance(0.25) ? "deactivated" : weighted([["active", 990], ["suspended", 10]]),
    created_at: joined,
    start,
    end,
    graduated,
    style: weighted([["buyer", 30], ["casual", 55], ["power", 15]]),
  });
}
// The history only covers people who were on campus during it
const inHistory = users.filter((u) => u.end > u.start + 14 * DAY);
for (const u of inHistory.slice(0, 3)) {
  u.role = "admin"; // student moderators
  u.account_status = "active";
}
const admins = inHistory.slice(0, 3);
// A random student who was around at time `at` (and isn't the owner)
const someoneAt = (ownerId, at) => {
  for (let tries = 0; tries < 200; tries++) {
    const u = pick(inHistory);
    if (u.id !== ownerId && u.start <= at && u.end >= at && u.account_status !== "suspended") return u;
  }
  return inHistory.find((u) => u.id !== ownerId && u.start <= at && u.end >= at) ?? inHistory.find((u) => u.id !== ownerId);
};

const items = [];
const buyable = [];
const borrowable = [];
const images = [];
function addListing(u, created, { gradDump = false, repostOf = null } = {}) {
  created = Math.min(created, u.end - 6 * HOUR); // posted while the student is still around
  const category = repostOf ? repostOf.category : weighted(CATEGORY_PAIRS);
  const cat = CATALOG[category];
  const tpl = repostOf ? repostOf.tpl : pick(cat.items);
  const clean = repostOf ? repostOf.cleanTitle : typeof tpl.t === "function" ? tpl.t() : tpl.t;
  const condition = repostOf ? repostOf.condition : weighted([["new", 6], ["like_new", 30], ["good", 46], ["fair", 18]]);
  const parts = [pick(tpl.d), pick(CONDITION_PHRASE[condition]), gradDump ? pick(GRAD_REASONS) : pick(REASONS), pick(LOGISTICS)];
  const canRent = !!tpl.rent;
  const rentIt = repostOf ? repostOf.rent !== null : canRent && !gradDump && chance(Math.max(cat.rentP, 0.15));
  const sellIt = repostOf ? repostOf.sale !== null : !rentIt || !canRent || chance(0.6);
  let sale = sellIt ? between(tpl.sale) : null;
  if (sale !== null) {
    if (gradDump) sale = nice(sale * (0.5 + rand() * 0.3)); // graduation fire sale
    if (chance(0.015) && sale < 40) sale = 0; // free
    else if (chance(0.007)) sale = nice(sale * int(4, 9)); // wildly overpriced outlier
    else if (chance(0.08)) sale = Math.max(1, sale - 0.01); // $24.99-style pricing
    if (repostOf) sale = Math.max(0, nice((repostOf.sale ?? sale) * 0.85)); // reposts drop the price
  }
  const item = {
    item_id: items.length + 1,
    owner_id: u.id,
    owner: u,
    tpl,
    cleanTitle: clean,
    meetup_spot_id: repostOf ? repostOf.meetup_spot_id : weighted([[1, 26], [2, 22], [3, 10], [4, 16], [5, 14], [6, 7], [7, 5]]),
    title: repostOf && chance(0.6) ? repostOf.title : messyTitle(clean, R, { gradDump, priceDrop: !!repostOf }),
    description: messyDescription(parts, condition, R),
    category,
    condition,
    status: "available",
    created_at: created,
    updated_at: created,
    sale,
    rent: rentIt ? between(tpl.rent) : null,
  };
  if (item.rent !== null) item.deposit = chance(0.8) ? nice(Math.max(10, (item.sale || item.rent * 8) * (0.3 + rand() * 0.3))) : 0;
  items.push(item);
  if (item.sale !== null) buyable.push({ item_id: item.item_id, price: item.sale });
  if (item.rent !== null) borrowable.push({ item_id: item.item_id, price_per_week: item.rent, deposit: item.deposit });
  photosFor(tpl.k, category).forEach((path, position) => images.push({ item_id: item.item_id, storage_path: path, position }));
  return item;
}

for (const u of inHistory) {
  if (u.style === "buyer") continue;
  const semesters = (u.end - u.start) / (120 * DAY);
  const perSemester = u.style === "power" ? 2.2 : 0.55;
  const count = Math.round(semesters * perSemester * (0.5 + rand()));
  for (let k = 0; k < count; k++) addListing(u, dateIn(u.start, u.end));
  // Graduating seniors dump their room in the last weeks of April
  if (u.graduated && u.end > HISTORY_START && chance(0.55)) {
    const dumpStart = Math.max(u.start, u.end - 25 * DAY);
    for (let k = int(3, 10); k > 0; k--) addListing(u, atDaytime(dumpStart + rand() * (u.end - 5 * DAY - dumpStart)), { gradDump: true });
  }
}

const transactions = [];
const rentals = [];
const reviews = [];
const conversations = [];
const messages = [];
const convByPair = new Map();
const spotName = ["", "Snell", "Curry", "Marino", "IV", "West Village", "Mission Hill", "Fenway"];

function conversationFor(item, buyer, startedAt) {
  const key = `${item.item_id}:${buyer.id}`;
  if (convByPair.has(key)) return convByPair.get(key);
  const c = { conversation_id: conversations.length + 1, item_id: item.item_id, buyer_id: buyer.id, created_at: Math.max(startedAt, item.created_at + 5 * 60_000) };
  conversations.push(c);
  convByPair.set(key, c);
  return c;
}
function chat(conv, item, buyer, startAt, { rental, negotiate, done }) {
  let t = Math.max(startAt, conv.created_at); // nobody asks about an item before it is listed
  const seller = item.owner;
  const v = {
    item: shortTitle(item.cleanTitle), spot: spotName[item.meetup_spot_id], day: pick(DAYS), time: pick(TIMES), time2: pick(TIMES),
    offer: `$${nice((item.sale || item.rent || 10) * 0.85)}`, counter: `$${nice((item.sale || item.rent || 10) * 0.93)}`,
  };
  const lines = [[buyer, fill(pick(rental ? RENT_OPENERS : OPENERS), v)], [seller, pick(SELLER_REPLIES)]];
  if (negotiate && !rental) lines.push([buyer, fill(pick(NEGOTIATE), v)], [seller, fill(pick(NEGOTIATE_REPLIES), v)]);
  lines.push([buyer, fill(pick(LOGISTIC_ASKS), v)], [seller, fill(pick(LOGISTIC_REPLIES), v)]);
  if (done && chance(0.6)) lines.push([buyer, pick(AFTER)]);
  // some sellers take hours or days to reply
  const slowSeller = item.owner.slow ?? (item.owner.slow = chance(0.2));
  for (const [n, [who, body]] of lines.entries()) {
    t += (who === seller && slowSeller ? int(120, 2880) : int(2, 240)) * 60_000;
    // a chat always opens with a message; later replies may not have happened yet
    if (n === 0) t = Math.min(t, NOW - 2 * 60_000);
    else if (t > NOW - 60_000) break;
    const unread = NOW - t < 2 * DAY && chance(0.4);
    messages.push({ conversation_id: conv.conversation_id, sender_id: who.id, body: messyChat(body, R), sent_at: t, read_at: unread ? null : t + int(1, 180) * 60_000 });
  }
  return t;
}
// mood: 0 normal, -1 somewhat unhappy, -2 unhappy (late, damaged, slow replies)
function review(tx, reviewer, reviewee, at, mood = 0) {
  const rating = weighted(
    mood <= -2 ? [[5, 12], [4, 23], [3, 30], [2, 22], [1, 13]] : mood === -1 ? [[5, 35], [4, 35], [3, 18], [2, 8], [1, 4]] : [[5, 58], [4, 27], [3, 9], [2, 4], [1, 2]],
  );
  const comment = pick(REVIEW[rating]);
  reviews.push({ transaction_id: tx.transaction_id, reviewer_id: reviewer.id, reviewee_id: reviewee.id, rating,
    comment: comment && messyText(comment, R, 0.15), created_at: Math.min(NOW - 60_000, at + int(1, 96) * HOUR) });
}

// Reposts: some unsold listings come back later with a lower price (the original gets removed)
for (const item of [...items]) {
  if (chance(0.045)) {
    const later = item.created_at + int(7, 35) * DAY;
    if (later < item.owner.end) {
      const repost = addListing(item.owner, atDaytime(later), { repostOf: item });
      item.status = chance(0.8) ? "removed" : "available"; // a few sellers forget to take the old one down
      item.updated_at = later;
      repost.isRepost = true;
    }
  }
}

for (const item of items) {
  const end = Math.min(item.owner.end, NOW - HOUR); // nothing happens after the owner graduates
  const age = (end - item.created_at) / DAY;
  if (item.status === "removed") continue;
  if (item.owner.account_status === "suspended" && chance(0.7)) {
    item.status = "removed";
    continue;
  }

  // Past completed rentals (lenders build a rental history)
  if (item.rent !== null) {
    let cursor = item.created_at + int(1, 6) * DAY;
    const rounds = age > 30 ? weighted([[0, 30], [1, 35], [2, 22], [3, 13]]) : 0;
    for (let r = 0; r < rounds && cursor + 9 * DAY < end - 2 * DAY; r++) {
      const buyer = someoneAt(item.owner_id, cursor);
      const requested = cursor;
      const start = requested + int(1, 3) * DAY;
      const late = weighted([[0, 78], [1, 11], [int(2, 6), 8], [-1, 3]]);
      const startDay = Date.parse(dateOnly(start));
      const returned = Math.min(NOW - 2 * HOUR, startDay + (7 + late) * DAY + int(12, 22) * HOUR);
      const tx = { transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: buyer.id, type: "rental", agreed_price: item.rent,
        status: "completed", created_at: requested, completed_at: Math.min(NOW - HOUR, returned + int(1, 30) * HOUR) };
      transactions.push(tx);
      rentals.push({ transaction_id: tx.transaction_id, start_date: dateOnly(start), due_date: dateOnly(start + 7 * DAY), deposit_agreed: item.deposit,
        returned_at: returned, return_condition: (tx.condition = weighted([["as_lent", 84], ["minor_wear", 12], ["damaged", 4]])) });
      chat(conversationFor(item, buyer, requested - int(1, 20) * HOUR), item, buyer, requested - int(1, 20) * HOUR, { rental: true, done: true });
      if (chance(0.78)) review(tx, buyer, item.owner, tx.completed_at);
      // lenders rate late or damaged returns lower
      if (chance(late > 0 || tx.condition === "damaged" ? 0.8 : 0.62)) review(tx, item.owner, buyer, tx.completed_at, late > 1 || tx.condition === "damaged" ? -2 : late === 1 ? -1 : 0);
      cursor = returned + int(2, 25) * DAY;
    }
  }

  // Final state: graduates' listings are always closed; otherwise older = more likely closed
  const ownerGone = item.owner.end < NOW - DAY;
  const pClosed = ownerGone ? 1 : Math.min(0.78, age / 110);
  const outcome = chance(pClosed)
    ? weighted([["sold", item.sale !== null ? 72 : 0], ["removed", 22], ["rented_now", item.rent !== null && !ownerGone ? 8 : 0]])
    : (age < 10 && chance(0.35)) || chance(0.04) ? weighted([["requested", 65], ["accepted", 35]])
      : "available";

  // every deal and chat happens after the listing exists
  const after = (t, gap = 30 * 60_000) => Math.min(NOW - 5 * 60_000, Math.max(t, item.created_at + gap));
  const dealStart = after(Math.min(end - HOUR, item.created_at + Math.min(age * 0.8, rand() * 20) * DAY), HOUR);
  if (outcome === "sold") {
    const buyer = someoneAt(item.owner_id, dealStart);
    const negotiated = chance(0.35) && item.sale > 0;
    const price = negotiated ? nice(item.sale * (0.82 + rand() * 0.12)) : item.sale;
    const done = after(Math.min(end, dealStart + int(4, 96) * HOUR), 2 * HOUR);
    const tx = { transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: buyer.id, type: "sale", agreed_price: price,
      status: "completed", created_at: dealStart, completed_at: Math.max(done, dealStart + HOUR) };
    transactions.push(tx);
    chat(conversationFor(item, buyer, dealStart - int(1, 30) * HOUR), item, buyer, dealStart - int(1, 30) * HOUR, { negotiate: negotiated, done: true });
    if (chance(0.78)) review(tx, buyer, item.owner, tx.completed_at, item.owner.slow ? -1 : 0);
    if (chance(0.62)) review(tx, item.owner, buyer, tx.completed_at);
    item.status = "sold";
    item.updated_at = tx.completed_at;
    if (chance(0.25)) {
      const other = someoneAt(item.owner_id, dealStart);
      if (other.id !== buyer.id) {
        transactions.push({ transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: other.id, type: "sale", agreed_price: item.sale,
          status: "declined", created_at: dealStart + int(1, 20) * HOUR, completed_at: null });
        chat(conversationFor(item, other, dealStart), item, other, dealStart, {});
      }
    }
  } else if (outcome === "rented_now") {
    const buyer = someoneAt(item.owner_id, NOW - 10 * DAY);
    const start = NOW - int(0, 9) * DAY - int(1, 10) * HOUR; // a few are overdue
    const tx = { transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: buyer.id, type: "rental", agreed_price: item.rent,
      status: "handed_over", created_at: start - int(1, 3) * DAY, completed_at: null };
    transactions.push(tx);
    rentals.push({ transaction_id: tx.transaction_id, start_date: dateOnly(start), due_date: dateOnly(start + 7 * DAY), deposit_agreed: item.deposit, returned_at: null, return_condition: null });
    chat(conversationFor(item, buyer, tx.created_at - int(1, 10) * HOUR), item, buyer, tx.created_at - int(1, 10) * HOUR, { rental: true });
    item.status = "rented_out";
    item.updated_at = start;
  } else if (outcome === "requested" || outcome === "accepted") {
    const at = after(Math.min(NOW - HOUR, item.created_at + int(2, 40) * HOUR), 20 * 60_000);
    const buyer = someoneAt(item.owner_id, at);
    const type = item.sale !== null ? "sale" : "rental";
    transactions.push({ transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: buyer.id, type,
      agreed_price: type === "sale" ? item.sale : item.rent, status: outcome, created_at: at, completed_at: null });
    chat(conversationFor(item, buyer, at - HOUR), item, buyer, at - HOUR, { rental: type === "rental" });
    if (outcome === "accepted") item.status = "reserved";
  } else if (outcome === "removed") {
    item.status = "removed";
    item.updated_at = Math.min(end, item.created_at + int(5, 60) * DAY);
  }

  // Cancelled deals and questions that went nowhere
  if (chance(0.06)) {
    const at = after(Math.min(end, item.created_at + int(1, 10) * DAY));
    const b = someoneAt(item.owner_id, at);
    if (!transactions.some((t) => t.item_id === item.item_id && t.buyer_id === b.id)) {
      transactions.push({ transaction_id: transactions.length + 1, item_id: item.item_id, buyer_id: b.id, type: item.sale !== null ? "sale" : "rental",
        agreed_price: item.sale ?? item.rent, status: "cancelled", created_at: at, completed_at: null });
      chat(conversationFor(item, b, at - HOUR), item, b, at - HOUR, {});
    }
  }
  for (let q = weighted([[0, 50], [1, 35], [2, 15]]); q > 0; q--) {
    const at = after(Math.min(end, item.created_at + int(1, 12) * DAY));
    const b = someoneAt(item.owner_id, at);
    if (!convByPair.has(`${item.item_id}:${b.id}`)) chat(conversationFor(item, b, at), item, b, at, {});
  }
}

// Saved items: recent available listings get saved most
const saved = [];
const savedKeys = new Set();
const savable = items.filter((i) => i.status === "available" || i.status === "reserved").sort((a, b) => b.created_at - a.created_at);
for (let n = 0; n < 9000 && savable.length; n++) {
  const i = savable[Math.floor(Math.pow(rand(), 1.8) * savable.length)];
  const at = Math.min(NOW - HOUR, i.created_at + rand() * Math.max(HOUR, NOW - i.created_at));
  const u = someoneAt(i.owner_id, at);
  const key = `${u.id}:${i.item_id}`;
  if (savedKeys.has(key)) continue;
  savedKeys.add(key);
  saved.push({ user_id: u.id, item_id: i.item_id, saved_at: at });
}

// Moderation reports (duplicates and no-shows dominate)
const reports = [];
for (let n = 0; n < 160; n++) {
  const target = weighted([["item", 45], ["transaction", 35], ["user", 20]]);
  let row = { item_id: null, transaction_id: null, reported_user_id: null };
  let at;
  if (target === "item") {
    const reposts = items.filter((i) => i.isRepost);
    const i = chance(0.3) && reposts.length ? pick(reposts) : pick(items);
    row.item_id = i.item_id;
    at = i.created_at + int(1, 72) * HOUR;
  } else if (target === "transaction") {
    const t = pick(transactions);
    row.transaction_id = t.transaction_id;
    at = t.created_at + int(1, 10) * DAY;
  } else {
    row.reported_user_id = pick(inHistory).id;
    at = NOW - int(1, 900) * DAY;
  }
  at = Math.min(Math.max(at, HISTORY_START), NOW - 2 * HOUR);
  const reporter = someoneAt(row.reported_user_id, at);
  const status = NOW - at < 3 * DAY ? weighted([["open", 70], ["in_review", 30]]) : weighted([["resolved", 78], ["in_review", 8], ["open", 14]]);
  const resolved = status === "resolved";
  reports.push({
    reporter_id: reporter.id, ...row, reason: pick(REPORT_REASONS[target]), status,
    admin_notes: resolved || status === "in_review" ? pick(ADMIN_NOTES) : null,
    resolved_by: resolved ? pick(admins).id : null,
    created_at: at, resolved_at: resolved ? Math.min(NOW - HOUR, at + int(2, 120) * HOUR) : null,
  });
}

const stats = {
  users: users.length, in_history: inHistory.length, graduated: users.filter((u) => u.graduated).length, items: items.length,
  reposts: items.filter((i) => i.isRepost).length, buyable: buyable.length, borrowable: borrowable.length, item_images: images.length,
  transactions: transactions.length, rentals: rentals.length, reviews: reviews.length, conversations: conversations.length,
  messages: messages.length, saved_items: saved.length, reports: reports.length,
};
console.log(stats);
console.log("item status:", items.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {}));
console.log("deal status:", transactions.reduce((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {}));
console.log("sample titles:", items.slice(0, 400).filter((_, i) => i % 40 === 0).map((i) => i.title).join(" | "));
console.log("sample chat:", messages.slice(100, 106).map((m) => m.body).join(" / "));
if (args.has("--dry-run")) process.exit(0);

// =====================================================================
// Load
// =====================================================================
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = join(ROOT, ".env.local");
  if (existsSync(env)) {
    const line = readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  console.error("Missing DATABASE_URL. Add it to .env.local (Supabase dashboard > Connect > Session pooler).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } });
await client.connect();

async function insert(table, columns, rows, { overriding = false } = {}) {
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const tuples = chunk.map((row, r) => `(${columns.map((c, k) => { values.push(row[c]); return `$${r * columns.length + k + 1}`; }).join(",")})`);
    await client.query(
      `insert into ${table} (${columns.join(",")}) ${overriding ? "overriding system value " : ""}values ${tuples.join(",")}`,
      values,
    );
  }
  process.stdout.write(`  ${table}: ${rows.length}\n`);
}
const ts = (ms) => (ms == null ? null : iso(ms));

try {
  await client.query("begin");
  await client.query("set local statement_timeout = 0");
  const { rows } = await client.query("select count(*)::int as n from public.items");
  if (rows[0].n > 0 && !args.has("--reset")) throw new Error("Database already has items. Re-run with --reset to replace the seed data.");
  if (args.has("--reset")) {
    // Real (non-seeded) students keep their accounts; all marketplace data is replaced
    await client.query(`truncate public.reports, public.reviews, public.rentals, public.transactions, public.messages, public.conversations,
      public.saved_items, public.item_images, public.borrowable_items, public.buyable_items, public.items restart identity cascade`);
    await client.query(`delete from auth.users where raw_app_meta_data ->> 'seed' = 'huskyswap'`); // profiles cascade
  }

  // Auth users -> the on_auth_user_created trigger creates each profile from raw_user_meta_data.name
  await insert("auth.users",
    ["instance_id", "id", "aud", "role", "email", "email_confirmed_at", "raw_app_meta_data", "raw_user_meta_data", "created_at", "updated_at",
     "confirmation_token", "recovery_token", "email_change_token_new", "email_change"],
    users.map((u) => ({
      instance_id: "00000000-0000-0000-0000-000000000000", id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
      email_confirmed_at: ts(u.created_at), raw_app_meta_data: JSON.stringify({ provider: "email", providers: ["email"], seed: "huskyswap" }),
      raw_user_meta_data: JSON.stringify({ name: u.name }), created_at: ts(u.created_at), updated_at: ts(u.created_at),
      // empty strings, not nulls: Supabase Auth fails to list users with null tokens
      confirmation_token: "", recovery_token: "", email_change_token_new: "", email_change: "",
    })));
  await client.query(
    `update public.profiles p set role = v.role::public.user_role, account_status = v.status::public.account_status, created_at = v.created_at::timestamptz
     from jsonb_to_recordset($1::jsonb) as v(id uuid, role text, status text, created_at text) where p.id = v.id`,
    [JSON.stringify(users.map((u) => ({ id: u.id, role: u.role, status: u.account_status, created_at: ts(u.created_at) })))],
  );
  console.log("  profiles: updated roles, statuses and join dates");

  await client.query("alter table public.items disable trigger items_set_updated_at"); // keep historical updated_at
  await insert("public.items", ["item_id", "owner_id", "meetup_spot_id", "title", "description", "category", "condition", "status", "created_at", "updated_at"],
    items.map((i) => ({ ...i, created_at: ts(i.created_at), updated_at: ts(i.updated_at) })), { overriding: true });
  await client.query("alter table public.items enable trigger items_set_updated_at");
  await insert("public.buyable_items", ["item_id", "price"], buyable);
  await insert("public.borrowable_items", ["item_id", "price_per_week", "deposit"], borrowable);
  await insert("public.item_images", ["item_id", "storage_path", "position"], images);
  await insert("public.saved_items", ["user_id", "item_id", "saved_at"], saved.map((x) => ({ ...x, saved_at: ts(x.saved_at) })));
  await insert("public.conversations", ["conversation_id", "item_id", "buyer_id", "created_at"],
    conversations.map((c) => ({ ...c, created_at: ts(c.created_at) })), { overriding: true });
  await insert("public.messages", ["conversation_id", "sender_id", "body", "sent_at", "read_at"],
    messages.sort((a, b) => a.sent_at - b.sent_at).map((m) => ({ ...m, sent_at: ts(m.sent_at), read_at: ts(m.read_at) })));
  await insert("public.transactions", ["transaction_id", "item_id", "buyer_id", "type", "agreed_price", "status", "created_at", "completed_at"],
    transactions.map((t) => ({ ...t, created_at: ts(t.created_at), completed_at: ts(t.completed_at) })), { overriding: true });
  await insert("public.rentals", ["transaction_id", "start_date", "due_date", "deposit_agreed", "returned_at", "return_condition"],
    rentals.map((r) => ({ ...r, returned_at: ts(r.returned_at) })));
  await insert("public.reviews", ["transaction_id", "reviewer_id", "reviewee_id", "rating", "comment", "created_at"],
    reviews.map((r) => ({ ...r, created_at: ts(r.created_at) })));
  await insert("public.reports", ["reporter_id", "item_id", "transaction_id", "reported_user_id", "reason", "status", "admin_notes", "resolved_by", "created_at", "resolved_at"],
    reports.map((r) => ({ ...r, created_at: ts(r.created_at), resolved_at: ts(r.resolved_at) })));

  // Identity columns continue after the explicit ids
  for (const [table, col] of [["items", "item_id"], ["conversations", "conversation_id"], ["transactions", "transaction_id"]]) {
    await client.query(`select setval(pg_get_serial_sequence('public.${table}', '${col}'), (select coalesce(max(${col}), 1) from public.${table}))`);
  }
  await client.query("commit");
  console.log("Seed complete.");
} catch (e) {
  await client.query("rollback");
  console.error("Seed failed, nothing was written:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
