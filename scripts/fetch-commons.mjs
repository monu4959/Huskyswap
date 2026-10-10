// Adds product photos from Wikimedia Commons categories (sorted by people, so
// they're on-topic) to src/data/photos.json. Free licenses only: public domain,
// CC0, CC BY, CC BY-SA. New photos are saved with reviewed: false and the app
// ignores them until someone checks them.
//
//   node scripts/fetch-commons.mjs                  # every item type
//   node scripts/fetch-commons.mjs --only=desk,fan  # specific types
//   node scripts/fetch-commons.mjs --per=8          # new photos per type (default 8)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMG_DIR = join(ROOT, "public", "items");
const MANIFEST = join(ROOT, "src", "data", "photos.json");
const REJECT = join(ROOT, "scripts", "photo-reject.json");
const API = "https://commons.wikimedia.org/w/api.php";
const UA = "HuskySwap-demo/0.1 (personal student project; image fetcher)";

// Photo key -> Commons categories to try, in order
const CATEGORIES = {
  "textbook-math": ["Textbooks"], "textbook-physics": ["Textbooks"], "textbook-chemistry": ["Textbooks"],
  "textbook-biology": ["Textbooks"], "textbook-programming": ["Textbooks", "Books on shelves"],
  "textbook-economics": ["Textbooks"], "textbook-psychology": ["Textbooks"], "textbook-business": ["Textbooks"],
  "textbook-engineering": ["Textbooks"],
  "graphing-calculator": ["Graphing calculators"], ipad: ["IPad"], monitor: ["Computer monitors"],
  earbuds: ["AirPods"], keyboard: ["Computer keyboards"], "game-console": ["Nintendo Switch"],
  speaker: ["Bluetooth speakers"], camera: ["Canon EOS cameras", "Digital cameras"],
  ereader: ["Amazon Kindle", "E-book readers"], "ring-light": ["Ring lights"], "drawing-tablet": ["Graphics tablets"],
  desk: ["Desks"], "office-chair": ["Office chairs"], bookshelf: ["Bookcases"], futon: ["Futons"],
  "floor-lamp": ["Floor lamps"], "bean-bag": ["Bean bag chairs", "Bean bags"], nightstand: ["Nightstands", "Bedside tables"],
  mirror: ["Full-length mirrors", "Mirrors"],
  "instant-pot": ["Instant Pot", "Electric pressure cookers", "Pressure cookers"], "air-fryer": ["Air fryers"],
  kettle: ["Electric kettles"], "rice-cooker": ["Rice cookers"], cookware: ["Cookware", "Frying pans", "Pots"],
  "coffee-maker": ["Coffee makers", "Drip coffee makers"], "stand-mixer": ["Stand mixers", "KitchenAid mixers"],
  blender: ["Blenders", "Blenders (appliance)"],
  "puffer-jacket": ["Down jackets", "Puffer jackets"], suit: ["Suits (clothing)", "Business suits"],
  "winter-boots": ["Winter boots", "Snow boots"], hoodie: ["Hoodies", "Hooded sweatshirts"], blazer: ["Blazers"],
  costume: ["Halloween costumes"],
  "mini-fridge": ["Minibars", "Compact refrigerators", "Refrigerators"], microwave: ["Microwave ovens"],
  "mattress-topper": ["Mattresses"], bedding: ["Bed sheets", "Bedding"], fan: ["Electric fans", "Box fans"],
  "space-heater": ["Space heaters", "Electric heaters"], "shoe-rack": ["Shoe racks"], "shower-caddy": ["Towels", "Bath towels"],
  iron: ["Ironing boards", "Clothes irons"], vacuum: ["Vacuum cleaners"],
  tent: ["Tents", "Camping tents", "Dome tents"], dumbbells: ["Dumbbells"], snowboard: ["Snowboards"],
  "ski-boots": ["Ski boots"], "yoga-mat": ["Yoga mats"], "hiking-backpack": ["Backpacks", "Hiking backpacks"],
  "tennis-racket": ["Tennis rackets"], "sleeping-bag": ["Sleeping bags"], "ice-skates": ["Ice skates", "Figure skates"],
  "hybrid-bike": ["Hybrid bicycles", "City bicycles"], "road-bike": ["Road bicycles"], "bike-lock": ["Bicycle locks", "U-locks"],
  scooter: ["Electric kick scooters", "Electric scooters"], helmet: ["Bicycle helmets"],
  "folding-bike": ["Folding bicycles", "Brompton bicycles"],
  "board-game": ["Board games"], guitar: ["Acoustic guitars"], projector: ["Video projectors"], luggage: ["Suitcases"],
  "sewing-machine": ["Sewing machines"], houseplants: ["Houseplants", "Potted plants"],
};

const BLOCK = /\b(advert|advertising|poster|logo|icon|diagram|screenshot|drawing|illustration|cartoon|clipart|painting|sketch|patent|museum|exhibit|antique|vintage|19[0-8]\d|18\d\d|map|chart|plan|scan|page|cover art|svg)\b/i;
const FREE = /^(cc0|public domain|pd\b|pdm|cc[- ]by(-sa)?([- ][\d.]+)?)/i;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const only = args.only ? new Set(args.only.split(",")) : null;
const PER = Number(args.per ?? 8);
const rejected = new Set(existsSync(REJECT) ? JSON.parse(readFileSync(REJECT, "utf8")) : []);
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
mkdirSync(IMG_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function api(params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}?${new URLSearchParams({ format: "json", ...params })}`, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (res.ok && text.startsWith("{")) return JSON.parse(text);
    console.log(`  Commons busy (HTTP ${res.status}), waiting ${15 * (attempt + 1)}s`);
    await sleep(15_000 * (attempt + 1));
  }
  throw new Error("Commons kept refusing requests; re-run later (finished types are saved)");
}

// Image download that backs off when Wikimedia says "too many requests"
async function download(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return res;
    if (res.status !== 429) throw new Error(`HTTP ${res.status}`);
    const wait = Number(res.headers.get("retry-after")) || 10 * (attempt + 1);
    console.log(`  rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error("still rate limited");
}

// Files in a category with license info and a 960px thumbnail
async function categoryFiles(cat) {
  const d = await api({
    action: "query", generator: "categorymembers", gcmtitle: `Category:${cat}`, gcmtype: "file", gcmlimit: "100",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "960", // a standard Wikimedia thumbnail size: already rendered, so not throttled like custom sizes
  });
  return Object.values(d.query?.pages ?? {}).map((p) => ({ ...p.imageinfo?.[0], title: p.title, pageid: p.pageid }));
}

function usable(f) {
  const meta = f.extmetadata ?? {};
  const license = meta.LicenseShortName?.value ?? "";
  const ratio = f.width / f.height;
  return (
    /^image\/(jpeg|png|webp)$/.test(f.mime ?? "") &&
    f.width >= 600 && f.height >= 450 && ratio > 0.6 && ratio < 1.9 &&
    FREE.test(license) && !/\b(nc|nd)\b/i.test(license) &&
    !/personality/i.test(meta.Restrictions?.value ?? "") && // skip photos flagged as showing identifiable people
    !BLOCK.test(f.title) && !rejected.has(`commons:${f.pageid}`)
  );
}

const keys = Object.keys(CATEGORIES).filter((k) => !only || only.has(k));
const usedIds = new Set(Object.values(manifest).flat().map((p) => p.id)); // shared categories split across types
const cache = new Map();
let added = 0;

for (const key of keys) {
  const photos = [...(manifest[key] ?? [])];
  const before = photos.filter((p) => p.source === "wikimedia").length;
  let fresh = before; // --per is the Commons total per type, so re-runs only fill gaps
  for (const cat of CATEGORIES[key]) {
    if (fresh >= PER) break;
    if (!cache.has(cat)) {
      await sleep(1500);
      cache.set(cat, await categoryFiles(cat));
    }
    for (const f of cache.get(cat).filter(usable)) {
      if (fresh >= PER) break;
      const id = `commons:${f.pageid}`;
      if (usedIds.has(id)) continue;
      try {
        const res = await download(f.thumburl ?? f.url);
        const file = `${key}-c${f.pageid}.webp`;
        await sharp(Buffer.from(await res.arrayBuffer())).rotate().resize(640, 640, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toFile(join(IMG_DIR, file));
        const meta = f.extmetadata ?? {};
        usedIds.add(id);
        photos.push({
          src: `/items/${file}`,
          id,
          title: strip(meta.ObjectName?.value) || f.title.replace(/^File:|\.\w+$/g, ""),
          creator: strip(meta.Artist?.value) || "Unknown",
          creator_url: null,
          license: (meta.LicenseShortName?.value ?? "").toLowerCase().replace(/^cc[- ]/, "").replace(/[- ][\d.]+$/, "") || "unknown",
          license_version: (meta.LicenseShortName?.value ?? "").match(/[\d.]+$/)?.[0] ?? null,
          license_url: meta.LicenseUrl?.value ?? null,
          landing: f.descriptionurl ?? null,
          source: "wikimedia",
          reviewed: false,
        });
        fresh++;
        added++;
        await sleep(1200); // upload.wikimedia.org rate-limits fast downloads
      } catch (e) {
        console.log(`  - skipped ${f.title}: ${e.message}`);
      }
    }
  }
  manifest[key] = photos;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1)); // save as we go
  console.log(`${key}: +${fresh - before}`);
}
console.log(`\nAdded ${added} photos (unreviewed).`);
