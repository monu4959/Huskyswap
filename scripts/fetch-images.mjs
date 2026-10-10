// Downloads openly licensed product photos from Openverse (openverse.org) for
// each photo key in scripts/catalog.mjs. Only licenses that allow reuse and
// modification (CC0, Public Domain Mark, CC BY, CC BY-SA). Nothing is taken
// from marketplaces or social networks.
//
//   node scripts/fetch-images.mjs                 # item types never fetched
//   node scripts/fetch-images.mjs --only=tent,fan # top up specific types (keeps existing)
//
// Output:
//   public/items/<key>-<n>.webp   resized to 640 px on the long side
//   src/data/photos.json          key -> [{ src, title, creator, license, ... }]
// Reject a bad photo by adding its Openverse id to scripts/photo-reject.json and
// re-running with --only=<key>.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { photoQueries } from "./catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMG_DIR = join(ROOT, "public", "items");
const MANIFEST = join(ROOT, "src", "data", "photos.json");
const REJECT = join(ROOT, "scripts", "photo-reject.json");
const PER_KEY = 4;
const API = "https://api.openverse.org/v1/images/";
const UA = "HuskySwap-demo/0.1 (student project; image fetcher)";

// Titles that usually mean an ad, an artwork, or a museum piece rather than the item
const BLOCK = /\b(advert|advertising|ad for|poster|logo|icon|diagram|screenshot|drawing|illustration|cartoon|clipart|painting|sketch|museum|exhibit|vintage|antique|circa|19[0-8]\d|toy|lego|miniature|moldy|broken|trash|dumpster|abandoned|circus|patent)\b/i;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const only = args.only ? new Set(args.only.split(",")) : null;
const rejected = new Set(existsSync(REJECT) ? JSON.parse(readFileSync(REJECT, "utf8")) : []);
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
mkdirSync(IMG_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q, page) {
  const params = new URLSearchParams({ q, page: String(page), page_size: "20", license_type: "commercial,modification", mature: "false" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 60);
      console.log(`  rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`search ${q}: HTTP ${res.status} ${await res.text()}`);
    const left = res.headers.get("x-ratelimit-available-anon_sustained");
    if (left !== null && Number(left) < 5) throw new Error(`Daily Openverse limit nearly used (${left} left). Re-run tomorrow; finished keys are kept.`);
    return (await res.json()).results ?? [];
  }
  throw new Error(`search ${q}: still rate limited`);
}

function relevant(r, q) {
  const text = `${r.title ?? ""} ${(r.tags ?? []).map((t) => t.name).join(" ")}`.toLowerCase();
  const ratio = r.width && r.height ? r.width / r.height : 1;
  return (
    q.toLowerCase().split(" ").every((w) => text.includes(w.replace(/s$/, ""))) &&
    !BLOCK.test(r.title ?? "") &&
    !rejected.has(r.id) &&
    (r.width ?? 0) >= 480 &&
    (r.height ?? 0) >= 360 &&
    ratio > 0.6 &&
    ratio < 1.9
  );
}

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const queries = photoQueries();
let searches = 0;
for (const [key, q] of queries) {
  // Default: only item types never fetched. --only: top up those types.
  // Existing (hand-reviewed) photos are never deleted or renamed.
  if (only ? !only.has(key) : key in manifest) continue;
  console.log(`${key}  ("${q}")`);

  const photos = [...(manifest[key] ?? [])];
  const seenIds = new Set(photos.map((p) => p.id));
  const seenCreators = new Set(photos.map((p) => p.creator));
  for (let page = 1; page <= 2 && photos.length < PER_KEY; page++) {
    if (searches++) await sleep(3300); // stay under 20 searches a minute
    const results = await search(q, page);
    for (const r of results.filter((r) => relevant(r, q))) {
      if (photos.length >= PER_KEY) break;
      if (seenIds.has(r.id) || seenCreators.has(r.creator)) continue; // variety: one photo per photographer
      try {
        const buf = await download(r.url);
        const file = `${key}-${r.id.slice(0, 8)}.webp`;
        await sharp(buf).rotate().resize(640, 640, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toFile(join(IMG_DIR, file));
        seenCreators.add(r.creator);
        photos.push({
          src: `/items/${file}`,
          id: r.id,
          title: r.title || q,
          creator: r.creator || "Unknown",
          creator_url: r.creator_url ?? null,
          license: r.license,
          license_version: r.license_version ?? null,
          license_url: r.license_url ?? null,
          landing: r.foreign_landing_url ?? null,
          source: r.source,
          reviewed: false, // the app skips photos until someone checks them
        });
        console.log(`  + ${file}  ${r.license} ${r.license_version ?? ""}  "${(r.title ?? "").slice(0, 50)}"`);
      } catch (e) {
        console.log(`  - skipped ${r.id}: ${e.message}`);
      }
    }
  }
  manifest[key] = photos;
  if (photos.length < PER_KEY) console.log(`  only found ${photos.length}`);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1)); // save as we go
}

const total = Object.values(manifest).reduce((n, p) => n + p.length, 0);
const empty = [...queries.keys()].filter((k) => !manifest[k]?.length);
console.log(`\n${total} photos across ${Object.keys(manifest).length} keys. Searches this run: ${searches}.`);
if (empty.length) console.log(`No photos for: ${empty.join(", ")}`);
