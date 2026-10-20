// Semantic cache (graph node 1): a resolved question -> the SQL that answered it.
//
// A hit needs embedding similarity >= CACHE_SIMILARITY *and* the same "slots":
// numbers, polarity words (cheapest / most expensive, not, average...), time
// words, and mostly the same key terms. Embeddings alone confuse near-misses:
// "cheapest bike" vs "most expensive bike" score 0.92 with gte-small.
//
// On a hit the stored SQL is run again (fresh data); the stored answer text is
// reused only if the result is unchanged. Entries are scoped by role, and by
// student when the SQL reads my_* views. Questions about "today", "this week"
// and the like expire at the next Boston midnight.

import { createHash } from "node:crypto";
import { toVector } from "./vector.ts";
import { opsPool } from "./ops-db.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import { SCHEMA_HASH } from "./schema-card.ts";
import { SEMANTIC_VERSION } from "./semantic-layer.ts";
import type { DbRole, SqlResult } from "./types.ts";

export const CACHE_VERSION = `${PROMPT_VERSION}-${SCHEMA_HASH}-${SEMANTIC_VERSION}`;
export const CACHE_SIMILARITY = 0.95;

const POLARITY: Record<string, string> = {
  cheapest: "min", lowest: "min", least: "min", fewest: "min", min: "min", minimum: "min", smallest: "min", bottom: "min", worst: "min",
  most: "max", highest: "max", max: "max", maximum: "max", expensive: "max", priciest: "max", biggest: "max", largest: "max", top: "max", best: "max",
  not: "not", no: "not", never: "not", without: "not", except: "not", excluding: "not", "n't": "not",
  average: "avg", avg: "avg", mean: "avg", median: "median", total: "sum", sum: "sum",
  many: "count", count: "count", number: "count", percent: "pct", percentage: "pct", share: "pct", rate: "pct",
  before: "before", until: "before", after: "after", since: "after",
  more: "more", over: "more", above: "more", less: "less", fewer: "less", under: "less", below: "less",
};
const TIME = new Set(
  "today yesterday tomorrow now currently rn week weekend month year semester term spring summer fall autumn winter finals move-in move-out break holiday last this next past previous recent recently jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" "),
);
const RELATIVE = /\b(today|yesterday|tomorrow|now|currently|rn|right now|this|last|past|previous|recent|recently|next|current)\b/i;
const STOP = new Set("the a an and or of for to in on at by with from is are was were be how what which who when where any all some show me my i we do does did can could have has had get got per vs than as it its this that there their them".split(" "));

type Slots = { numbers: string[]; polarity: string[]; time: string[]; terms: string[] };

// Crude English stemming, enough to equate "listed" / "listings" / "list" and "bikes" / "bike"
function stem(w: string) {
  if (w.length > 5 && w.endsWith("ings")) return w.slice(0, -4);
  if (w.length > 4 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function slotsOf(question: string): Slots {
  const q = question.toLowerCase().replace(/n't\b/g, " n't");
  const words = q.split(/[^a-z0-9'-]+/).filter(Boolean);
  const numbers = (q.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).map(String);
  const polarity = words.map((w) => POLARITY[w]).filter(Boolean);
  const time = words.filter((w) => TIME.has(w));
  const terms = words.filter((w) => w.length >= 3 && !STOP.has(w) && !POLARITY[w] && !TIME.has(w) && !/^\d/.test(w)).map(stem);
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return { numbers: uniq(numbers), polarity: uniq(polarity), time: uniq(time), terms: uniq(terms) };
}

function compatible(a: Slots, b: Slots) {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  const union = new Set([...a.terms, ...b.terms]);
  const shared = a.terms.filter((t) => b.terms.includes(t)).length;
  return same(a.numbers, b.numbers) && same(a.polarity, b.polarity) && same(a.time, b.time) && (union.size === 0 || shared / union.size >= 0.5);
}

export function resultHash(result: SqlResult) {
  return createHash("sha256").update(JSON.stringify(result.ok ? [result.columns, result.rows] : result.error)).digest("hex").slice(0, 16);
}

const PERSONAL = /\bmy_(listings|deals|saved_items|reviews)\b/;

export type CacheHit = { cacheId: number; question: string; sql: string; answer: string; resultHash: string; similarity: number };

export async function cacheLookup(question: string, vector: number[], role: DbRole, userId: string | null): Promise<CacheHit | null> {
  const { rows } = await opsPool().query(
    `select cache_id, question, slots, sql, answer, result_hash,
            1 - (embedding operator(extensions.<=>) $1::extensions.vector) as similarity
     from ops.query_cache
     where db_role = $2 and cache_version = $3
       and (user_id is null or user_id = $4::uuid)
       and (valid_until is null or valid_until > now())
     order by embedding operator(extensions.<=>) $1::extensions.vector
     limit 5`,
    [toVector(vector), role, CACHE_VERSION, userId],
  );
  const slots = slotsOf(question);
  const row = rows.find((r) => r.similarity >= CACHE_SIMILARITY && compatible(slots, r.slots));
  if (!row) return null;
  await opsPool().query("update ops.query_cache set hits = hits + 1, last_hit_at = now() where cache_id = $1", [row.cache_id]);
  return { cacheId: row.cache_id, question: row.question, sql: row.sql, answer: row.answer, resultHash: row.result_hash, similarity: row.similarity };
}

export async function cacheStore(entry: {
  question: string;
  vector: number[];
  role: DbRole;
  userId: string | null;
  sql: string;
  answer: string;
  result: SqlResult;
  runId: string | null;
}) {
  // SQL over my_* views is only ever reused for the same student
  const personal = PERSONAL.test(entry.sql);
  if (personal && !entry.userId) return;
  await opsPool().query(
    `insert into ops.query_cache (db_role, user_id, question, slots, sql, answer, result_hash, valid_until, run_id, cache_version, embedding)
     values ($1, $2, $3, $4, $5, $6, $7,
             case when $8 then ((now() at time zone 'America/New_York')::date + 1)::timestamp at time zone 'America/New_York' end,
             $9, $10, $11::extensions.vector)`,
    [
      entry.role, personal ? entry.userId : null, entry.question, JSON.stringify(slotsOf(entry.question)), entry.sql, entry.answer,
      resultHash(entry.result), RELATIVE.test(entry.question), entry.runId, CACHE_VERSION, toVector(entry.vector),
    ],
  );
}

// A thumbs-down removes whatever that run put in the cache
export async function cacheForgetRun(runId: string) {
  await opsPool().query("delete from ops.query_cache where run_id = $1", [runId]);
}
