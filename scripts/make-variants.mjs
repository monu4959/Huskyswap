// Makes 3 edited versions of every reviewed photo (crop, mirror, slight color
// change) so listings repeat the same picture less often. All source photos are
// under licenses that allow modification; variants are flagged `modified` so the
// credit line says the photo was edited (CC BY / BY-SA require noting changes).
//
//   node scripts/make-variants.mjs
//
// Safe to re-run: existing variants are skipped.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "src", "data", "photos.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// Each recipe: crop window (fractions of the original) plus adjustments
const RECIPES = [
  { name: "v1", crop: { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }, flop: true, modulate: { brightness: 1.0, saturation: 1.0 } },
  { name: "v2", crop: { x: 0.0, y: 0.0, w: 0.8, h: 0.8 }, flop: false, modulate: { brightness: 1.06, saturation: 1.12 } },
  { name: "v3", crop: { x: 0.2, y: 0.18, w: 0.8, h: 0.82 }, flop: true, modulate: { brightness: 0.95, saturation: 0.9, hue: 8 } },
];

let made = 0;
for (const [key, list] of Object.entries(manifest)) {
  const originals = list.filter((p) => p.reviewed && !p.variant_of);
  const out = list.filter((p) => !p.variant_of || originals.some((o) => o.src === p.variant_of));
  for (const p of originals) {
    for (const r of RECIPES) {
      const src = p.src.replace(/\.webp$/, `-${r.name}.webp`);
      if (out.some((x) => x.src === src)) continue;
      const input = join(ROOT, "public", p.src);
      if (!existsSync(input)) continue;
      const img = sharp(input);
      const { width, height } = await img.metadata();
      const left = Math.round(width * r.crop.x);
      const top = Math.round(height * r.crop.y);
      let pipeline = img.extract({
        left,
        top,
        width: Math.min(Math.round(width * r.crop.w), width - left), // rounding must not pass the edge
        height: Math.min(Math.round(height * r.crop.h), height - top),
      });
      if (r.flop) pipeline = pipeline.flop();
      await pipeline.modulate(r.modulate).webp({ quality: 72 }).toFile(join(ROOT, "public", src));
      out.push({ ...p, src, variant_of: p.src, modified: true });
      made++;
    }
  }
  manifest[key] = out;
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
const total = Object.values(manifest).flat().filter((p) => p.reviewed).length;
console.log(`Made ${made} variants. Reviewed photos available: ${total}.`);
