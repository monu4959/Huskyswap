// pgvector literal: '[0.1,0.2,...]'. Kept apart from embed.ts so modules that
// only read or write vectors don't load the embedding model's runtime.
export const toVector = (v: number[]) => `[${v.join(",")}]`;
