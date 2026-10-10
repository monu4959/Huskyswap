// Keeps the marketplace alive: simulates the last N days of student activity
// (new students and listings, deals moving forward, rentals coming back, chats,
// saves, reviews, reports) at a rate that follows the academic calendar.
// Meant to run once a day (cron / Airflow), so the text-to-SQL model always
// faces fresh data, and so you can inject DRIFT on purpose and watch monitoring
// catch it.
//
//   node scripts/simulate-day.mjs                       # the last 24 hours
//   node scripts/simulate-day.mjs --days=7              # backfill a week
//   node scripts/simulate-day.mjs --dry-run             # plan only, write nothing
//
// Drift knobs (recorded in ops.simulation_runs):
//   --trend=vision-pro|stanley-cup|e-bike|ai-pin        # a product the model never saw
//   --new-spot="ISEC Building"                          # a new meetup spot appears
//   --inflation=1.2                                     # new listings priced 20% higher
//   --surge=3                                           # 3x normal activity (e.g. move-out)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { makeCatalog } from "./catalog.mjs";
import { messyChat, messyDescription, messyTitle } from "./messy.mjs";
import { FIRST, LAST, nuEmail } from "./people.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const DAYS = Number(arg("days", 1));
const DRY = !!arg("dry-run", false);
const TREND = arg("trend", null);
const NEW_SPOT = arg("new-spot", null);
const INFLATION = Number(arg("inflation", 1));
const SURGE = Number(arg("surge", 1));

// ---------- random ----------
let s = Number(arg("seed", Date.now() % 2 ** 31)) >>> 0;
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
const R = { rand, int, pick, chance, weighted };
const nice = (n) => (n < 10 ? Math.max(1, Math.round(n)) : n < 50 ? Math.round(n) : Math.round(n / 5) * 5);
const between = ([a, b]) => nice(a + rand() * (b - a));
// roughly Poisson count with the given mean
const count = (mean) => {
  let n = 0;
  for (let k = 0; k < Math.ceil(mean * 2); k++) if (chance(mean / Math.ceil(mean * 2))) n++;
  return n;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const START = NOW - DAYS * DAY;
const iso = (ms) => new Date(ms).toISOString();
const dateOnly = (ms) => iso(ms).slice(0, 10);
const inDay = (dayStart) => Math.min(NOW - 60_000, dayStart + (13 + int(0, 15)) * HOUR - (dayStart % DAY) + int(0, 59) * 60_000);

function seasonWeight(ms) {
  const d = new Date(ms);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if ((m === 3 && day >= 20) || (m === 4 && day <= 20)) return 4;
  if ((m === 7 && day >= 10) || (m === 8 && day <= 15)) return 3.5;
  if (m === 11 && day <= 22) return 2;
  if (m === 0 && day <= 20) return 1.8;
  if (m === 5 || m === 6) return 0.5;
  return 1;
}

// Products that don't exist in the training data: classic concept drift
const TRENDS = {
  "vision-pro": { category: "electronics", titles: ["Apple Vision Pro 256GB", "Vision Pro w/ travel case", "apple vision pro (barely used)"], sale: [1700, 2600], rent: [60, 120] },
  "stanley-cup": { category: "kitchen", titles: ["Stanley Quencher 40oz tumbler", "stanley cup 30 oz", "Stanley tumbler - pink"], sale: [20, 45], rent: null },
  "e-bike": { category: "bikes_transport", titles: ["Rad Power e-bike", "Lectric XP 3.0 e-bike", "electric bike w/ charger"], sale: [600, 1400], rent: [40, 80] },
  "ai-pin": { category: "electronics", titles: ["Humane AI Pin", "AI pin wearable", "Rabbit R1 AI device"], sale: [80, 400], rent: [15, 30] },
};
if (TREND && !TRENDS[TREND]) {
  console.error(`Unknown --trend. Pick one of: ${Object.keys(TRENDS).join(", ")}`);
  process.exit(1);
}

const CATALOG = makeCatalog(pick);
const CATEGORY_PAIRS = Object.entries(CATALOG).map(([c, v]) => [c, v.weight]);
const CONDITION_PHRASE = {
  new: ["Brand new, never used."], like_new: ["Like new, barely used.", "Excellent condition."],
  good: ["Good condition, some normal wear."], fair: ["Visible wear, priced to match."],
};
const photosFile = join(ROOT, "src", "data", "photos.json");
const PHOTOS = Object.fromEntries(
  Object.entries(existsSync(photosFile) ? JSON.parse(readFileSync(photosFile, "utf8")) : {}).map(([k, l]) => [k, l.filter((p) => p.reviewed)]),
);
const categoryPhotos = (category) => [...new Set(CATALOG[category].items.map((t) => t.k))].flatMap((k) => PHOTOS[k] ?? []);
const photoPaths = (list) => {
  if (!list.length) return [];
  const start = int(0, list.length - 1);
  return Array.from({ length: Math.min(list.length, int(1, 3)) }, (_, i) => `items/${list[(start + i * 3) % list.length].src.split("/").pop()}`);
};

const OPENERS = ["Hi! Is this still available?", "Hey, is the {item} still for sale?", "is this still available", "Could I rent this for a week?"];
const REPLIES = ["Yes, still available!", "yep still have it", "Yes it is. When works for you?"];
const LOGISTICS = ["Could we meet at {spot} tomorrow around 4?", "Does Friday at 3 work?", "{spot} at 5?"];
const CONFIRMS = ["Works for me, see you then!", "Perfect.", "sounds good"];
const REVIEWS = { 5: ["Super easy handoff.", "Great seller!", null, null], 4: ["Smooth pickup.", null], 3: ["It was okay.", null], 2: ["Late to meet."], 1: ["No-show the first time."] };

// ---------- database ----------
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const line = readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  return line?.slice("DATABASE_URL=".length).trim();
}
const db = new pg.Client({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (sql, params) => db.query(sql, params).then((r) => r.rows);

const tally = { students: 0, listings: 0, requests: 0, accepted: 0, declined: 0, cancelled: 0, handed_over: 0, sales_completed: 0,
  rentals_returned: 0, rentals_closed: 0, conversations: 0, messages: 0, saves: 0, reviews: 0, reports: 0 };

try {
  await db.query("begin");
  await q(`create schema if not exists ops;
    create table if not exists ops.simulation_runs (
      run_id bigint generated always as identity primary key,
      ran_at timestamptz not null default now(),
      window_start timestamptz not null,
      window_end timestamptz not null,
      drift jsonb not null default '{}',
      counts jsonb not null default '{}'
    );`);

  let spots = await q("select spot_id, name from public.meetup_spots order by spot_id");
  let newSpotId = null;
  if (NEW_SPOT) {
    const [row] = await q("insert into public.meetup_spots (name) values ($1) on conflict (name) do update set name = excluded.name returning spot_id", [NEW_SPOT]);
    newSpotId = row.spot_id;
    spots = await q("select spot_id, name from public.meetup_spots order by spot_id");
  }
  const spotName = Object.fromEntries(spots.map((r) => [r.spot_id, r.name.replace(/ \(off campus\)/, "")]));

  // Students who could plausibly be on campus: active and joined in the last ~4.5 years
  let students = (await q(
    "select id from public.profiles where account_status = 'active' and created_at > now() - interval '4 years 6 months'",
  )).map((r) => r.id);
  const takenEmails = new Set((await q("select lower(email) as email from auth.users")).map((r) => r.email));
  const someone = (not) => {
    for (let k = 0; k < 50; k++) {
      const id = pick(students);
      if (id !== not) return id;
    }
    return students.find((id) => id !== not);
  };

  for (let dayStart = START; dayStart < NOW; dayStart += DAY) {
    const w = seasonWeight(dayStart) * SURGE * Math.min(1, (NOW - dayStart) / DAY);

    // New students: a trickle, a flood at semester start
    for (let n = count(0.6 * w); n > 0; n--) {
      const id = randomUUID();
      const first = pick(FIRST);
      const last = pick(LAST);
      await q(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
           created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, $3, '{"provider":"email","providers":["email"],"seed":"huskyswap"}',
           $4, $3, $3, '', '', '', '')`,
        [id, nuEmail(first, last, takenEmails), iso(inDay(dayStart)), JSON.stringify({ name: `${first} ${last}` })],
      );
      students.push(id);
      tally.students++;
    }

    // New listings
    for (let n = count(16 * w); n > 0; n--) {
      const owner = pick(students);
      const created = inDay(dayStart);
      const trend = TREND && chance(0.3) ? TRENDS[TREND] : null;
      const category = trend ? trend.category : weighted(CATEGORY_PAIRS);
      const tpl = trend ? null : pick(CATALOG[category].items);
      const clean = trend ? pick(trend.titles) : typeof tpl.t === "function" ? tpl.t() : tpl.t;
      const condition = weighted([["new", 6], ["like_new", 30], ["good", 46], ["fair", 18]]);
      const saleRange = trend ? trend.sale : tpl.sale;
      const rentRange = trend ? trend.rent : tpl.rent;
      const rentIt = !!rentRange && chance(0.3);
      const sale = !rentIt || chance(0.6) ? nice(between(saleRange) * INFLATION) : null;
      const rent = rentIt ? nice(between(rentRange) * INFLATION) : null;
      const spot = newSpotId && chance(0.25) ? newSpotId : weighted([[1, 26], [2, 22], [3, 10], [4, 16], [5, 14], [6, 7], [7, 5]]);
      const description = messyDescription([trend ? "Selling my " + clean.toLowerCase() + "." : pick(tpl.d), pick(CONDITION_PHRASE[condition])], condition, R);
      const [{ item_id }] = await q(
        `insert into public.items (owner_id, meetup_spot_id, title, description, category, condition, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7) returning item_id`,
        [owner, spot, messyTitle(clean, R), description, category, condition, iso(created)],
      );
      if (sale !== null) await q("insert into public.buyable_items (item_id, price) values ($1, $2)", [item_id, sale]);
      if (rent !== null) await q("insert into public.borrowable_items (item_id, price_per_week, deposit) values ($1, $2, $3)", [item_id, rent, chance(0.8) ? nice((sale ?? rent * 8) * 0.4) : 0]);
      const photos = photoPaths(trend ? categoryPhotos(category) : (PHOTOS[tpl.k]?.length ? PHOTOS[tpl.k] : categoryPhotos(category)));
      for (const [position, path] of photos.entries()) await q("insert into public.item_images (item_id, storage_path, position) values ($1, $2, $3)", [item_id, path, position]);
      tally.listings++;
    }

    // Interested buyers: chats, saves and new requests on available listings
    const market = await q(
      `select i.item_id, i.owner_id, i.meetup_spot_id, i.title, b.price, r.price_per_week
       from public.items i left join public.buyable_items b using (item_id) left join public.borrowable_items r using (item_id)
       where i.status = 'available' and i.created_at < $1 order by random() limit 400`,
      [iso(dayStart + DAY)],
    );
    if (market.length) {
      for (let n = count(25 * w); n > 0; n--) {
        const it = pick(market);
        const buyer = someone(it.owner_id);
        const startedAt = inDay(dayStart);
        const [conv] = await q(
          `insert into public.conversations (item_id, buyer_id, created_at) values ($1, $2, $3)
           on conflict (item_id, buyer_id) do nothing returning conversation_id`,
          [it.item_id, buyer, iso(startedAt)],
        );
        if (!conv) continue;
        tally.conversations++;
        const v = { item: it.title.toLowerCase().replace(/,.*$/, ""), spot: spotName[it.meetup_spot_id] };
        const lines = [[buyer, pick(OPENERS)], [it.owner_id, pick(REPLIES)], [buyer, pick(LOGISTICS)], [it.owner_id, pick(CONFIRMS)]];
        let t = startedAt;
        for (const [n, [who, body]] of lines.slice(0, int(1, 4)).entries()) {
          t += int(3, 300) * 60_000;
          // a chat always opens with a message; later replies may not have happened yet
          if (n === 0) t = Math.min(t, NOW - 2 * 60_000);
          else if (t > NOW - 60_000) break;
          await q("insert into public.messages (conversation_id, sender_id, body, sent_at, read_at) values ($1, $2, $3, $4, $5)",
            [conv.conversation_id, who, messyChat(body.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? ""), R), iso(t), NOW - t > 6 * HOUR ? iso(t + int(5, 300) * 60_000) : null]);
          tally.messages++;
        }
      }
      for (let n = count(35 * w); n > 0; n--) {
        const it = pick(market);
        const rows = await q("insert into public.saved_items (user_id, item_id, saved_at) values ($1, $2, $3) on conflict do nothing returning item_id",
          [someone(it.owner_id), it.item_id, iso(inDay(dayStart))]);
        tally.saves += rows.length;
      }
      for (let n = count(10 * w); n > 0; n--) {
        const it = pick(market);
        const type = it.price !== null && (it.price_per_week === null || chance(0.6)) ? "sale" : "rental";
        const busy = await q("select 1 from public.transactions where item_id = $1 and status in ('accepted', 'handed_over')", [it.item_id]);
        if (busy.length) continue;
        const rows = await q(
          `insert into public.transactions (item_id, buyer_id, type, agreed_price, created_at) values ($1, $2, $3, $4, $5)
           on conflict do nothing returning transaction_id`,
          [it.item_id, someone(it.owner_id), type, type === "sale" ? it.price : it.price_per_week, iso(inDay(dayStart))],
        );
        tally.requests += rows.length;
      }
    }

    // Deals move forward (as of the end of this simulated day)
    const asOf = Math.min(NOW - 60_000, dayStart + DAY);
    const due = await q(
      `select t.transaction_id, t.item_id, t.buyer_id, t.type, t.status, t.created_at, i.owner_id, i.status as item_status,
              rn.due_date, br.deposit
       from public.transactions t join public.items i using (item_id)
       left join public.rentals rn using (transaction_id) left join public.borrowable_items br on br.item_id = t.item_id
       where t.status in ('requested', 'accepted', 'handed_over', 'returned') and t.created_at < $1
       order by random() limit 300`,
      [iso(asOf - DAY)],
    );
    for (const d of due) {
      const at = iso(inDay(dayStart));
      if (d.status === "requested" && chance(0.5)) {
        const outcome = d.item_status === "available" ? weighted([["accepted", 60], ["declined", 25], ["cancelled", 15]]) : "declined";
        if (outcome === "accepted") {
          const clash = await q("select 1 from public.transactions where item_id = $1 and status in ('accepted', 'handed_over')", [d.item_id]);
          if (clash.length) continue;
          await q("update public.transactions set status = 'accepted' where transaction_id = $1", [d.transaction_id]);
          await q("update public.transactions set status = 'declined' where item_id = $1 and status = 'requested' and transaction_id <> $2", [d.item_id, d.transaction_id]);
          await q("update public.items set status = 'reserved' where item_id = $1", [d.item_id]);
        } else {
          await q("update public.transactions set status = $2 where transaction_id = $1", [d.transaction_id, outcome]);
        }
        tally[outcome]++;
      } else if (d.status === "accepted" && chance(0.6)) {
        await q("update public.transactions set status = 'handed_over' where transaction_id = $1", [d.transaction_id]);
        if (d.type === "rental") {
          const start = dateOnly(asOf);
          await q("insert into public.rentals (transaction_id, start_date, due_date, deposit_agreed) values ($1, $2::date, $2::date + 7, $3)",
            [d.transaction_id, start, d.deposit ?? 0]);
          await q("update public.items set status = 'rented_out' where item_id = $1", [d.item_id]);
        }
        tally.handed_over++;
      } else if (d.status === "handed_over" && d.type === "sale" && chance(0.7)) {
        await q("update public.transactions set status = 'completed', completed_at = $2 where transaction_id = $1", [d.transaction_id, at]);
        await q("update public.items set status = 'sold' where item_id = $1", [d.item_id]);
        await review(d, at);
        tally.sales_completed++;
      } else if (d.status === "handed_over" && d.type === "rental" && d.due_date && new Date(d.due_date).getTime() <= asOf + int(-1, 2) * DAY && chance(0.8)) {
        await q("update public.transactions set status = 'returned' where transaction_id = $1", [d.transaction_id]);
        await q("update public.rentals set returned_at = $2, return_condition = $3 where transaction_id = $1",
          [d.transaction_id, at, weighted([["as_lent", 84], ["minor_wear", 12], ["damaged", 4]])]);
        await q("update public.items set status = 'available' where item_id = $1", [d.item_id]);
        tally.rentals_returned++;
      } else if (d.status === "returned" && chance(0.8)) {
        await q("update public.transactions set status = 'completed', completed_at = $2 where transaction_id = $1", [d.transaction_id, at]);
        await review(d, at);
        tally.rentals_closed++;
      }
    }

    // The odd moderation report
    for (let n = count(0.25 * w); n > 0; n--) {
      const [it] = await q("select item_id, owner_id from public.items where created_at < $1 order by random() limit 1", [iso(asOf)]);
      if (!it) continue;
      await q("insert into public.reports (reporter_id, item_id, reason, created_at) values ($1, $2, $3, $4)",
        [someone(it.owner_id), it.item_id, pick(["Looks like a duplicate listing.", "Price seems like a scam.", "photos dont match", "Seller never showed up."]), iso(inDay(dayStart))]);
      tally.reports++;
    }
  }

  async function review(d, at) {
    const rating = () => weighted([[5, 58], [4, 27], [3, 9], [2, 4], [1, 2]]);
    for (const [reviewer, reviewee, p] of [[d.buyer_id, d.owner_id, 0.75], [d.owner_id, d.buyer_id, 0.6]]) {
      if (!chance(p)) continue;
      const r = rating();
      await q("insert into public.reviews (transaction_id, reviewer_id, reviewee_id, rating, comment, created_at) values ($1, $2, $3, $4, $5, $6) on conflict do nothing",
        [d.transaction_id, reviewer, reviewee, r, pick(REVIEWS[r]), at]);
      tally.reviews++;
    }
  }

  const drift = { trend: TREND, new_spot: NEW_SPOT, inflation: INFLATION !== 1 ? INFLATION : null, surge: SURGE !== 1 ? SURGE : null };
  await q("insert into ops.simulation_runs (window_start, window_end, drift, counts) values ($1, $2, $3, $4)",
    [iso(START), iso(NOW), JSON.stringify(drift), JSON.stringify(tally)]);

  if (DRY) {
    await db.query("rollback");
    console.log("Dry run (rolled back):", tally);
  } else {
    await db.query("commit");
    console.log(`Simulated ${DAYS} day(s):`, tally, Object.values(drift).some(Boolean) ? `\nDrift injected: ${JSON.stringify(drift)}` : "");
  }
} catch (e) {
  await db.query("rollback");
  console.error("Simulation failed, nothing was written:", e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
