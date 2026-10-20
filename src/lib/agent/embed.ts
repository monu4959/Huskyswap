// Text embeddings for the retrieval index and the semantic cache: gte-small
// (384 dimensions), run locally with transformers.js. Free, no API key; the
// model (~35 MB) downloads once into .cache/models (/tmp on Vercel).

import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "Supabase/gte-small";
export const EMBED_DIMS = 384;

env.cacheDir = process.env.EMBED_CACHE_DIR ?? (process.env.VERCEL ? "/tmp/models" : ".cache/models");

let extractor: Promise<FeatureExtractionPipeline> | null = null;

export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  extractor ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
  const output = await (await extractor)(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

export { toVector } from "./vector.ts";
